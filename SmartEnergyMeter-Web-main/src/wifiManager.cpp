#include "wifiManager.h"

#include <WiFi.h>
#include <cstring>

#include "config.h"
#include "storage.h"
#include "wifiProvision.h"

namespace {
constexpr unsigned long RECONNECT_INTERVAL_MS = 5000;
unsigned long reconnectMillis = 0;

// Resolved once in wifiBegin() (stored credentials from a previous portal
// run, else the compiled config.local.h ones) and reused by wifiLoop()'s
// reconnect — so both agree on what "the" credentials are regardless of
// which source they actually came from.
String resolvedSsid;
String resolvedPassword;
}

void wifiBegin()
{
    WiFi.mode(WIFI_STA);

    WiFi.setAutoReconnect(true);

    resolvedSsid = getStoredWifiSsid();
    resolvedPassword = getStoredWifiPassword();

    if (resolvedSsid.length() == 0)
    {
        if (strlen(WIFI_SSID) > 0)
        {
            // Backward compatible: a unit built the old way, with
            // credentials compiled into config.local.h, keeps working
            // exactly as before.
            resolvedSsid = WIFI_SSID;
            resolvedPassword = WIFI_PASSWORD;
        }
        else
        {
            // No credentials anywhere — the recommended setup for any new
            // unit going forward (leave config.local.h's WIFI_SSID empty).
            // Blocks until the portal form is submitted, then reboots.
            startProvisioningPortal();
            return;  // unreachable
        }
    }

    WiFi.begin(resolvedSsid.c_str(), resolvedPassword.c_str());
    Serial.println("Connecting to WiFi");

}

void wifiLoop()
{
    static bool ipPrinted = false;

    if(WiFi.status()==WL_CONNECTED)
    {
        if (!ipPrinted)
        {
            Serial.print("WiFi connected, dashboard IP: ");
            Serial.println(WiFi.localIP());
            ipPrinted = true;
        }
        return;
    }

    ipPrinted = false;

    if (resolvedSsid.length() == 0 || millis() - reconnectMillis < RECONNECT_INTERVAL_MS)
        return;

    reconnectMillis=millis();

    Serial.printf("Reconnect WiFi (status=%d, ssid=\"%s\")\n", WiFi.status(), resolvedSsid.c_str());

    WiFi.disconnect();

    WiFi.begin(resolvedSsid.c_str(), resolvedPassword.c_str());

}

bool wifiConnected()
{
    return WiFi.status()==WL_CONNECTED;
}

String getIPAddress()
{
    return WiFi.localIP().toString();
}

int wifiRSSI()
{
    return WiFi.RSSI();
}

String wifiSSID()
{
    return WiFi.SSID();
}

String getDeviceId()
{
    if (strlen(DEVICE_ID) > 0)
    {
        return String(DEVICE_ID);
    }

    String mac = WiFi.macAddress();
    mac.replace(":", "");
    mac.toLowerCase();

    // Last 3 bytes (6 hex chars) — the NIC-specific part, so devices from
    // the same manufacturing batch (same OUI prefix) still get distinct
    // ids without needing the full 12-char address.
    return mac.substring(6);
}
