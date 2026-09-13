#include "dhtSensor.h"

#include <Arduino.h>
#include <DHT.h>

#include "config.h"
#include "globals.h"

namespace {
DHT dht(DHT_PIN, DHT22);

// A single bad read (timing glitch on the one-wire bus) shouldn't flip the
// dashboard to "offline" — only report the sensor as gone after several
// consecutive failures in a row, same pattern as pzem.cpp.
constexpr uint8_t OFFLINE_AFTER_CONSECUTIVE_FAILURES = 4;
uint8_t consecutiveFailures = 0;
}  // namespace

//======================================================

void dhtSensorBegin()
{
    dht.begin();
}

//======================================================

void readDHTSensor()
{
    float h = dht.readHumidity();
    float t = dht.readTemperature();

    if (isnan(h) || isnan(t))
    {
        if (consecutiveFailures < 255)
        {
            consecutiveFailures++;
        }
        if (consecutiveFailures >= OFFLINE_AFTER_CONSECUTIVE_FAILURES)
        {
            dhtOnline = false;
        }
        return;
    }

    consecutiveFailures = 0;
    dhtOnline = true;

    temperature = t;
    humidity = h;
}
