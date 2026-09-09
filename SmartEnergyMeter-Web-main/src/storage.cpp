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
    preferences.clear();

    powerLimit = DEFAULT_POWER_LIMIT;

    preferences.putFloat("limit", powerLimit);

    // Factory reset is how a device re-enters "needs pairing" — same
    // moment a genuinely fresh unit would be in before it ever ships. See
    // isPaired()'s doc comment for why the default (key absent) is true.
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
    return preferences.getBool("paired", true);
}

void markPaired()
{
    preferences.putBool("paired", true);
}