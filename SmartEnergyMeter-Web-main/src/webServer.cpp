#include "webServer.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESPAsyncWebServer.h>
#include <LittleFS.h>
#include <Update.h>
#include <cstring>

#include "config.h"
#include "globals.h"
#include "oled.h"
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
    document["version"] = FIRMWARE_VERSION;

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

// Set on the first chunk of an /update upload and read on every later chunk
// and on the final response — safe as a single static because this device
// only ever serves one firmware upload at a time.
bool otaAuthorized = false;

// Body handler for the multipart file upload: called repeatedly as chunks of
// the .bin arrive, with `final` set on the very last one. Writes go straight
// into the inactive OTA partition (app0/app1, already provided by the
// board's default partition table) via the ESP32 core's Update API.
void handleFirmwareUpload(
    AsyncWebServerRequest *request,
    String filename,
    size_t index,
    uint8_t *data,
    size_t len,
    bool final)
{
    if (index == 0)
    {
        const bool credentialsConfigured = strlen(WEB_USERNAME) > 0;
        otaAuthorized = !credentialsConfigured || request->authenticate(WEB_USERNAME, WEB_PASSWORD);
        if (!otaAuthorized)
        {
            return;
        }

        Serial.printf("OTA update starting: %s\n", filename.c_str());

        // Only updates plain state (see oled.cpp) — safe to call from this
        // handler's task. Claiming the OLED before Update.begin() runs means
        // even a begin() failure is covered by the progress/result screens
        // instead of the normal metric pages popping back up mid-update.
        oledOtaProgress(0);

        const size_t updateSize = request->contentLength() > 0 ? request->contentLength() : UPDATE_SIZE_UNKNOWN;
        if (!Update.begin(updateSize, U_FLASH))
        {
            Update.printError(Serial);
        }
    }

    if (!otaAuthorized)
    {
        return;
    }

    if (!Update.hasError() && Update.write(data, len) != len)
    {
        Update.printError(Serial);
    }

    // Tracks bytes received rather than bytes flashed, so the bar still
    // reaches 100% (and the failure screen below can take over cleanly)
    // even if Update.write() above failed partway through.
    const size_t contentLength = request->contentLength();
    if (contentLength > 0)
    {
        uint32_t percent = (uint32_t)(((index + len) * 100UL) / contentLength);
        if (percent > 100)
        {
            percent = 100;
        }
        oledOtaProgress((uint8_t)percent);
    }

    if (final)
    {
        if (!Update.hasError() && Update.end(true))
        {
            Serial.printf("OTA update complete: %u bytes\n", index + len);
        }
        else
        {
            Update.printError(Serial);
        }
    }
}

// Response handler for /update, runs once the upload above has finished.
void handleFirmwareUpdateResult(AsyncWebServerRequest *request)
{
    if (!otaAuthorized)
    {
        request->requestAuthentication();
        return;
    }

    const bool success = !Update.hasError();
    oledOtaResult(success);

    // Read back by main.cpp's setup() on the very next boot — see
    // storage.h. If that firmware can't even get WiFi up, it rolls itself
    // back to the partition we're running right now instead of leaving the
    // device stranded on a broken update.
    if (success)
    {
        markOtaPendingVerify();
    }

    // Update.errorString() is safe to call even when there's no error (it
    // reads back "No Error" in that case) — surfacing it always means the
    // real failure reason is visible from the HTTP response alone, without
    // needing a USB/serial connection to read Update.printError().
    String message = success ? "OK" : ("Update gagal: " + String(Update.errorString()));
    AsyncWebServerResponse *response = request->beginResponse(
        success ? 200 : 500,
        "text/plain",
        message);
    response->addHeader("Connection", "close");
    request->send(response);

    if (success)
    {
        // Two things need time before we pull the rug out from under them:
        // oledLoop() (main task) needs a turn to pick up oledOtaResult()'s
        // state and draw it, and — the flakier one in practice — the "OK"
        // response above needs to actually clear the TCP send queue and
        // reach the client over WiFi. On a weak/high-latency link (seen
        // during testing: ~150-250ms RTT) the previous delay(250) restarted
        // the device before the response went out, so curl saw a connection
        // reset and reported "failed" even though the flash write and
        // reboot both succeeded. This is a bandage, not a guarantee — with
        // a bad enough link the client can still miss it — but it covers
        // the conditions actually observed.
        delay(1500);
        ESP.restart();
    }
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

    server.on(
        "/update",
        HTTP_POST,
        handleFirmwareUpdateResult,
        handleFirmwareUpload);

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
