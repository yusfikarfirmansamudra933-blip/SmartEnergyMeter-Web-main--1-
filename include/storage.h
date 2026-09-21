#ifndef STORAGE_H
#define STORAGE_H

#include <Arduino.h>

void storageBegin();

void loadConfig();

void saveConfig();

void resetConfig();

void saveLimit(float value);

// Survives a reboot (stored in NVS via Preferences) so the OTA rollback
// check in main.cpp's setup() can tell "just flashed, unverified" apart
// from every other boot — including a boot after rollBack() itself, since
// that's cleared before the rollback restart happens.
bool isOtaPendingVerify();

void markOtaPendingVerify();

void clearOtaPendingVerify();

// WiFi credentials entered through the setup portal (wifiProvision.cpp) take
// priority over the compiled WIFI_SSID/WIFI_PASSWORD in config.local.h — see
// wifiManager.cpp. resetConfig() above already wipes these along with
// everything else in NVS, so a factory reset also clears saved WiFi.
bool hasStoredWifiCredentials();

String getStoredWifiSsid();

String getStoredWifiPassword();

void saveWifiCredentials(const String &ssid, const String &password);

#endif