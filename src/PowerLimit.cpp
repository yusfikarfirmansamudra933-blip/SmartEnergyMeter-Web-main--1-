#include "PowerLimit.h"
#include "globals.h"

void checkPowerLimit()
{
    overload = powerLimit > 0 && power > powerLimit;
}