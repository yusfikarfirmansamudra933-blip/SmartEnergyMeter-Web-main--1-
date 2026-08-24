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

extern uint32_t pzemReadCount;

extern uint32_t pzemErrorCount;

extern uint8_t signalQuality;

extern unsigned long sensorTimer;

extern unsigned long oledTimer;

extern int powerPercent;
extern uint32_t overloadCount;
#endif