#include "chipTemp.h"

#include <Arduino.h>
#include "soc/sens_reg.h"
#include "soc/soc.h"

#include "globals.h"

namespace {
// temperatureRead() wraps an undocumented ROM call that powers the sensor up
// and reads it almost immediately. The sensor needs ~1ms to settle after
// power-up; with less, the value is garbage. Measured on this board
// (ESP32-D0WD-V3), raw counts by settle time: 100us -> 121, 300us -> 112,
// 1000us and up -> 104 (stable). Called every couple of seconds, the ROM
// call almost always returned raw 128 (exactly 53.33C) regardless of the
// chip's real temperature — so this does the same register sequence itself,
// with a wait long enough for the reading to be real.
constexpr uint32_t SETTLE_US = 2000;

// Consecutive reads differ by a count or two under load (each count is
// ~0.56C), so averaging a few keeps the dashboard from jittering.
constexpr uint8_t SAMPLES = 4;

uint8_t readRawOnce()
{
    SET_PERI_REG_BITS(SENS_SAR_MEAS_WAIT2_REG, SENS_FORCE_XPD_SAR, 3, SENS_FORCE_XPD_SAR_S);
    SET_PERI_REG_BITS(SENS_SAR_TSENS_CTRL_REG, SENS_TSENS_CLK_DIV, 10, SENS_TSENS_CLK_DIV_S);
    CLEAR_PERI_REG_MASK(SENS_SAR_TSENS_CTRL_REG, SENS_TSENS_POWER_UP);
    CLEAR_PERI_REG_MASK(SENS_SAR_TSENS_CTRL_REG, SENS_TSENS_DUMP_OUT);
    SET_PERI_REG_MASK(SENS_SAR_TSENS_CTRL_REG, SENS_TSENS_POWER_UP_FORCE);
    SET_PERI_REG_MASK(SENS_SAR_TSENS_CTRL_REG, SENS_TSENS_POWER_UP);
    ets_delay_us(SETTLE_US);
    SET_PERI_REG_MASK(SENS_SAR_TSENS_CTRL_REG, SENS_TSENS_DUMP_OUT);
    ets_delay_us(5);
    return GET_PERI_REG_BITS2(SENS_SAR_SLAVE_ADDR3_REG, SENS_TSENS_OUT, SENS_TSENS_OUT_S);
}
}  // namespace

void readChipTemperature()
{
    uint16_t sum = 0;
    for (uint8_t i = 0; i < SAMPLES; i++)
    {
        sum += readRawOnce();
    }

    const float raw = (float)sum / SAMPLES;

    // Same raw-to-Celsius conversion the Arduino core's temperatureRead()
    // uses. The classic ESP32's sensor isn't factory-calibrated, so trust
    // the trend (warming up / cooling down) more than the absolute number.
    const float celsius = (raw - 32.0f) / 1.8f;

    // Only guards against a dead/floating sensor reading rails (0 or 255).
    if (celsius < -10.0f || celsius > 120.0f)
    {
        chipTempValid = false;
        return;
    }

    chipTemperature = celsius;
    chipTempValid = true;
}
