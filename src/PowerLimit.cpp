#include "PowerLimit.h"
#include "globals.h"

void checkPowerLimit()
{
    if (powerLimit > 0)
    {
        powerPercent =
            (int)((power / powerLimit) * 100.0);

        if (powerPercent < 0)
            powerPercent = 0;

        if (powerPercent > 100)
            powerPercent = 100;
    }
    else
    {
        powerPercent = 0;
    }

    if (powerLimit > 0 && power > powerLimit)
    {
        overload = true;
        overloadCount++;
    }
    else
    {
        overload = false;
    }
}