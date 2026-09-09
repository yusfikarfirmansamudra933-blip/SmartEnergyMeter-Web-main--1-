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
#define FIRMWARE_VERSION "1.6.1"

/*==============================
        OLED
==============================*/

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 32

#define OLED_ADDRESS 0x3C

#define OLED_SDA 21
#define OLED_SCL 22

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

#define GRAPH_INTERVAL 1000

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

// Empty by default (auto MAC-based id, see getDeviceId() in wifiManager.cpp).
// Override in config.local.h to match an id already registered on the web
// dashboard, e.g. #define DEVICE_ID "meter-01"
#ifndef DEVICE_ID
#define DEVICE_ID ""
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
