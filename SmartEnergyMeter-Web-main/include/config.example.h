#pragma once

// Copy this file to config.local.h and fill in your own credentials.
// config.local.h is ignored by Git and must never be committed.

// Leave BOTH empty ("") for any new unit — the device starts its own WiFi
// setup portal on first boot instead of needing this compiled in (see
// README's "Setup WiFi tanpa kabel"). Only fill these in for the old-style
// single-device setup, or if you'd rather hardcode WiFi and skip the portal.
#define WIFI_SSID ""
#define WIFI_PASSWORD ""

// These four are the same for every physical unit you build — only the
// MQTT *topics* differ per device (namespaced automatically by device id,
// see README's "Topic MQTT"), never the broker connection itself.
#define MQTT_HOST "broker.example.com"
#define MQTT_PORT 8883
#define MQTT_USERNAME "smartenergymeter"
#define MQTT_PASSWORD "replace-with-a-strong-password"

// Prefer a CA certificate. Set MQTT_TLS_INSECURE to true only for temporary
// local development when certificate validation is not available.
//
// NOTE: each line must end with \n" \ like below (this compiler does not
// support a plain multi-line raw string R"EOF(...)EOF" inside a #define).
#define MQTT_CA_CERT \
"-----BEGIN CERTIFICATE-----\n" \
"replace-with-your-ca-certificate\n" \
"-----END CERTIFICATE-----\n"
#define MQTT_TLS_INSECURE false

#define WEB_USERNAME "admin"
#define WEB_PASSWORD "replace-with-a-strong-password"

// Leave this unset for any new unit — the device generates its own id from
// its MAC address automatically, no two units will ever collide. Only set
// this if you need a specific unit to use an id you already created by
// hand on the web dashboard (see README's "Multi-device").
// #define DEVICE_ID "meter-01"
