#include "mqtt.h"
#include "storage.h"

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <cstring>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <esp_ota_ops.h>

#include "billing.h"
#include "cloudOta.h"
#include "config.h"
#include "deviceId.h"
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

// All under smartmeter/<deviceId>/, filled in by mqttBegin().
String TOPIC_DATA;
String TOPIC_STATUS;
String TOPIC_LIMIT;
String TOPIC_RESTART;
String TOPIC_RESET;
String TOPIC_POWER;
String TOPIC_TARIFF;
String TOPIC_UPDATE;
String TOPIC_INFO;
const unsigned long PUBLISH_INTERVAL_MS = 1000;
unsigned long lastPublish = 0;

// .../status carries one of three values: "online", "standby" (set here) or
// "offline" (the Last Will, set by the broker). Reusing this topic instead
// of adding a new one means every consumer that already subscribes to it
// sees standby without any broker permission changes.
const char* currentStatus()
{
    return standby ? "standby" : "online";
}

void publishStatus()
{
    mqtt.publish(TOPIC_STATUS.c_str(), currentStatus(), true);
}

// Which build this unit runs and how it is connected, for the admin page.
// Sent once per connect: none of it changes while connected.
void publishInfo()
{
    StaticJsonDocument<192> doc;
    doc["fw"] = FIRMWARE_VERSION;
    doc["ip"] = WiFi.localIP().toString();
    doc["rssi"] = WiFi.RSSI();
    doc["heap"] = ESP.getFreeHeap();
    // Bytes a cloud update may use here: units flashed before partitions.csv
    // still have the old 1.25 MB slots until they get one USB flash.
    const esp_partition_t *running = esp_ota_get_running_partition();
    doc["appSize"] = running ? running->size : 0;

    String json;
    serializeJson(doc, json);
    mqtt.publish(TOPIC_INFO.c_str(), json.c_str(), true);
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

    if (TOPIC_LIMIT == topic)
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

    else if (TOPIC_RESTART == topic)
    {
        Serial.println("===== MQTT RESTART =====");

        delay(500);

        ESP.restart();
    }

    //======================================================
    // FACTORY RESET
    //======================================================

    else if (TOPIC_RESET == topic)
    {
        Serial.println("===== MQTT FACTORY RESET =====");

        resetConfig();

        delay(1000);

        ESP.restart();
    }

    //======================================================
    // UPDATE FIRMWARE DARI CLOUD
    //======================================================

    // Only asks for a check: what gets installed is decided by the signed
    // release on the server, never by this message.
    else if (TOPIC_UPDATE == topic)
    {
        Serial.println("===== MQTT CEK UPDATE =====");
        cloudOtaRequestCheck();
    }

    //======================================================
    // TARIF LISTRIK
    //======================================================

    else if (TOPIC_TARIFF == topic)
    {
        // {"code":"R1-900","rate":1352}; an empty payload (cleared) keeps the last rate.
        StaticJsonDocument<128> doc;
        if (length == 0 || deserializeJson(doc, message))
            return;

        if (billingSetRate(doc["rate"] | NAN))
        {
            Serial.print("Tarif Baru : ");
            Serial.println(electricityRate);
        }
    }

    else if (TOPIC_POWER == topic)
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

    TOPIC_DATA    = deviceTopic("data");
    TOPIC_STATUS  = deviceTopic("status");
    TOPIC_LIMIT   = deviceTopic("cmd/limit");
    TOPIC_RESTART = deviceTopic("cmd/restart");
    TOPIC_RESET   = deviceTopic("cmd/reset");
    TOPIC_POWER   = deviceTopic("cmd/power");
    TOPIC_TARIFF  = deviceTopic("billing/tariff");
    TOPIC_UPDATE  = deviceTopic("cmd/update");
    TOPIC_INFO    = deviceTopic("info");

    Serial.printf("ID perangkat : %s\n", deviceId());

    if (MQTT_TLS_INSECURE)
        espClient.setInsecure();
    else
        espClient.setCACert(MQTT_CA_CERT);

    mqtt.setServer(MQTT_HOST, MQTT_PORT);

    // PubSubClient's default 256-byte buffer fits the live readings but not
    // the hour of history (about 2.5 KB).
    mqtt.setBufferSize(4096);

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
    // The client ID doubles as the broker's ACL key: one rule on
    // smartmeter/${clientid}/# covers every unit sharing these credentials.
    if (mqtt.connect(deviceId(), MQTT_USERNAME, MQTT_PASSWORD,
                      TOPIC_STATUS.c_str(), 1, true, "offline"))
    {
        publishStatus();
        publishInfo();
        mqtt.subscribe(TOPIC_UPDATE.c_str());
        mqtt.subscribe(TOPIC_LIMIT.c_str());
        mqtt.subscribe(TOPIC_RESTART.c_str());
        mqtt.subscribe(TOPIC_RESET.c_str());
        mqtt.subscribe(TOPIC_POWER.c_str());
        // Retained, so the current class arrives right after every connect.
        mqtt.subscribe(TOPIC_TARIFF.c_str());
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

bool mqttConnected()
{
    return mqtt.connected();
}

void mqttSuspend()
{
    mqtt.disconnect();
    espClient.stop();
}

bool mqttPublishRetained(const char *topic, const String &payload)
{
    if (!mqtt.connected())
        return false;

    const bool ok = mqtt.publish(topic, payload.c_str(), true);
    Serial.printf("Publish %s (%u byte): %s\n", topic, payload.length(), ok ? "OK" : "GAGAL");
    return ok;
}

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

    if (mqtt.publish(TOPIC_DATA.c_str(), json.c_str(), true))
    {
        Serial.println("PUBLISH SUCCESS");
    }
    else
    {
        Serial.println("PUBLISH FAILED");
    }
}
