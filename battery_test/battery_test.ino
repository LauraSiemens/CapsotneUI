/***************************************************************************
 * BME680 + BMV080 + ESP32 Bluetooth — optional battery % test sketch
 *
 * NOT the main dashboard firmware. Delete the battery_test/ folder when done.
 *
 * CSV per line: timestamp, PM1, PM2.5, PM10, Temp, Humidity, Gas, Pressure, Battery%
 * Open Serial Monitor @ 115200 to test. Adjust VBAT_PIN / divider for your board.
 ***************************************************************************/

#include <Wire.h>
#include <SPI.h>
#include <Adafruit_Sensor.h>
#include "Adafruit_BME680.h"
#include "SparkFun_BMV080_Arduino_Library.h"
#include "BluetoothSerial.h"

#define SEALEVELPRESSURE_HPA (1013.25)

#define BME680_ADDR 0x77
#define BMV080_ADDR 0x57

Adafruit_BME680 bme;
SparkFunBMV080 bmv080;

#if defined(ARDUINO_SPARKFUN_THINGPLUS_RP2040)
TwoWire &i2cBus = Wire1;
#else
TwoWire &i2cBus = Wire;
#endif

#if !defined(CONFIG_BT_ENABLED) || !defined(CONFIG_BLUEDROID_ENABLED)
#error Bluetooth is not enabled! Enable it in menuconfig
#endif

BluetoothSerial SerialBT;

static bool bmeOk = false;
static bool bmv080Ok = false;

// ---- Battery (ESP32 ADC) — tune for your divider and pin ----
#define VBAT_PIN 33
#define ADC_MAX 4095.0f
#define ADC_REF 3.3f
#define VOLTAGE_DIVIDER 2.0f

void setup()
{
    Serial.begin(115200);
    delay(1000);
    Serial.println("Booting...");

    SerialBT.begin("ESP32");
    Serial.println("Bluetooth started: ESP32");
    SerialBT.println("Starting Battery Monitor...");

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

    analogReadResolution(12);
    analogSetAttenuation(ADC_11db);

    Serial.println("Setup complete");
    SerialBT.println("timestamp, PM1, PM2.5, PM10, Temp, Humidity, Gas, Pressure, BatteryPct");
}

/** Map cell voltage estimate to 0–100% (rough Li-ion style curve). */
static int voltageToPercent(float voltage)
{
    int batteryPercent;
    if (voltage >= 4.2f)
        batteryPercent = 100;
    else if (voltage >= 4.0f)
        batteryPercent = (int)(85.0f + (voltage - 4.0f) * 75.0f);
    else if (voltage >= 3.8f)
        batteryPercent = (int)(60.0f + (voltage - 3.8f) * 125.0f);
    else if (voltage >= 3.6f)
        batteryPercent = (int)(30.0f + (voltage - 3.6f) * 150.0f);
    else if (voltage >= 3.3f)
        batteryPercent = (int)(10.0f + (voltage - 3.3f) * 67.0f);
    else
        batteryPercent = 0;
    return constrain(batteryPercent, 0, 100);
}

static unsigned long lastSampleMs = 0;
static unsigned long lastBmvPumpMs = 0;
static float pm1Cache = NAN;
static float pm25Cache = NAN;
static float pm10Cache = NAN;

void loop()
{
    unsigned long now = millis();

    if (bmv080Ok && (now - lastBmvPumpMs >= 100))
    {
        lastBmvPumpMs = now;
        if (bmv080.readSensor())
        {
            pm1Cache = bmv080.PM1();
            pm25Cache = bmv080.PM25();
            pm10Cache = bmv080.PM10();
        }
    }

    while (SerialBT.available())
    {
        Serial.write(SerialBT.read());
    }

    if (now - lastSampleMs < 1000)
    {
        delay(10);
        return;
    }
    lastSampleMs = now;

    float temperature = NAN;
    float humidity = NAN;
    float pressure = NAN;
    float gas = NAN;

    int raw = analogRead(VBAT_PIN);
    float batteryVoltage = (raw / ADC_MAX) * ADC_REF * VOLTAGE_DIVIDER;
    int batteryPercent = voltageToPercent(batteryVoltage);

    if (bmeOk && bme.beginReading())
    {
        if (bme.endReading())
        {
            temperature = bme.temperature;
            humidity = bme.humidity;
            pressure = bme.pressure / 100.0f;
            gas = bme.gas_resistance;
        }
    }

    float pm1 = pm1Cache;
    float pm25 = pm25Cache;
    float pm10 = pm10Cache;

    unsigned long timestamp = millis();

    String dataLine = String(timestamp) + "," +
                      String(pm1) + "," +
                      String(pm25) + "," +
                      String(pm10) + "," +
                      String(temperature) + "," +
                      String(humidity) + "," +
                      String(gas) + "," +
                      String(pressure) + "," +
                      String(batteryPercent);

    Serial.println(dataLine);
    SerialBT.println(dataLine);
}
