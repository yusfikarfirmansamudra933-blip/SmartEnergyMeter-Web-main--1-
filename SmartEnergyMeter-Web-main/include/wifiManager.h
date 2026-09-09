#ifndef WIFI_MANAGER_H
#define WIFI_MANAGER_H

#include <Arduino.h>

void wifiBegin();

void wifiLoop();

bool wifiConnected();

String getIPAddress();

int wifiRSSI();

String wifiSSID();

// Stable per-device identifier used to namespace MQTT topics
// (smartmeter/<id>/...) so multiple physical units don't collide on the
// same broker. Defaults to the last 3 bytes of the chip's MAC address
// (unique per ESP32, no setup needed); override with DEVICE_ID in
// config.local.h to match an id already registered on the web dashboard
// (see web-remote/devices.html) — Phase 3 will assign this automatically
// via the OLED pairing flow instead of a manual override.
String getDeviceId();

#endif