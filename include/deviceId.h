#ifndef DEVICE_ID_H
#define DEVICE_ID_H

#include <Arduino.h>

// Every unit flashed with the same firmware.bin still gets its own identity:
// "sem-" plus the last 3 bytes of the chip's factory MAC, e.g. "sem-a1b2c3".
// It is the MQTT client ID (the broker allows only one connection per ID)
// and the topic prefix, so units never overwrite each other's data.
const char *deviceId();

// "smartmeter/<deviceId>/<suffix>"
String deviceTopic(const char *suffix);

#endif
