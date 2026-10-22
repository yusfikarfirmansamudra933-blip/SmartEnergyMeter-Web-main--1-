#include "cloudOta.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <Update.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <mbedtls/aes.h>
#include <mbedtls/md.h>

#include "config.h"
#include "deviceId.h"
#include "mqtt.h"
#include "oled.h"
#include "otaRoots.h"
#include "storage.h"

namespace {

// First check a little after boot (WiFi and MQTT settle first), then every
// 6 hours: an update reaches every unit within a working day.
constexpr unsigned long FIRST_CHECK_MS = 2UL * 60 * 1000;
constexpr unsigned long CHECK_INTERVAL_MS = 6UL * 60 * 60 * 1000;

// A new firmware that got WiFi but has not reached the broker by now is
// rolled back: without MQTT it could never receive the next fix either.
constexpr unsigned long CLOUD_VERIFY_TIMEOUT_MS = 5UL * 60 * 1000;

// A stalled download is abandoned after this long without a byte.
constexpr unsigned long STALL_TIMEOUT_MS = 20000;

Preferences otaPrefs;
unsigned long nextCheckAt = FIRST_CHECK_MS;
bool forceCheck = false;

// Copy of the NVS "pending verify" flag, read once at boot instead of on every loop.
bool verifyPending = false;

// The last state, kept until it could be published (the broker may be
// unreachable when a check fails).
String pendingState;

struct Manifest
{
    String version;
    String file;
    size_t size = 0;
    uint8_t iv[16];
    uint8_t mac[32];
};

bool otaEnabled()
{
    return strlen(OTA_KEY) > 0;
}

void setState(const char *state, const String &version, const String &error = "")
{
    StaticJsonDocument<256> doc;
    doc["state"] = state;
    doc["version"] = version;
    if (error.length())
    {
        doc["error"] = error;
    }
    pendingState = "";
    serializeJson(doc, pendingState);
    Serial.printf("Cloud OTA: %s\n", pendingState.c_str());
}

void flushState()
{
    if (pendingState.length() && mqttPublishRetained(deviceTopic("ota").c_str(), pendingState))
    {
        pendingState = "";
    }
}

// "1.17.0" -> 1017000, so versions compare as plain numbers. 0 when unparsable.
uint32_t versionNumber(const String &v)
{
    unsigned major = 0, minor = 0, patch = 0;
    if (sscanf(v.c_str(), "%u.%u.%u", &major, &minor, &patch) != 3)
    {
        return 0;
    }
    return major * 1000000UL + minor * 1000UL + patch;
}

bool parseHex(const char *hex, uint8_t *out, size_t len)
{
    if (!hex || strlen(hex) != len * 2)
    {
        return false;
    }
    for (size_t i = 0; i < len; i++)
    {
        char byteText[3] = {hex[i * 2], hex[i * 2 + 1], 0};
        char *end = nullptr;
        out[i] = (uint8_t)strtoul(byteText, &end, 16);
        if (*end)
        {
            return false;
        }
    }
    return true;
}

// Separate keys for encryption and signing, both derived from OTA_KEY the
// same way release-firmware.js does.
void deriveKey(const char *label, uint8_t out[32])
{
    mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256),
                    (const uint8_t *)OTA_KEY, strlen(OTA_KEY),
                    (const uint8_t *)label, strlen(label), out);
}

bool fetchManifest(Manifest &m, String &error)
{
    WiFiClientSecure client;
    client.setCACert(OTA_ROOT_CAS);
    HTTPClient http;
    if (!http.begin(client, String(OTA_BASE_URL) + "latest.json"))
    {
        error = "Alamat update tidak valid";
        return false;
    }
    http.setTimeout(15000);
    const int code = http.GET();
    if (code == HTTP_CODE_NOT_FOUND)
    {
        // Nothing released yet: same as being up to date.
        http.end();
        m.version = "";
        return true;
    }
    if (code != HTTP_CODE_OK)
    {
        error = "latest.json: HTTP " + String(code);
        http.end();
        return false;
    }

    DynamicJsonDocument doc(2048);
    const DeserializationError parseError = deserializeJson(doc, http.getString());
    http.end();
    if (parseError)
    {
        error = "latest.json tidak terbaca";
        return false;
    }

    // An optional list limits a release to some units, e.g. your own first.
    JsonArray only = doc["devices"].as<JsonArray>();
    if (!only.isNull())
    {
        bool listed = false;
        for (JsonVariant id : only)
        {
            listed = listed || strcmp(id | "", deviceId()) == 0;
        }
        if (!listed)
        {
            m.version = "";
            return true;
        }
    }

    m.version = doc["version"] | "";
    m.file = doc["file"] | "";
    m.size = doc["size"] | 0;
    // A bare file name only: the download never leaves OTA_BASE_URL.
    if (!versionNumber(m.version) || !m.file.length() || m.file.indexOf('/') >= 0 ||
        m.size == 0 || !parseHex(doc["iv"] | "", m.iv, 16) || !parseHex(doc["mac"] | "", m.mac, 32))
    {
        error = "latest.json tidak lengkap";
        return false;
    }
    return true;
}

// Downloads, decrypts and flashes the release, checking the signature over
// the version and the whole file before the new partition is made bootable.
// Returns only on failure; success restarts into the new firmware.
void install(const Manifest &m)
{
    setState("downloading", m.version);
    flushState();
    // One TLS session at a time: frees the broker's memory for the download.
    mqttSuspend();

    WiFiClientSecure client;
    client.setCACert(OTA_ROOT_CAS);
    HTTPClient http;
    http.begin(client, String(OTA_BASE_URL) + m.file);
    http.setTimeout(15000);
    const int code = http.GET();
    if (code != HTTP_CODE_OK || (size_t)http.getSize() != m.size)
    {
        setState("failed", m.version, code == HTTP_CODE_OK ? "Ukuran file tidak cocok" : "Unduh gagal: HTTP " + String(code));
        http.end();
        return;
    }

    if (!Update.begin(m.size, U_FLASH))
    {
        setState("failed", m.version, "Update.begin: " + String(Update.errorString()));
        http.end();
        return;
    }
    oledOtaProgress(0);

    uint8_t encKey[32], macKey[32];
    deriveKey("sem-ota-enc", encKey);
    deriveKey("sem-ota-mac", macKey);

    mbedtls_aes_context aes;
    mbedtls_aes_init(&aes);
    mbedtls_aes_setkey_enc(&aes, encKey, 256);
    uint8_t counter[16], streamBlock[16];
    memcpy(counter, m.iv, 16);
    size_t counterOffset = 0;

    mbedtls_md_context_t hmac;
    mbedtls_md_init(&hmac);
    mbedtls_md_setup(&hmac, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
    mbedtls_md_hmac_starts(&hmac, macKey, sizeof macKey);
    mbedtls_md_hmac_update(&hmac, (const uint8_t *)m.version.c_str(), m.version.length() + 1);  // with the '\0'
    mbedtls_md_hmac_update(&hmac, m.iv, 16);

    static uint8_t buf[2048];
    WiFiClient *stream = http.getStreamPtr();
    size_t done = 0;
    unsigned long lastByteAt = millis();
    String error;

    while (done < m.size)
    {
        const size_t available = stream->available();
        if (!available)
        {
            if (!http.connected() || millis() - lastByteAt > STALL_TIMEOUT_MS)
            {
                error = "Unduhan terputus";
                break;
            }
            delay(5);
            continue;
        }
        const size_t n = stream->readBytes(buf, min(min(available, sizeof buf), m.size - done));
        lastByteAt = millis();
        mbedtls_md_hmac_update(&hmac, buf, n);
        mbedtls_aes_crypt_ctr(&aes, n, &counterOffset, counter, streamBlock, buf, buf);
        if (Update.write(buf, n) != n)
        {
            error = "Tulis flash gagal: " + String(Update.errorString());
            break;
        }
        done += n;
        oledOtaProgress((uint8_t)(done * 100 / m.size));
        oledLoop();
    }
    http.end();

    uint8_t mac[32];
    mbedtls_md_hmac_finish(&hmac, mac);
    mbedtls_md_free(&hmac);
    mbedtls_aes_free(&aes);

    if (!error.length() && memcmp(mac, m.mac, sizeof mac) != 0)
    {
        error = "Tanda tangan firmware tidak cocok";
    }
    if (!error.length() && !Update.end())
    {
        error = "Update.end: " + String(Update.errorString());
    }
    if (error.length())
    {
        Update.abort();
        oledOtaResult(false);
        setState("failed", m.version, error);
        return;
    }

    // Read back on the next boot (see cloudOtaBegin) to report the outcome,
    // and main.cpp's verify step rolls back a build that cannot get online.
    otaPrefs.putString("target", m.version);
    markOtaPendingVerify();
    oledOtaResult(true);
    oledLoop();
    Serial.println("Cloud OTA selesai, restart...");
    delay(1500);
    ESP.restart();
}

void check()
{
    const bool force = forceCheck;
    forceCheck = false;

    Manifest m;
    String error;
    if (!fetchManifest(m, error))
    {
        setState("failed", "", error);
        return;
    }
    if (!m.version.length() || versionNumber(m.version) <= versionNumber(FIRMWARE_VERSION))
    {
        setState("current", FIRMWARE_VERSION);
        return;
    }
    // Rolled back once already: wait for a newer release or an explicit retry.
    if (!force && otaPrefs.getString("bad", "") == m.version)
    {
        setState("failed", m.version, "Versi ini gagal dipasang sebelumnya");
        return;
    }
    install(m);
}

}  // namespace

void cloudOtaBegin()
{
    otaPrefs.begin("ota", false);
    verifyPending = isOtaPendingVerify();

    // Set just before restarting into a cloud update. Running anything else
    // now means the bootloader or the verify step went back to this build.
    const String target = otaPrefs.getString("target", "");
    if (target.length())
    {
        otaPrefs.remove("target");
        if (target == FIRMWARE_VERSION)
        {
            otaPrefs.remove("bad");
            setState("updated", target);
        }
        else
        {
            otaPrefs.putString("bad", target);
            setState("failed", target, "Firmware baru tidak bisa online, kembali ke " FIRMWARE_VERSION);
        }
    }

    if (!otaEnabled())
    {
        Serial.println("Cloud OTA mati: OTA_KEY belum diisi");
    }
}

void cloudOtaRequestCheck()
{
    forceCheck = true;
    nextCheckAt = millis();
}

void cloudOtaLoop()
{
    // Second half of main.cpp's verifyOtaOrRollBack(): WiFi came up there,
    // now the broker must too.
    if (verifyPending)
    {
        if (mqttConnected())
        {
            verifyPending = false;
            clearOtaPendingVerify();
            Serial.println("OTA verified: MQTT connected.");
        }
        else if (millis() > CLOUD_VERIFY_TIMEOUT_MS)
        {
            verifyPending = false;
            clearOtaPendingVerify();
            if (Update.canRollBack() && Update.rollBack())
            {
                Serial.println("OTA verify FAILED: no MQTT. Rolling back...");
                oledOtaVerifyScreen("Rollback! Restarting...");
                delay(1500);
                ESP.restart();
            }
        }
        // No update checks until this build is trusted.
        return;
    }

    if (mqttConnected())
    {
        flushState();
    }

    if (!otaEnabled() || WiFi.status() != WL_CONNECTED || (long)(millis() - nextCheckAt) < 0)
    {
        return;
    }
    nextCheckAt = millis() + CHECK_INTERVAL_MS;
    check();
}
