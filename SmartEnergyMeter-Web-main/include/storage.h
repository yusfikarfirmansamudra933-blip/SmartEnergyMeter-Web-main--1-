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

// Whether this device has been claimed on the web dashboard (see
// web-remote/devices.html) yet. Defaults to false (not paired) when the
// key has never been set, so a genuinely new unit shows the pairing screen
// on its very first boot with no extra step — resetConfig() (factory
// reset) puts an already-paired device back into that same state.
bool isPaired();

void markPaired();

// WiFi credentials saved by the captive portal (see wifiProvision.cpp),
// stored in NVS instead of compiled into the firmware — this is what lets
// the exact same firmware.bin go on every unit. Empty string means "none
// saved yet"; wifiManager.cpp's wifiBegin() falls back to the compiled
// WIFI_SSID/WIFI_PASSWORD (config.local.h) if both this and that are
// empty, for units built the old way before this existed.
bool hasStoredWifiCredentials();

String getStoredWifiSsid();

String getStoredWifiPassword();

void saveWifiCredentials(const String &ssid, const String &password);

#endif