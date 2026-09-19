#include "chipTemp.h"

#include <Arduino.h>
#include <math.h>

#include "globals.h"

namespace {
// The classic ESP32's internal sensor is an undocumented ROM call, and on
// some boards it returns a stuck raw value of 128 — which temperatureRead()
// converts to exactly (128 - 32) / 1.8 = 53.33C no matter how hot the chip
// is. Publishing that as a real reading would be worse than no reading, so
// a run of identical 53.33 samples is treated as "sensor gives no data".
constexpr float STUCK_VALUE_C = 53.33333f;
constexpr float STUCK_TOLERANCE_C = 0.01f;
constexpr uint8_t INVALID_AFTER_STUCK_READS = 6;

uint8_t stuckReads = 0;
}  // namespace

void readChipTemperature()
{
    const float t = temperatureRead();

    if (isnan(t) || fabsf(t - STUCK_VALUE_C) < STUCK_TOLERANCE_C)
    {
        if (stuckReads < 255)
        {
            stuckReads++;
        }
        if (stuckReads >= INVALID_AFTER_STUCK_READS)
        {
            chipTempValid = false;
        }
        return;
    }

    stuckReads = 0;
    chipTempValid = true;
    chipTemperature = t;
}
