#ifndef WIFI_PROVISION_H
#define WIFI_PROVISION_H

// Blocks (like the OTA verify check in main.cpp) until the user has picked a
// WiFi network from the setup portal and the device has connected to it
// successfully — then restarts the device on its own, so this never returns
// normally. Only call from setup(), before wifiBegin()/mqttBegin()/
// webServerBegin() start.
void wifiProvisionBegin();

#endif
