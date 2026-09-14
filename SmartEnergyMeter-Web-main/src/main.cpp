#include <Arduino.h>
#include <Update.h>
#include <WiFi.h>
#include "config.h"
#include "globals.h"
#include "PowerLimit.h"

#include "storage.h"
#include "oled.h"
#include "pzem.h"
#include "dhtSensor.h"
#include "wifiManager.h"
#include "wifiProvision.h"
#include "webServer.h"
#include "mqtt.h"

namespace {
// A firmware that just came in over OTA gets one chance to prove it can
// reach WiFi before this device is trusted to keep running it. Runs once,
// synchronously, before mqttBegin()/webServerBegin() even start — if we're
// about to roll back anyway there's no point spinning those up first.
constexpr unsigned long OTA_VERIFY_TIMEOUT_MS = 20000;

// DHT22 only refreshes internally every ~2s; polling faster just re-reads
// the same stale value (or returns NaN), unlike the PZEM which is happy at
// SENSOR_INTERVAL.
constexpr unsigned long DHT_READ_INTERVAL_MS = 2500;

// GPIO0 is the "BOOT" button already on every ESP32 dev board — no extra
// wiring needed. The bootloader only cares about its state for a moment at
// power-on; by the time app code runs it's a plain input we're free to
// read like any other button.
constexpr uint8_t PROVISION_BUTTON_PIN = 0;
constexpr unsigned long PROVISION_HOLD_MS = 2000;

// True only if the button was already held at boot AND stayed held for the
// full PROVISION_HOLD_MS — a quick accidental bump during power-on isn't
// enough to drop a working WiFi setup back into the setup portal.
bool provisionButtonHeld()
{
    pinMode(PROVISION_BUTTON_PIN, INPUT_PULLUP);

    if (digitalRead(PROVISION_BUTTON_PIN) != LOW)
    {
        return false;
    }

    const unsigned long start = millis();
    while (digitalRead(PROVISION_BUTTON_PIN) == LOW)
    {
        if (millis() - start >= PROVISION_HOLD_MS)
        {
            return true;
        }
        delay(20);
    }

    return false;
}

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

    // Checked before anything else touches WiFi: either the button is being
    // held right now (user wants to reconfigure), or nothing usable is
    // configured at all (brand new device, nothing in NVS, nothing compiled
    // into config.local.h). Either way wifiProvisionBegin() blocks here and
    // restarts the device itself once done — it never returns normally.
    if (provisionButtonHeld() || (!hasStoredWifiCredentials() && strlen(WIFI_SSID) == 0))
    {
        wifiProvisionBegin();
    }

    pzemBegin();
    dhtSensorBegin();
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

    if (millis() - dhtTimer >= DHT_READ_INTERVAL_MS)
    {
        dhtTimer = millis();
        readDHTSensor();
    }

    mqttPublish();

    wifiLoop();
    mqttLoop();

    

    webServerLoop();

    oledLoop();
}
