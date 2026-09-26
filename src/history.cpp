#include "history.h"

#include <Arduino.h>
#include <math.h>
#include <time.h>

#include "globals.h"
#include "mqtt.h"

namespace
{
constexpr uint8_t SLOTS = 60;
constexpr unsigned long BUCKET_MS = 60000;
constexpr time_t MIN_VALID_EPOCH = 1700000000;  // clock counts as synced after ~Nov 2023

const char *TOPIC_HISTORY = "smartmeter/history";

enum Metric : uint8_t
{
    POWER,
    VOLTAGE,
    CURRENT,
    FREQUENCY,
    PF,
    CHIP,
    METRIC_COUNT
};

// Key, decimals kept when published. Order matches Metric.
const char *KEYS[METRIC_COUNT] = {"power", "voltage", "current", "frequency", "pf", "chipTemperature"};
const uint8_t DECIMALS[METRIC_COUNT] = {1, 1, 3, 2, 2, 1};

float slots[METRIC_COUNT][SLOTS];
uint8_t filled = 0;  // how many slots hold a minute (grows to SLOTS)
uint8_t head = 0;    // next slot to write

double sums[METRIC_COUNT];
uint16_t counts[METRIC_COUNT];
unsigned long bucketStart = 0;
bool started = false;

void addSample(Metric m, float value)
{
    if (isnan(value))
        return;
    sums[m] += value;
    counts[m]++;
}

void closeBucket()
{
    for (uint8_t m = 0; m < METRIC_COUNT; m++)
    {
        slots[m][head] = counts[m] ? (float)(sums[m] / counts[m]) : NAN;
        sums[m] = 0;
        counts[m] = 0;
    }
    head = (head + 1) % SLOTS;
    if (filled < SLOTS)
        filled++;
}

// {"interval":60,"end":<epoch or 0>,"power":[..],...}, oldest first, null for gaps.
String buildJson()
{
    String json;
    json.reserve(3200);

    time_t now = time(nullptr);
    json += "{\"interval\":60,\"end\":";
    json += String((unsigned long)(now >= MIN_VALID_EPOCH ? now : 0));

    const uint8_t first = (head + SLOTS - filled) % SLOTS;
    for (uint8_t m = 0; m < METRIC_COUNT; m++)
    {
        json += ",\"";
        json += KEYS[m];
        json += "\":[";
        for (uint8_t i = 0; i < filled; i++)
        {
            if (i)
                json += ',';
            const float v = slots[m][(first + i) % SLOTS];
            if (isnan(v))
                json += "null";
            else
                json += String(v, (unsigned int)DECIMALS[m]);
        }
        json += ']';
    }
    json += '}';
    return json;
}
}  // namespace

void historyAddPzemSample()
{
    if (!sensorOnline)
        return;
    addSample(POWER, power);
    addSample(VOLTAGE, voltage);
    addSample(CURRENT, current);
    addSample(FREQUENCY, frequency);
    addSample(PF, pf);
}

void historyAddChipSample()
{
    if (chipTempValid)
        addSample(CHIP, chipTemperature);
}

void historyLoop()
{
    if (!started)
    {
        started = true;
        bucketStart = millis();
        return;
    }

    if (millis() - bucketStart < BUCKET_MS)
        return;

    bucketStart += BUCKET_MS;
    closeBucket();

    // Standby promises no telemetry; the gap minutes still go out with the
    // first publish after monitoring is turned back on.
    if (!standby)
        mqttPublishRetained(TOPIC_HISTORY, buildJson());
}
