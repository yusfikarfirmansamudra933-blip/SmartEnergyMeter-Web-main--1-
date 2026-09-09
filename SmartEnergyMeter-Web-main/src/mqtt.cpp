#include "mqtt.h"
#include "storage.h"

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <cstring>
#include <PubSubClient.h>
#include <ArduinoJson.h>

#include "config.h"
#include "globals.h"
#include "wifiManager.h"

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

// Built once on first use (see topicPrefix() below) instead of at static-
// init time, because getDeviceId() reads WiFi.macAddress() — not valid
// until wifiBegin() has run, which happens after globals/statics are
// already constructed.
String topicData;
String topicStatus;
String topicLimit;
String topicRestart;
String topicReset;
String topicClaimed;
String mqttClientId;
bool topicsInitialized = false;

void initTopicsOnce()
{
    if (topicsInitialized)
    {
        return;
    }

    const String prefix = "smartmeter/" + getDeviceId() + "/";
    topicData = prefix + "data";
    topicStatus = prefix + "status";
    topicLimit = prefix + "cmd/limit";
    topicRestart = prefix + "cmd/restart";
    topicReset = prefix + "cmd/reset";
    // Published (retained) by web-remote/devices.html once someone adds
    // this device on the dashboard — see isPaired()'s doc comment.
    topicClaimed = prefix + "claimed";
    // Was a hardcoded "ESP32SmartMeter" — fine for one device, but the
    // broker drops whichever connection loses a client-id collision, so
    // two physical units sharing that string would fight each other for
    // the connection every reconnect cycle.
    mqttClientId = "ESP32SmartMeter-" + getDeviceId();
    topicsInitialized = true;

    Serial.print("MQTT device id: ");
    Serial.println(getDeviceId());
}

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

    if (String(topic) == topicLimit)
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

    else if (String(topic) == topicRestart)
    {
        Serial.println("===== MQTT RESTART =====");

        delay(500);

        ESP.restart();
    }

    //======================================================
    // FACTORY RESET
    //======================================================

    else if (String(topic) == topicReset)
    {
        Serial.println("===== MQTT FACTORY RESET =====");

        resetConfig();

        delay(1000);

        ESP.restart();
    }

    //======================================================
    // PAIRING CLAIMED (see isPaired() in storage.h)
    //======================================================

    else if (String(topic) == topicClaimed)
    {
        Serial.println("===== DEVICE PAIRED =====");

        markPaired();
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

    // Needs WiFi.macAddress(), so this can't run at static-init time — see
    // initTopicsOnce()'s doc comment. wifiBegin() has already run by the
    // time main.cpp calls mqttBegin(), so the MAC is available.
    initTopicsOnce();

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
    if (mqtt.connect(mqttClientId.c_str(), MQTT_USERNAME, MQTT_PASSWORD,
                      topicStatus.c_str(), 1, true, "offline"))
    {
        mqtt.publish(topicStatus.c_str(), "online", true);
        mqtt.subscribe(topicLimit.c_str());
        mqtt.subscribe(topicRestart.c_str());
        mqtt.subscribe(topicReset.c_str());
        // Subscribed unconditionally (not just while unpaired) so a
        // re-claim after a factory reset is picked up the same way — and
        // because the retained message (if any) is redelivered on every
        // fresh subscribe, so this also self-heals if markPaired() ever
        // failed to persist for some reason.
        mqtt.subscribe(topicClaimed.c_str());
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
    doc["deviceId"] = getDeviceId();

    String json;

    serializeJson(doc, json);

    Serial.print("Publish : ");
    Serial.println(json);

    if (mqtt.publish(topicData.c_str(), json.c_str(), true))
    {
        Serial.println("PUBLISH SUCCESS");
    }
    else
    {
        Serial.println("PUBLISH FAILED");
    }
}
