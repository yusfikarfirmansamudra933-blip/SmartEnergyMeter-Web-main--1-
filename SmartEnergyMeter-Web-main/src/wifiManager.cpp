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

    if(WiFi.status()==WL_CONNECTED)
        return;

    if (strlen(WIFI_SSID) == 0 || millis() - reconnectMillis < RECONNECT_INTERVAL_MS)
        return;

    reconnectMillis=millis();

    Serial.println("Reconnect WiFi");

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
