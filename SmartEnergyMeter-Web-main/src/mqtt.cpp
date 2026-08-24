#include "mqtt.h"
#include "storage.h"

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <cstring>
#include <PubSubClient.h>
#include <ArduinoJson.h>

#include "config.h"
#include "globals.h"

//==========================================================
// MQTT CLIENT
//==========================================================

WiFiClientSecure espClient;
PubSubClient mqtt(espClient);

//==========================================================
// EMQX CLOUD
//==========================================================

unsigned long lastReconnectAttempt = 0;
const unsigned long RECONNECT_INTERVAL_MS = 5000;

//==========================================================
// MQTT TOPIC
//==========================================================

const char* TOPIC_DATA    = "smartmeter/data";
const char* TOPIC_LIMIT   = "smartmeter/cmd/limit";
const char* TOPIC_RESTART = "smartmeter/cmd/restart";
const char* TOPIC_RESET   = "smartmeter/cmd/reset";
const unsigned long PUBLISH_INTERVAL_MS = 1000;
unsigned long lastPublish = 0;

//==========================================================
// MQTT CALLBACK
//==========================================================

void callback(char* topic, byte* payload, unsigned int length)
{
    String message;

    for (unsigned int i = 0; i < length; i++)
    {
        message += (char)payload[i];
    }

    Serial.print("Topic : ");
    Serial.println(topic);

    Serial.print("Message : ");
    Serial.println(message);

    //======================================================
    // POWER LIMIT
    //======================================================

    if (String(topic) == TOPIC_LIMIT)
    {
        float value = message.toFloat();

        if (value >= 100 && value <= 10000)
        {
            saveLimit(value);

            Serial.print("Limit Baru : ");
            Serial.println(powerLimit);
        }
        else
        {
            Serial.println("Limit tidak valid");
        }
    }

    //======================================================
    // RESTART ESP32
    //======================================================

    else if (String(topic) == TOPIC_RESTART)
    {
        Serial.println("===== MQTT RESTART =====");

        delay(500);

        ESP.restart();
    }

    //======================================================
    // FACTORY RESET
    //======================================================

    else if (String(topic) == TOPIC_RESET)
    {
        Serial.println("===== MQTT FACTORY RESET =====");

        resetConfig();

        delay(1000);

        ESP.restart();
    }
}

//==========================================================
// MQTT BEGIN
//==========================================================

void mqttBegin()
{
    if (strlen(MQTT_HOST) == 0 || strlen(MQTT_USERNAME) == 0 || strlen(MQTT_PASSWORD) == 0)
    {
        Serial.println("MQTT credentials are not configured");
        return;
    }

    if (MQTT_TLS_INSECURE)
        espClient.setInsecure();
    else
        espClient.setCACert(MQTT_CA_CERT);

    mqtt.setServer(MQTT_HOST, MQTT_PORT);

    mqtt.setCallback(callback);

    Serial.println("MQTT initialized");
}

//==========================================================
// MQTT RECONNECT
//==========================================================

void mqttReconnect()
{
    if (mqtt.connected() || strlen(MQTT_HOST) == 0 ||
        strlen(MQTT_USERNAME) == 0 || strlen(MQTT_PASSWORD) == 0 ||
        millis() - lastReconnectAttempt < RECONNECT_INTERVAL_MS)
    {
        return;
    }

    lastReconnectAttempt = millis();
    if (mqtt.connect("ESP32SmartMeter", MQTT_USERNAME, MQTT_PASSWORD))
    {
        mqtt.subscribe(TOPIC_LIMIT);
        mqtt.subscribe(TOPIC_RESTART);
        mqtt.subscribe(TOPIC_RESET);
    }
}

//==========================================================
// MQTT LOOP
//==========================================================

void mqttLoop()
{
    if (!mqtt.connected())
    {
        mqttReconnect();
    }

    mqtt.loop();
}

//==========================================================
// MQTT PUBLISH
//==========================================================

void mqttPublish()
{
    if (!mqtt.connected() || millis() - lastPublish < PUBLISH_INTERVAL_MS)
    {
        return;
    }

    lastPublish = millis();

    StaticJsonDocument<512> doc;

    // Data PZEM
    doc["voltage"] = voltage;
    doc["current"] = current;
    doc["power"] = power;
    doc["energy"] = energy;
    doc["frequency"] = frequency;
    doc["pf"] = pf;

    // Daya
    doc["va"] = apparentPower;
    doc["var"] = reactivePower;

    // Power limiter
    doc["limit"] = powerLimit;

    // Status
    doc["wifi"] = (WiFi.status() == WL_CONNECTED);
    doc["sensor"] = sensorOnline;
    doc["trip"] = overload;

    String json;

    serializeJson(doc, json);

    Serial.print("Publish : ");
    Serial.println(json);

    if (mqtt.publish(TOPIC_DATA, json.c_str()))
    {
        Serial.println("PUBLISH SUCCESS");
    }
    else
    {
        Serial.println("PUBLISH FAILED");
    }
}
