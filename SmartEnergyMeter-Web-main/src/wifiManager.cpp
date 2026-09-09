#include "wifiManager.h"

#include <WiFi.h>
#include <cstring>

#include "config.h"

namespace {
constexpr unsigned long RECONNECT_INTERVAL_MS = 5000;
unsigned long reconnectMillis = 0;
}

void wifiBegin()
{
    WiFi.mode(WIFI_STA);

    WiFi.setAutoReconnect(true);

    if (strlen(WIFI_SSID) == 0)
    {
        Serial.println("WiFi credentials are not configured");
        return;
    }

    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
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

    if (strlen(WIFI_SSID) == 0 || millis() - reconnectMillis < RECONNECT_INTERVAL_MS)
        return;

    reconnectMillis=millis();

    Serial.printf("Reconnect WiFi (status=%d, ssid=\"%s\")\n", WiFi.status(), WIFI_SSID);

    WiFi.disconnect();

    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

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
