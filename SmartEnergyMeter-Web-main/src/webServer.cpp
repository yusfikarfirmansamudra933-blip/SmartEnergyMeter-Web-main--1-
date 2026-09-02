#include "webServer.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESPAsyncWebServer.h>
#include <LittleFS.h>
#include <cstring>

#include "config.h"
#include "globals.h"
#include "storage.h"
#include "wifiManager.h"

namespace {
constexpr uint16_t HTTP_PORT = 80;
constexpr unsigned long STATUS_BROADCAST_INTERVAL_MS = 1000;

AsyncWebServer server(HTTP_PORT);
AsyncWebSocket webSocket("/ws");

String createStatusJson()
{
    StaticJsonDocument<512> document;
    document["voltage"] = voltage;
    document["current"] = current;
    document["power"] = power;
    document["energy"] = energy;
    document["frequency"] = frequency;
    document["pf"] = pf;
    document["va"] = apparentPower;
    document["var"] = reactivePower;
    document["trip"] = overload;
    document["limit"] = powerLimit;
    document["wifi"] = wifiConnected();
    document["sensor"] = sensorOnline;
    document["ip"] = getIPAddress();

    String json;
    serializeJson(document, json);
    return json;
}

void sendStatus(AsyncWebServerRequest *request)
{
    request->send(200, "application/json", createStatusJson());
}

void handleWebSocket(
    AsyncWebSocket *,
    AsyncWebSocketClient *client,
    AwsEventType event,
    void *,
    uint8_t *,
    size_t)
{
    if (event == WS_EVT_CONNECT)
    {
        Serial.printf("Dashboard client %u connected\n", client->id());
        client->text(createStatusJson());
    }
    else if (event == WS_EVT_DISCONNECT)
    {
        Serial.printf("Dashboard client %u disconnected\n", client->id());
    }
}

void handleLoginBody(
    AsyncWebServerRequest *request,
    uint8_t *data,
    size_t len,
    size_t index,
    size_t total)
{
    static String body;
    if (index == 0)
    {
        body = "";
    }
    for (size_t i = 0; i < len; i++)
    {
        body += (char)data[i];
    }

    if (index + len != total)
    {
        return;
    }

    StaticJsonDocument<256> document;
    const bool parsed = deserializeJson(document, body) == DeserializationError::Ok;
    const char *username = document["username"] | "";
    const char *password = document["password"] | "";

    const bool credentialsConfigured = strlen(WEB_USERNAME) > 0;
    const bool authorized = credentialsConfigured && parsed &&
                             strcmp(username, WEB_USERNAME) == 0 &&
                             strcmp(password, WEB_PASSWORD) == 0;

    request->send(authorized ? 200 : 401, "text/plain", authorized ? "OK" : "FAIL");
}

void registerApiRoutes()
{
    server.on("/api/status", HTTP_GET, sendStatus);

    server.on(
        "/login",
        HTTP_POST,
        [](AsyncWebServerRequest *) {},
        nullptr,
        handleLoginBody);

    server.on("/setLimit", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (!request->hasParam("value"))
        {
            request->send(400, "text/plain", "Missing power limit");
            return;
        }

        const float value = request->getParam("value")->value().toFloat();
        if (value < 100.0f || value > 10000.0f)
        {
            request->send(400, "text/plain", "Power limit must be 100 to 10000");
            return;
        }

        saveLimit(value);
        notifyClients();
        request->send(200, "text/plain", "OK");
    });

    server.on("/restart", HTTP_GET, [](AsyncWebServerRequest *request) {
        request->send(200, "text/plain", "Restarting");
        delay(250);
        ESP.restart();
    });

    server.on("/factoryReset", HTTP_GET, [](AsyncWebServerRequest *request) {
        resetConfig();
        notifyClients();
        request->send(200, "text/plain", "Factory reset complete");
    });
}

void registerStaticFiles()
{
    server.serveStatic("/", LittleFS, "/").setDefaultFile("index.html");
}
}  // namespace

void webServerBegin()
{
    if (!LittleFS.begin(true))
    {
        Serial.println("LittleFS mount failed");
        return;
    }

    webSocket.onEvent(handleWebSocket);
    server.addHandler(&webSocket);
    registerStaticFiles();
    registerApiRoutes();

    server.onNotFound([](AsyncWebServerRequest *request) {
        request->send(404, "text/plain", "Not found");
    });

    server.begin();
    Serial.println("HTTP server started");
}

void webServerLoop()
{
    webSocket.cleanupClients();

    static unsigned long lastBroadcast = 0;
    if (millis() - lastBroadcast >= STATUS_BROADCAST_INTERVAL_MS)
    {
        lastBroadcast = millis();
        notifyClients();
    }
}

void notifyClients()
{
    webSocket.textAll(createStatusJson());
}
