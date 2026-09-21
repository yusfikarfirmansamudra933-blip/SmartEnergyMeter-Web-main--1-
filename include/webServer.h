#ifndef WEB_SERVER_H
#define WEB_SERVER_H

void webServerBegin();

// Frees port 80 so wifiProvisionBegin()'s own setup-portal server can bind
// to it — both this dashboard and the portal are AsyncWebServer instances,
// and only one can own the port at a time. Only meaningful if webServerBegin()
// already ran (holding BOOT after normal boot); a no-op otherwise.
void webServerEnd();

void webServerLoop();

void notifyClients();

#endif