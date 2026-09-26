#ifndef MQTT_H
#define MQTT_H

#include <Arduino.h>

void mqttBegin();

void mqttReconnect();

void mqttLoop();

void mqttPublish();

// Publishes a retained message if connected; false when it could not be sent.
bool mqttPublishRetained(const char *topic, const String &payload);

#endif