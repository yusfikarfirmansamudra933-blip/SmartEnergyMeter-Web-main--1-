#include <Arduino.h>
#include "config.h"
#include "globals.h"
#include "PowerLimit.h"

#include "storage.h"
#include "oled.h"
#include "pzem.h"
#include "wifiManager.h"
#include "webServer.h"
#include "mqtt.h"

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
