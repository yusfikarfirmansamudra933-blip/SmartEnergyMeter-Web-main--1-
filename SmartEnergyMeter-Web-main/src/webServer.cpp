#include "webServer.h"

#include <Arduino.h>
#include <cstring>
#include <LittleFS.h>
#include <ESPAsyncWebServer.h>
#include <ArduinoJson.h>
#include <WiFi.h>
#include "globals.h"
#include "storage.h"
#include "wifiManager.h"

AsyncWebServer server(80);
AsyncWebSocket ws("/ws");

//====================================================
// Broadcast JSON
//====================================================

void notifyClients()
{
    StaticJsonDocument<512> doc;

    doc["voltage"] = voltage;
    doc["current"] = current;
    doc["power"] = power;
    doc["energy"] = energy;
    doc["frequency"] = frequency;
    doc["pf"] = pf;

    doc["va"] = apparentPower;
    doc["var"] = reactivePower;

    doc["trip"] = overload;
    doc["limit"] = powerLimit;

    doc["wifi"] = wifiConnected();
    doc["sensor"] = sensorOnline;
    doc["ip"] = getIPAddress();

    String json;
serializeJson(doc, json);

Serial.print("Notify Limit = ");
Serial.println(powerLimit);

ws.textAll(json);
}

//====================================================
// WebSocket Event
//====================================================

void onWsEvent(
    AsyncWebSocket *server,
    AsyncWebSocketClient *client,
    AwsEventType type,
    void *arg,
    uint8_t *data,
    size_t len)
{
    switch(type)
    {
        case WS_EVT_CONNECT:
            Serial.printf("Client %u Connected\n", client->id());
            notifyClients();
            break;

        case WS_EVT_DISCONNECT:
            Serial.printf("Client %u Disconnect\n", client->id());
            break;

        case WS_EVT_DATA:
        {
            AwsFrameInfo *info = (AwsFrameInfo*)arg;

            if(info->opcode == WS_TEXT)
            {
                String msg;

                for(size_t i=0;i<len;i++)
                    msg += (char)data[i];

                Serial.println(msg);
            }
        }
        break;

        default:
        break;
    }
}

//====================================================
// API STATUS
//====================================================

void registerApiStatus()
{
    server.on("/api/status", HTTP_GET,
    [](AsyncWebServerRequest *request)
    {
        StaticJsonDocument<512> doc;

        doc["voltage"] = voltage;
        doc["current"] = current;
        doc["power"] = power;
        doc["energy"] = energy;
        doc["frequency"] = frequency;
        doc["pf"] = pf;
        doc["va"] = apparentPower;
        doc["var"] = reactivePower;

        doc["limit"] = powerLimit;

        doc["wifi"] = wifiConnected();
        doc["sensor"] = sensorOnline;
        doc["ip"] = getIPAddress();

        String json;
        serializeJson(doc, json);

        request->send(200, "application/json", json);
    });
}

//====================================================
// SET LIMIT
//====================================================

void registerSetLimit()
{
    server.on("/setLimit", HTTP_GET,
    [](AsyncWebServerRequest *request)
    {
        if(!request->hasParam("value"))
        {
            request->send(400, "text/plain", "No Value");
            return;
        }

        float value = request->getParam("value")->value().toFloat();

        Serial.print("Request Limit = ");
        Serial.println(value);

        if(value < 100 || value > 10000)
        {
            request->send(400, "text/plain", "Invalid");
            return;
        }

        saveLimit(value);

        notifyClients();

        request->send(200, "text/plain", "OK");
    });
}

//====================================================
// RESTART
//====================================================

void registerRestart()
{
    server.on("/restart", HTTP_GET,
    [](AsyncWebServerRequest *request)
    {
        request->send(200,"text/plain","Restart");

        delay(300);

        ESP.restart();
    });
}

//====================================================
// FACTORY RESET
//====================================================

void registerFactoryReset()
{
    server.on("/factoryReset", HTTP_GET,
    [](AsyncWebServerRequest *request)
    {
        resetConfig();

        notifyClients();

        request->send(200,"text/plain","Factory Reset");
    });
}

//====================================================
// LOGIN
//====================================================

void registerLogin()
{
    server.on("/login",
    HTTP_POST,

    [](AsyncWebServerRequest *request){},

    NULL,

    [](AsyncWebServerRequest *request,
       uint8_t *data,
       size_t len,
       size_t index,
       size_t total)
    {

        StaticJsonDocument<128> doc;

        deserializeJson(doc,data);

        String username = doc["username"];
        String password = doc["password"];

        if (strlen(WEB_USERNAME) > 0 && strlen(WEB_PASSWORD) > 0 &&
            username == WEB_USERNAME && password == WEB_PASSWORD)
        {
            request->send(200,"text/plain","OK");
        }
        else
        {
            request->send(401,"text/plain","FAIL");
        }

    });
}

//====================================================
// WEBSITE
//====================================================

void registerStaticFiles()
{
    server.serveStatic("/", LittleFS, "/")
          .setDefaultFile("index.html");
}

//====================================================
// START SERVER
//====================================================

void webServerBegin()
{
    if(!LittleFS.begin(true))
    {
        Serial.println("LittleFS Mount Failed");
        return;
    }

    ws.onEvent(onWsEvent);

    server.addHandler(&ws);

    registerStaticFiles();
    registerApiStatus();
    registerSetLimit();
    registerRestart();
    registerFactoryReset();
    registerLogin();
   

    server.onNotFound([](AsyncWebServerRequest *request)
    {
        request->send(404,"text/plain","404 Not Found");
    });

    server.begin();

    Serial.println("HTTP Server Started");
}

//====================================================
// LOOP
//====================================================

void webServerLoop()
{
    ws.cleanupClients();

    static unsigned long lastUpdate = 0;

    if(millis() - lastUpdate >= 1000)
    {
        lastUpdate = millis();

        notifyClients();
    }
}
