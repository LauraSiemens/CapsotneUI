/***************************************************************************
BME680 + BMV080 + ESP32 USB serial + optional WiFi (WebSocket CSV)
Bluetooth Classic disabled at build — saves RAM for reliable WiFi.
***************************************************************************/

#include <Wire.h>
#include <SPI.h>
#include <WiFi.h>
#include <WebSocketsServer.h>
#include <cstdio>
#include <cstring>
#include <cmath>
#include <Adafruit_Sensor.h>
#include "Adafruit_BME680.h"
#include "SparkFun_BMV080_Arduino_Library.h"

#if __has_include("wifi_secrets.h")
#include "wifi_secrets.h"
#endif
#ifndef WIFI_SSID
#define WIFI_SSID ""
#endif
#ifndef WIFI_PASSWORD
#define WIFI_PASSWORD ""
#endif
#ifndef WIFI_WEBSOCKET_PORT
#define WIFI_WEBSOCKET_PORT 8766
#endif

#define SEALEVELPRESSURE_HPA (1013.25)

// I2C addresses
#define BME680_ADDR 0x77
#define BMV080_ADDR 0x57

Adafruit_BME680 bme;   // BME680 over I2C
SparkFunBMV080 bmv080; // BMV080 over I2C

#if defined(ARDUINO_SPARKFUN_THINGPLUS_RP2040)
TwoWire &i2cBus = Wire1;
#else
TwoWire &i2cBus = Wire;
#endif

static bool bmeOk = false;
static bool bmv080Ok = false;

static WebSocketsServer webSocket(WIFI_WEBSOCKET_PORT);
static bool webSocketStarted = false;

// Battery (ESP32 ADC) — GPIO 33 typical; tune divider for your board
#define VBAT_PIN 33
#define ADC_MAX 4095.0f
#define ADC_REF 3.3f
#define VOLTAGE_DIVIDER 2.0f

static int voltageToBatteryPercent(float voltage)
{
    int p;
    if (voltage >= 4.2f)
        p = 100;
    else if (voltage >= 4.0f)
        p = (int)(85.0f + (voltage - 4.0f) * 75.0f);
    else if (voltage >= 3.8f)
        p = (int)(60.0f + (voltage - 3.8f) * 125.0f);
    else if (voltage >= 3.6f)
        p = (int)(30.0f + (voltage - 3.6f) * 150.0f);
    else if (voltage >= 3.3f)
        p = (int)(10.0f + (voltage - 3.3f) * 67.0f);
    else
        p = 0;
    if (p < 0)
        p = 0;
    if (p > 100)
        p = 100;
    return p;
}

/** Running min/max for blog-style gas vs humidity scaling (BME680Processor). */
static float gHistMin = NAN;
static float gHistMax = NAN;
static float hHistMin = NAN;
static float hHistMax = NAN;

static void updateGasHumidityRanges(float gasOhm, float humPct)
{
    if (!std::isfinite(gasOhm) || !std::isfinite(humPct))
        return;
    if (!std::isfinite(gHistMin))
    {
        gHistMin = gHistMax = gasOhm;
        hHistMin = hHistMax = humPct;
        return;
    }
    if (gasOhm < gHistMin)
        gHistMin = gasOhm;
    if (gasOhm > gHistMax)
        gHistMax = gasOhm;
    if (humPct < hHistMin)
        hHistMin = humPct;
    if (humPct > hHistMax)
        hHistMax = humPct;
}

static float gasHumidityAdjustedPercent(float gasOhm, float humPct)
{
    if (!std::isfinite(gasOhm) || !std::isfinite(humPct))
        return NAN;
    if (!std::isfinite(gHistMin))
        return NAN;
    const float gSpan = gHistMax - gHistMin;
    const float hSpan = hHistMax - hHistMin;
    const float eps = 1e-3f;
    if (gSpan <= eps || hSpan <= eps)
        return NAN;

    const float r = hSpan / gSpan;
    float g = (-gasOhm) + gHistMax;
    g = g * r + hHistMin;
    if (g < humPct)
        g = humPct;
    if (g <= eps)
        return 0.0f;
    float pct = ((g - humPct) / g) * 100.0f;
    if (!std::isfinite(pct))
        return NAN;
    if (pct < 0.0f)
        pct = 0.0f;
    if (pct > 100.0f)
        pct = 100.0f;
    return pct;
}

/** One CSV row (no newline) for Serial / WebSocket */
static size_t sensorCsvToBuffer(char *buf, size_t cap, float pm1, float pm25, float pm10,
                                float temperature, float humidity, float gas, float pressure_hpa,
                                int battery_pct)
{
    int n = snprintf(buf, cap, "%.6g,%.6g,%.6g,%.6g,%.6g,%.6g,%.6g,%d", (double)pm1,
                     (double)pm25, (double)pm10, (double)temperature, (double)humidity,
                     (double)gas, (double)pressure_hpa, battery_pct);
    if (n < 0)
        return 0;
    if ((size_t)n >= cap)
        return cap > 0 ? cap - 1 : 0;
    return (size_t)n;
}

static void webSocketEvent(uint8_t num, WStype_t type, uint8_t *payload, size_t length)
{
    (void)payload;
    (void)length;
    switch (type)
    {
    case WStype_CONNECTED:
        Serial.printf("[WS] client #%u connected\n", num);
        break;
    case WStype_DISCONNECTED:
        Serial.printf("[WS] client #%u disconnected\n", num);
        break;
    default:
        break;
    }
}

static void tryStartWifiAndWebSocket()
{
    if (strlen(WIFI_SSID) == 0)
    {
        Serial.println("WiFi: skipped (create wifi_secrets.h from wifi_secrets.example.h)");
        return;
    }

    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    Serial.print("WiFi connecting");
    int tries = 0;
    while (WiFi.status() != WL_CONNECTED && tries < 40)
    {
        delay(500);
        Serial.print('.');
        tries++;
    }
    Serial.println();
    if (WiFi.status() != WL_CONNECTED)
    {
        Serial.println("WiFi: connect failed — check SSID/password / 2.4 GHz in wifi_secrets.h");
        WiFi.mode(WIFI_OFF);
        return;
    }

    Serial.print("WiFi OK IP ");
    Serial.println(WiFi.localIP());
    Serial.printf("WebSocket: ws://%s:%d (same CSV as USB)\n", WiFi.localIP().toString().c_str(),
                  WIFI_WEBSOCKET_PORT);

    webSocket.begin();
    webSocket.onEvent(webSocketEvent);
    webSocketStarted = true;
}

void setup()
{
    Serial.begin(115200);
    delay(1000);
    Serial.println("Booting...");

    /* WiFi before I2C/sensors so the stack gets RAM before heap fragments */
    tryStartWifiAndWebSocket();

    i2cBus.begin();

    if (!bmv080.begin(BMV080_ADDR, i2cBus))
    {
        Serial.println("BMV080 not found");
    }
    else
    {
        bmv080.init();
        bmv080.setMode(SF_BMV080_MODE_CONTINUOUS);
        bmv080Ok = true;
        Serial.println("BMV080 OK");
    }

    if (!bme.begin(BME680_ADDR, &i2cBus))
    {
        Serial.println("BME680 not found");
    }
    else
    {
        bme.setTemperatureOversampling(BME680_OS_8X);
        bme.setHumidityOversampling(BME680_OS_2X);
        bme.setPressureOversampling(BME680_OS_4X);
        bme.setIIRFilterSize(BME680_FILTER_SIZE_3);
        bme.setGasHeater(320, 150);
        bmeOk = true;
        Serial.println("BME680 OK");
    }

    analogReadResolution(12);
    analogSetAttenuation(ADC_11db);

    Serial.println("Setup complete");
    const char *csvHeader =
        "PM1, PM2.5, PM10, Temp, Humidity, GasAdjPct, Pressure, BatteryPct";
    Serial.println(csvHeader);
    if (webSocketStarted)
        webSocket.broadcastTXT(csvHeader, strlen(csvHeader));
}

static unsigned long lastSampleMs = 0;

void loop()
{
    if (webSocketStarted)
        webSocket.loop();

    unsigned long now = millis();
    if (now - lastSampleMs < 1000)
        return;
    lastSampleMs = now;

    float temperature = NAN;
    float humidity = NAN;
    float pressure = NAN;
    float gasRaw = NAN;
    float gasAdjPct = NAN;

    if (bmeOk && bme.beginReading())
    {
        if (bme.endReading())
        {
            temperature = bme.temperature;
            humidity = bme.humidity;
            pressure = bme.pressure / 100.0;
            gasRaw = bme.gas_resistance;
            if (std::isfinite(gasRaw) && std::isfinite(humidity))
            {
                updateGasHumidityRanges(gasRaw, humidity);
                gasAdjPct = gasHumidityAdjustedPercent(gasRaw, humidity);
            }
        }
    }

    float pm1 = NAN;
    float pm25 = NAN;
    float pm10 = NAN;

    if (bmv080Ok && bmv080.readSensor())
    {
        pm1 = bmv080.PM1();
        pm25 = bmv080.PM25();
        pm10 = bmv080.PM10();
    }

    int rawBat = analogRead(VBAT_PIN);
    float vbat = (rawBat / ADC_MAX) * ADC_REF * VOLTAGE_DIVIDER;
    int batteryPct = voltageToBatteryPercent(vbat);

    char lineBuf[192];
    size_t n = sensorCsvToBuffer(lineBuf, sizeof(lineBuf), pm1, pm25, pm10, temperature, humidity,
                                 gasAdjPct, pressure, batteryPct);
    if (n == 0)
        return;

    Serial.print(lineBuf);
    Serial.println();
    if (webSocketStarted)
        webSocket.broadcastTXT(lineBuf, n);
}
