#pragma once

#if __has_include("config.local.h")
#include "config.local.h"
#endif

/*==============================
        PROJECT
==============================*/

#define PROJECT_NAME "Smart Energy Meter"

// Bumped manually on each release so /api/status and the OTA panel can show
// which build is currently running (useful to confirm an update took effect).
#define FIRMWARE_VERSION "1.17.0"

// Update dari cloud (src/cloudOta.cpp): latest.json dan file firmware
// terenkripsi diambil dari folder ini, yang diisi web-remote/scripts/release-firmware.js.
#define OTA_BASE_URL "https://web-remote-nine.vercel.app/firmware/"

// Kunci enkripsi dan tanda tangan firmware, ditulis ke config.local.h oleh
// "node scripts/release-firmware.js --new-key". Kosong = update dari cloud
// mati; update lewat jaringan lokal (/update) tetap jalan.
#ifndef OTA_KEY
#define OTA_KEY ""
#endif

// Tarif awal (Rp per kWh, R-1 1.300 VA) untuk halaman Tagihan di OLED, dipakai
// sampai golongan alat diatur dari dashboard atau bot (smartmeter/<id>/billing/tariff).
#define ELECTRICITY_RATE 1444.70f

/*==============================
        OLED
==============================*/

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 32

#define OLED_ADDRESS 0x3C

/*==============================
        PZEM
==============================*/

#define PZEM_RX 16
#define PZEM_TX 17

/*==============================
        UPDATE
==============================*/

#define SENSOR_INTERVAL 500

#define OLED_INTERVAL 15000

/*==============================
        LIMIT
==============================*/

#define DEFAULT_POWER_LIMIT 700.0

/*==============================
        WIFI
==============================*/

#ifndef WIFI_SSID
#define WIFI_SSID ""
#endif

#ifndef WIFI_PASSWORD
#define WIFI_PASSWORD ""
#endif

#ifndef MQTT_HOST
#define MQTT_HOST ""
#endif

#ifndef MQTT_PORT
#define MQTT_PORT 8883
#endif

#ifndef MQTT_USERNAME
#define MQTT_USERNAME ""
#endif

#ifndef MQTT_PASSWORD
#define MQTT_PASSWORD ""
#endif

#ifndef MQTT_CA_CERT
#define MQTT_CA_CERT ""
#endif

#ifndef MQTT_TLS_INSECURE
#define MQTT_TLS_INSECURE false
#endif

#ifndef WEB_USERNAME
#define WEB_USERNAME ""
#endif

#ifndef WEB_PASSWORD
#define WEB_PASSWORD ""
#endif
