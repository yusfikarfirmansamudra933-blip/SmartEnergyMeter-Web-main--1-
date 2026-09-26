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
const char* TOPIC_STATUS  = "smartmeter/status";
const char* TOPIC_LIMIT   = "smartmeter/cmd/limit";
const char* TOPIC_RESTART = "smartmeter/cmd/restart";
const char* TOPIC_RESET   = "smartmeter/cmd/reset";
const char* TOPIC_POWER   = "smartmeter/cmd/power";
const unsigned long PUBLISH_INTERVAL_MS = 1000;
unsigned long lastPublish = 0;

// smartmeter/status carries one of three values: "online", "standby" (set
// here) or "offline" (the Last Will, set by the broker). Reusing this topic
// instead of adding a new one means every consumer that already subscribes
// to it sees standby without any broker permission changes.
const char* currentStatus()
{
    return standby ? "standby" : "online";
}

void publishStatus()
{
    mqtt.publish(TOPIC_STATUS, currentStatus(), true);
}

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

    //======================================================
    // STANDBY / ON
    //======================================================

    else if (String(topic) == TOPIC_POWER)
    {
        if (message == "off")
        {
            standby = true;
        }
        else if (message == "on")
        {
            standby = false;
            // Readings from before standby are stale; publish nothing until
            // the next PZEM read replaces them.
            sensorTimer = 0;
            lastPublish = millis();
        }
        else
        {
            Serial.println("Perintah power tidak valid");
            return;
        }

        Serial.print("Mode : ");
        Serial.println(currentStatus());

        publishStatus();
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

    // Last Will: if the device drops off ungracefully (power loss, WiFi
    // loss), the broker publishes "offline" on our behalf so consumers can
    // tell stale retained data from a genuinely live device.
    if (mqtt.connect("ESP32SmartMeter", MQTT_USERNAME, MQTT_PASSWORD,
                      TOPIC_STATUS, 1, true, "offline"))
    {
        publishStatus();
        mqtt.subscribe(TOPIC_LIMIT);
        mqtt.subscribe(TOPIC_RESTART);
        mqtt.subscribe(TOPIC_RESET);
        mqtt.subscribe(TOPIC_POWER);
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
    if (standby || !mqtt.connected() || millis() - lastPublish < PUBLISH_INTERVAL_MS)
    {
        return;
    }

    lastPublish = millis();

    StaticJsonDocument<768> doc;

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

    // Suhu chip ESP32 — sengaja dihilangkan (bukan dikirim sebagai 0) kalau
    // belum ada pembacaan valid, supaya penerima tidak menampilkan angka palsu.
    if (chipTempValid)
    {
        doc["chipTemperature"] = chipTemperature;
    }

    String json;

    serializeJson(doc, json);

    Serial.print("Publish : ");
    Serial.println(json);

    if (mqtt.publish(TOPIC_DATA, json.c_str(), true))
    {
        Serial.println("PUBLISH SUCCESS");
    }
    else
    {
        Serial.println("PUBLISH FAILED");
    }
}
