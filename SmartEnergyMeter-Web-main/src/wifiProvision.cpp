#include "wifiProvision.h"

#include <Arduino.h>
#include <DNSServer.h>
#include <ESPAsyncWebServer.h>
#include <WiFi.h>

#include "oled.h"
#include "storage.h"
#include "wifiManager.h"

namespace {

// Blocking (WiFi.scanNetworks() takes a couple seconds) — called once
// right before the portal starts, not per-request, so a slow scan doesn't
// stall every page load.
String scanNetworksOptionsHtml()
{
    const int count = WiFi.scanNetworks();
    String options;

    for (int i = 0; i < count; i++)
    {
        String ssid = WiFi.SSID(i);
        ssid.replace("\"", "&quot;");
        options += "<option value=\"" + ssid + "\">" + ssid + " (" + String(WiFi.RSSI(i)) + " dBm)</option>";
    }

    return options;
}

String buildPortalHtml(const String &deviceId, const String &optionsHtml)
{
    String html;
    html += "<!doctype html><html><head><meta charset=\"utf-8\">";
    html += "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">";
    html += "<title>Setup WiFi</title><style>";
    html += "body{font-family:sans-serif;background:#0b1326;color:#fff;padding:20px;margin:0}";
    html += "h1{font-size:20px;margin:0 0 4px}";
    html += "p{color:#94A3B8;margin:0 0 16px}";
    html += "label{display:block;font-size:13px;color:#94A3B8;margin-top:12px}";
    html += "select,input{width:100%;padding:10px;margin-top:4px;border-radius:8px;";
    html += "border:1px solid #2d3449;background:#171f33;color:#fff;box-sizing:border-box;font-size:15px}";
    html += "button{width:100%;padding:12px;margin-top:20px;background:#4edea3;color:#003824;";
    html += "border:0;border-radius:8px;font-weight:bold;font-size:16px}";
    html += "</style></head><body>";
    html += "<h1>Setup WiFi</h1><p>Smart Energy Meter &middot; " + deviceId + "</p>";
    html += "<form method=\"POST\" action=\"/save\">";
    html += "<label>Pilih WiFi</label>";
    html += "<select onchange=\"document.getElementById('ssid').value=this.value\">";
    html += "<option value=\"\">-- pilih dari daftar --</option>" + optionsHtml + "</select>";
    html += "<label>Atau isi manual (SSID)</label>";
    html += "<input id=\"ssid\" name=\"ssid\" placeholder=\"Nama WiFi\">";
    html += "<label>Password WiFi</label>";
    html += "<input name=\"password\" type=\"password\" placeholder=\"Password\">";
    html += "<button type=\"submit\">Simpan &amp; Sambungkan</button>";
    html += "</form></body></html>";
    return html;
}

const char *SAVED_HTML =
    "<!doctype html><html><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head>"
    "<body style=\"font-family:sans-serif;background:#0b1326;color:#fff;padding:20px\">"
    "<h1>Tersimpan!</h1><p>Perangkat akan restart dan mencoba konek ke WiFi...</p>"
    "</body></html>";

}  // namespace

void startProvisioningPortal()
{
    const String apName = "SmartMeter-" + getDeviceId();

    Serial.println("No WiFi credentials — starting provisioning AP: " + apName);
    oledShowProvisioning(apName);

    WiFi.mode(WIFI_AP);
    WiFi.softAP(apName.c_str());

    // Cached once, reused for every page load below.
    const String portalHtml = buildPortalHtml(getDeviceId(), scanNetworksOptionsHtml());

    DNSServer dnsServer;
    // Redirects every DNS lookup to us, including the connectivity-check
    // domains iOS/Android/Windows probe automatically — that's what makes
    // "sign in to network" pop up on its own after joining the AP.
    dnsServer.start(53, "*", WiFi.softAPIP());

    AsyncWebServer server(80);

    server.on("/", HTTP_GET, [portalHtml](AsyncWebServerRequest *request) {
        request->send(200, "text/html", portalHtml);
    });

    server.on("/save", HTTP_POST, [](AsyncWebServerRequest *request) {
        if (!request->hasParam("ssid", true) || request->getParam("ssid", true)->value().length() == 0)
        {
            request->send(400, "text/plain", "SSID tidak boleh kosong");
            return;
        }

        const String ssid = request->getParam("ssid", true)->value();
        const String password = request->hasParam("password", true)
                                     ? request->getParam("password", true)->value()
                                     : "";

        saveWifiCredentials(ssid, password);

        request->send(200, "text/html", SAVED_HTML);

        delay(1000);
        ESP.restart();
    });

    // Catch-all so any URL a phone/laptop happens to probe (not just "/")
    // still lands on the form — same captive-portal trick as the DNS
    // redirect above, belt and suspenders.
    server.onNotFound([portalHtml](AsyncWebServerRequest *request) {
        request->send(200, "text/html", portalHtml);
    });

    server.begin();

    // Only exits via the ESP.restart() in the /save handler above.
    while (true)
    {
        dnsServer.processNextRequest();
        delay(10);
    }
}
