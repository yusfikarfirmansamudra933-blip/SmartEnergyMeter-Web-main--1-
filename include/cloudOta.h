#ifndef CLOUD_OTA_H
#define CLOUD_OTA_H

#include <Arduino.h>

// Firmware updates from the cloud, so units already in customers' homes can
// be updated without a cable or the local network. The device reads
// OTA_BASE_URL/latest.json every few hours and installs a newer version.
// The .bin there is encrypted and signed with OTA_KEY (it contains the WiFi
// and MQTT credentials from config.local.h, and the folder is public), so a
// file not made by web-remote/scripts/release-firmware.js is never flashed.
//
// Progress is reported retained on smartmeter/<id>/ota:
//   {"state":"current|downloading|updated|failed","version":"1.17.0","error":"..."}

void cloudOtaBegin();

void cloudOtaLoop();

// From smartmeter/<id>/cmd/update: check right away, and retry a version
// that rolled back before.
void cloudOtaRequestCheck();

#endif
