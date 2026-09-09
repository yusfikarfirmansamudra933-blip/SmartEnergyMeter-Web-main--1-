#include "storage.h"

#include <Preferences.h>

#include "config.h"
#include "globals.h"

Preferences preferences;

void storageBegin()
{
    Serial.println("Storage Begin");

    preferences.begin("meter", false);

    loadConfig();
}

void loadConfig()
{
    Serial.println("loadConfig() dipanggil");

    powerLimit = preferences.getFloat("limit", DEFAULT_POWER_LIMIT);

    Serial.print("Loaded Limit = ");
    Serial.println(powerLimit);
}

void saveConfig()
{
    preferences.putFloat("limit", powerLimit);
}

void saveLimit(float value)
{
    powerLimit = value;
    preferences.putFloat("limit", value);

    Serial.print("Saved Limit = ");
    Serial.println(powerLimit);
}

void resetConfig()
{
    // Also wipes any saved WiFi credentials (see saveWifiCredentials()) —
    // intentional: factory reset means "forget everything", so the device
    // re-enters both the WiFi provisioning portal and pairing, same state
    // a genuinely fresh unit would be in before it ever ships.
    preferences.clear();

    powerLimit = DEFAULT_POWER_LIMIT;

    preferences.putFloat("limit", powerLimit);

    preferences.putBool("paired", false);
}

bool isOtaPendingVerify()
{
    return preferences.getBool("otaPending", false);
}

void markOtaPendingVerify()
{
    preferences.putBool("otaPending", true);
}

void clearOtaPendingVerify()
{
    preferences.putBool("otaPending", false);
}

bool isPaired()
{
    // Defaulting to false (unset key = not paired) is what makes a
    // genuinely fresh device — blank NVS, first boot ever — show the
    // pairing screen automatically, no factory reset needed first.
    return preferences.getBool("paired", false);
}

void markPaired()
{
    preferences.putBool("paired", true);
}

bool hasStoredWifiCredentials()
{
    return preferences.getString("wifiSsid", "").length() > 0;
}

String getStoredWifiSsid()
{
    return preferences.getString("wifiSsid", "");
}

String getStoredWifiPassword()
{
    return preferences.getString("wifiPass", "");
}

void saveWifiCredentials(const String &ssid, const String &password)
{
    preferences.putString("wifiSsid", ssid);
    preferences.putString("wifiPass", password);
}