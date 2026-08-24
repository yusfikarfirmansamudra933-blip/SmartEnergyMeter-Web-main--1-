#pragma once

// Copy this file to config.local.h and fill in your own credentials.
// config.local.h is ignored by Git and must never be committed.

#define WIFI_SSID "your-wifi-name"
#define WIFI_PASSWORD "your-wifi-password"

#define MQTT_HOST "broker.example.com"
#define MQTT_PORT 8883
#define MQTT_USERNAME "smartenergymeter"
#define MQTT_PASSWORD "replace-with-a-strong-password"

// Prefer a CA certificate. Set MQTT_TLS_INSECURE to true only for temporary
// local development when certificate validation is not available.
#define MQTT_CA_CERT R"EOF(
-----BEGIN CERTIFICATE-----
replace-with-your-ca-certificate
-----END CERTIFICATE-----
)EOF"
#define MQTT_TLS_INSECURE false

#define WEB_USERNAME "admin"
#define WEB_PASSWORD "replace-with-a-strong-password"
