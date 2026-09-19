#ifndef GLOBALS_H
#define GLOBALS_H

#include <Arduino.h>

extern float voltage;
extern float current;
extern float power;
extern float energy;
extern float frequency;
extern float pf;

extern float apparentPower;
extern float reactivePower;

extern float powerLimit;

extern bool overload;

extern bool sensorOnline;

// ESP32's own die temperature. chipTempValid is false when the internal
// sensor isn't producing real readings (see chipTemp.cpp), in which case
// chipTemperature must not be shown or published.
extern float chipTemperature;
extern bool chipTempValid;

extern uint32_t pzemReadCount;

extern uint32_t pzemErrorCount;

extern uint8_t signalQuality;

extern unsigned long sensorTimer;

extern unsigned long chipTempTimer;

extern unsigned long oledTimer;

extern int powerPercent;
extern uint32_t overloadCount;
#endif