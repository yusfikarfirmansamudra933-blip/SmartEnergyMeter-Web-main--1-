#include <Arduino.h>
#include <Update.h>
#include <WiFi.h>
#include "config.h"
#include "globals.h"
#include "PowerLimit.h"

#include "storage.h"
#include "oled.h"
#include "pzem.h"
#include "wifiManager.h"
#include "webServer.h"
#include "mqtt.h"

namespace {
// A firmware that just came in over OTA gets one chance to prove it can
// reach WiFi before this device is trusted to keep running it. Runs once,
// synchronously, before mqttBegin()/webServerBegin() even start — if we're
// about to roll back anyway there's no point spinning those up first.
constexpr unsigned long OTA_VERIFY_TIMEOUT_MS = 20000;

void verifyOtaOrRollBack()
{
    if (!isOtaPendingVerify())
    {
        return;
    }

    Serial.println("OTA pending verify: checking WiFi connectivity...");
    oledOtaVerifyScreen("Verifying WiFi...");

    const unsigned long verifyStart = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - verifyStart < OTA_VERIFY_TIMEOUT_MS)
    {
        delay(250);
    }

    // Cleared either way: a successful connect means this firmware is
    // trusted from now on, and a failed one is about to either roll back
    // (a different partition, which never set this flag) or — if there's
    // nothing to roll back to — just keep booting as-is, in which case
    // re-checking on every future boot would only add a needless delay.
    clearOtaPendingVerify();

    if (WiFi.status() == WL_CONNECTED)
    {
        Serial.println("OTA verified: WiFi connected.");
        return;
    }

    Serial.println("OTA verify FAILED: WiFi did not connect.");

    if (Update.canRollBack() && Update.rollBack())
    {
        Serial.println("Rolling back to previous firmware...");
        oledOtaVerifyScreen("Rollback! Restarting...");
        delay(1500);
        ESP.restart();
    }

    Serial.println("No previous firmware to roll back to, continuing to boot this one.");
}
}  // namespace

void setup()
{
    Serial.begin(115200);

    Serial.println();
    Serial.println("==============================");
    Serial.println(PROJECT_NAME);
    Serial.println("==============================");

    storageBegin();

    oledBegin();


    pzemBegin();
    wifiBegin();

    verifyOtaOrRollBack();

    mqttBegin();
    webServerBegin();

    Serial.println("Initialization Complete");
}

void loop()
{
    // Membaca PZEM setiap SENSOR_INTERVAL
    if (millis() - sensorTimer >= SENSOR_INTERVAL)
    {
        sensorTimer = millis();

        readPZEM();

        checkPowerLimit();

        notifyClients();

        Serial.printf(
            "V %.1f | I %.2f | P %.1f | E %.2f | Hz %.2f | PF %.2f\n",
            voltage,
            current,
            power,
            energy,
            frequency,
            pf
        );
    }
    mqttPublish();

    wifiLoop();
    mqttLoop();

    

    webServerLoop();

    oledLoop();
}
