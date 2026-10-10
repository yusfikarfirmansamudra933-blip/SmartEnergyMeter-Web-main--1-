#include "deviceId.h"

const char *deviceId()
{
    static char id[11] = "";

    if (id[0] == '\0')
    {
        // Factory base MAC, byte 0 in the lowest bits.
        const uint64_t mac = ESP.getEfuseMac();
        snprintf(id, sizeof(id), "sem-%02x%02x%02x",
                 (unsigned)((mac >> 24) & 0xFF),
                 (unsigned)((mac >> 32) & 0xFF),
                 (unsigned)((mac >> 40) & 0xFF));
    }

    return id;
}

String deviceTopic(const char *suffix)
{
    String topic = "smartmeter/";
    topic += deviceId();
    topic += '/';
    topic += suffix;
    return topic;
}
