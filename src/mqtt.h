#ifndef MQTT_H
#define MQTT_H

#include <Arduino.h>

void mqttBegin();

void mqttLoop();

void mqttPublish();

bool mqttConnected();

// Drops the broker connection without the Last Will (status stays as it was)
// to free memory for a firmware download. mqttLoop() reconnects afterwards.
void mqttSuspend();

// Publishes a retained message if connected; false when it could not be sent.
bool mqttPublishRetained(const char *topic, const String &payload);

#endif