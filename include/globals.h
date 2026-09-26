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

// Remote standby (smartmeter/cmd/power): PZEM is not read, the OLED is
// switched off and no telemetry is published, but WiFi and MQTT stay up so
// the device can be turned back on from the dashboard. Not persisted, so
// every boot (including after a power cut) starts in normal mode.
extern bool standby;

// ESP32's own die temperature. chipTempValid is false until the first good
// reading (or if the sensor reads out of range), in which case
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