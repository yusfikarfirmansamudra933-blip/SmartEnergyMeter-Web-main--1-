#include "wifiManager.h"

#include <WiFi.h>
#include <cstring>

#include "config.h"
#include "storage.h"

namespace {
constexpr unsigned long RECONNECT_INTERVAL_MS = 5000;
unsigned long reconnectMillis = 0;

// Credentials saved through the setup portal (wifiProvision.cpp) always win
// over the compiled config.local.h defaults — that lets a device provisioned
// over WiFi keep working even if it's later reflashed with a build that has
// no WIFI_SSID compiled in at all.
String activeSsid;
String activePassword;
}

void wifiBegin()
{
    WiFi.mode(WIFI_STA);

    WiFi.setAutoReconnect(true);

    if (hasStoredWifiCredentials())
    {
        activeSsid = getStoredWifiSsid();
        activePassword = getStoredWifiPassword();
    }
    else if (strlen(WIFI_SSID) > 0)
    {
        activeSsid = WIFI_SSID;
        activePassword = WIFI_PASSWORD;
    }

    if (activeSsid.length() == 0)
    {
        Serial.println("WiFi credentials are not configured");
        return;
    }

    WiFi.begin(activeSsid.c_str(), activePassword.c_str());
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

    if (activeSsid.length() == 0 || millis() - reconnectMillis < RECONNECT_INTERVAL_MS)
        return;

    reconnectMillis=millis();

    Serial.printf("Reconnect WiFi (status=%d, ssid=\"%s\")\n", WiFi.status(), activeSsid.c_str());

    WiFi.disconnect();

    WiFi.begin(activeSsid.c_str(), activePassword.c_str());

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
