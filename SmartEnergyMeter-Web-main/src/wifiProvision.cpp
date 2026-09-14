#include "wifiProvision.h"

#include <Arduino.h>
#include <WiFi.h>
#include <DNSServer.h>
#include <ESPAsyncWebServer.h>
#include <ArduinoJson.h>
#include <esp_system.h>

#include "oled.h"
#include "storage.h"
#include "webServer.h"

namespace {
constexpr byte DNS_PORT = 53;
constexpr uint16_t PORTAL_PORT = 80;
// How long a single connection attempt to the chosen network is allowed to
// take before /connect reports failure back to the browser and the portal
// stays open for another try.
constexpr unsigned long CONNECT_TIMEOUT_MS = 15000;

const char *AP_SSID = "SmartMeter-Setup";

// Random each time setup mode is entered, shown only on the device's own
// OLED — so joining this network requires standing in front of the physical
// device, rather than just being somewhere within WiFi range of it.
char apPassword[9];

void generateApPassword()
{
    // esp_random() is the hardware RNG, not seeded from anything predictable
    // like millis() — unlike a fixed/compiled password, this can't leak by
    // reading the firmware or the public source.
    snprintf(apPassword, sizeof(apPassword), "%08u", (unsigned int)(esp_random() % 100000000UL));
}

DNSServer dnsServer;
AsyncWebServer portalServer(PORTAL_PORT);
volatile bool provisioned = false;

const char PORTAL_HTML[] PROGMEM = R"HTML(<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Setup Smart Energy Meter</title>
<style>
body{font-family:sans-serif;max-width:420px;margin:24px auto;padding:0 16px;color:#222}
h1{font-size:20px}
select,input,button{width:100%;box-sizing:border-box;padding:10px;margin:8px 0;font-size:16px}
button{background:#2563eb;color:#fff;border:none;border-radius:6px}
button:disabled{background:#9ca3af}
#status{margin-top:12px;font-size:14px}
</style></head><body>
<h1>Sambungkan ke WiFi rumah Anda</h1>
<select id="ssid"><option>Memindai jaringan...</option></select>
<input type="password" id="password" placeholder="Password WiFi">
<button id="btn" onclick="connect()">Sambungkan</button>
<div id="status"></div>
<script>
fetch('/scan').then(r=>r.json()).then(list=>{
  const sel=document.getElementById('ssid');
  sel.innerHTML='';
  if(!list.length){ sel.innerHTML='<option value="">Tidak ada jaringan ditemukan</option>'; return; }
  list.sort((a,b)=>b.rssi-a.rssi).forEach(n=>{
    const o=document.createElement('option');
    o.value=n.ssid; o.textContent=n.ssid+' ('+n.rssi+' dBm)'+(n.open?' - terbuka':'');
    sel.appendChild(o);
  });
});
function connect(){
  const ssid=document.getElementById('ssid').value;
  const password=document.getElementById('password').value;
  if(!ssid){ document.getElementById('status').textContent='Pilih WiFi dulu.'; return; }
  const btn=document.getElementById('btn');
  btn.disabled=true;
  document.getElementById('status').textContent='Menghubungkan, tunggu sebentar...';
  fetch('/connect?ssid='+encodeURIComponent(ssid)+'&password='+encodeURIComponent(password))
    .then(r=>r.text()).then(t=>{
      document.getElementById('status').textContent=t;
      btn.disabled=false;
    }).catch(()=>{
      document.getElementById('status').textContent='Gagal menghubungi perangkat, coba lagi.';
      btn.disabled=false;
    });
}
</script></body></html>
)HTML";

// WiFi.scanNetworks() is blocking, which is fine here — the whole portal is
// already a blocking detour taken before the rest of setup() runs.
String scanNetworksJson()
{
    const int n = WiFi.scanNetworks();

    StaticJsonDocument<1536> doc;
    JsonArray arr = doc.to<JsonArray>();

    for (int i = 0; i < n && i < 40; i++)
    {
        // Access points repeat their SSID on every channel/band they use —
        // without this the list shows the same home network two or three
        // times, which is confusing rather than useful here.
        bool duplicate = false;
        for (JsonObject existing : arr)
        {
            if (existing["ssid"] == WiFi.SSID(i))
            {
                duplicate = true;
                break;
            }
        }
        if (duplicate)
        {
            continue;
        }

        JsonObject o = arr.createNestedObject();
        o["ssid"] = WiFi.SSID(i);
        o["rssi"] = WiFi.RSSI(i);
        o["open"] = (WiFi.encryptionType(i) == WIFI_AUTH_OPEN);
    }

    String out;
    serializeJson(doc, out);
    return out;
}

void handleScan(AsyncWebServerRequest *request)
{
    request->send(200, "application/json", scanNetworksJson());
}

void handleConnect(AsyncWebServerRequest *request)
{
    if (!request->hasParam("ssid"))
    {
        request->send(400, "text/plain", "SSID kosong.");
        return;
    }

    const String ssid = request->getParam("ssid")->value();
    const String password = request->hasParam("password") ? request->getParam("password")->value() : "";

    Serial.printf("Mencoba konek ke WiFi terpilih: \"%s\"\n", ssid.c_str());

    WiFi.begin(ssid.c_str(), password.c_str());

    const unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < CONNECT_TIMEOUT_MS)
    {
        delay(250);
    }

    if (WiFi.status() != WL_CONNECTED)
    {
        Serial.println("Gagal konek ke WiFi yang dipilih.");
        WiFi.disconnect();
        request->send(200, "text/plain", "Gagal konek. Periksa password, atau sinyal terlalu lemah. Coba lagi.");
        return;
    }

    Serial.println("Berhasil konek, menyimpan kredensial...");
    saveWifiCredentials(ssid, password);
    request->send(200, "text/plain", "Berhasil! Perangkat akan restart dan tersambung otomatis.");

    // Read by the main loop below, which then restarts the device — done
    // here rather than restarting inline so the HTTP response above has a
    // chance to actually reach the browser first.
    provisioned = true;
}

// Any request the portal doesn't specifically handle — including the probe
// URLs phones/laptops fire off to detect a captive portal — gets the setup
// page itself. Combined with the DNS server below (which resolves every
// hostname to this device), that's what makes the "sign in to network"
// popup show up automatically instead of the user having to know an IP.
void handleCaptivePortal(AsyncWebServerRequest *request)
{
    request->send_P(200, "text/html", PORTAL_HTML);
}
}  // namespace

void wifiProvisionBegin()
{
    generateApPassword();

    Serial.println("===== MODE SETUP WIFI =====");
    Serial.printf("Sambungkan HP/laptop ke WiFi \"%s\", PIN: %s\n", AP_SSID, apPassword);
    oledShowProvisioning(apPassword);

    // Only relevant when the button was held during normal operation (not
    // at first boot) — the dashboard's own AsyncWebServer is already bound
    // to port 80 at that point and would otherwise silently win every
    // request over the portal server below, since both are bound to all
    // interfaces and nothing distinguishes "arrived via the AP" from
    // "arrived via the home network" at the TCP level.
    webServerEnd();

    // AP_STA (not just AP): the device stays reachable over its own setup
    // network for repeated attempts while /connect tries the chosen network
    // as a station in the background.
    WiFi.mode(WIFI_AP_STA);
    WiFi.softAP(AP_SSID, apPassword);

    dnsServer.start(DNS_PORT, "*", WiFi.softAPIP());

    portalServer.on("/scan", HTTP_GET, handleScan);
    portalServer.on("/connect", HTTP_GET, handleConnect);
    portalServer.on("/", HTTP_GET, handleCaptivePortal);
    portalServer.onNotFound(handleCaptivePortal);
    portalServer.begin();

    while (!provisioned)
    {
        dnsServer.processNextRequest();
        delay(10);
    }

    portalServer.end();
    dnsServer.stop();

    delay(1500);
    ESP.restart();
}
