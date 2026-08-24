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
}