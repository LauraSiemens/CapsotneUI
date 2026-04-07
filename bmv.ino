/***************************************************************************
BME680 + BMV080 + ESP32 Bluetooth Serial
***************************************************************************/

#include <Wire.h>
#include <SPI.h>
#include <cmath>
#include <Adafruit_Sensor.h>
#include "Adafruit_BME680.h"
#include "SparkFun_BMV080_Arduino_Library.h"
#include "BluetoothSerial.h"

#if !defined(CONFIG_BT_ENABLED) || !defined(CONFIG_BLUEDROID_ENABLED)
#error Bluetooth is not enabled! Enable it in menuconfig
#endif

BluetoothSerial SerialBT;

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

static void printSensorCsv(Stream &out, float pm1, float pm25, float pm10,
                           float temperature, float humidity, float gas, float pressure_hpa)
{
    out.print(pm1);
    out.print(',');
    out.print(pm25);
    out.print(',');
    out.print(pm10);
    out.print(',');
    out.print(temperature);
    out.print(',');
    out.print(humidity);
    out.print(',');
    out.print(gas);
    out.print(',');
    out.println(pressure_hpa);
}

void setup()
{
    Serial.begin(115200);
    delay(1000);
    Serial.println("Booting...");

    SerialBT.begin("ESP32test");
    Serial.println("Bluetooth started: ESP32test");

    i2cBus.begin();

    if (!bmv080.begin(BMV080_ADDR, i2cBus))
    {
        Serial.println("BMV080 not found");
        SerialBT.println("BMV080 not found");
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
        SerialBT.println("BME680 not found");
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

    Serial.println("Setup complete");
    const char *csvHeader = "PM1, PM2.5, PM10, Temp, Humidity, GasAdjPct, Pressure";
    Serial.println(csvHeader);
    SerialBT.println(csvHeader);
}

void loop()
{
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

    printSensorCsv(Serial, pm1, pm25, pm10, temperature, humidity, gasAdjPct, pressure);
    printSensorCsv(SerialBT, pm1, pm25, pm10, temperature, humidity, gasAdjPct, pressure);

    while (SerialBT.available())
    {
        Serial.write(SerialBT.read());
    }

    delay(1000);
}
