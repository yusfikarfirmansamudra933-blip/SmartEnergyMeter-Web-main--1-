#ifndef WIFI_MANAGER_H
#define WIFI_MANAGER_H

#include <Arduino.h>

void wifiBegin();

void wifiLoop();

bool wifiConnected();

String getIPAddress();

int wifiRSSI();

String wifiSSID();

#endif