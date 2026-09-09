#ifndef WIFI_PROVISION_H
#define WIFI_PROVISION_H

// Starts a SoftAP ("SmartMeter-<deviceId>") plus a captive portal for
// entering WiFi credentials, called from wifiManager.cpp's wifiBegin()
// when no credentials are available anywhere (neither saved via a
// previous portal run nor compiled into config.local.h). Blocks forever —
// the only way out is ESP.restart(), triggered once the submitted form is
// saved (see storage.h's saveWifiCredentials()).
void startProvisioningPortal();

#endif
