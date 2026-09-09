#ifndef OLED_H
#define OLED_H

#include <Arduino.h>
#include <cstdint>

void oledBegin();

void oledSplash();

void oledLoop();

// Takes over the OLED to show OTA upload progress (0-100). Call repeatedly
// as bytes arrive; while active, oledLoop() stops cycling the normal pages
// so the two don't fight over the display.
void oledOtaProgress(uint8_t percent);

// Shows the final OTA outcome, then (only on failure) releases the OLED
// back to oledLoop(). On success the caller restarts the device right after,
// so there is no page cycling to resume.
void oledOtaResult(bool success);

// Draws immediately instead of just setting state, unlike the two above —
// only safe to call from main.cpp's setup(), before oledLoop() is ever
// reachable (the post-OTA rollback check runs synchronously there, so
// there's nothing else contending for the display yet).
void oledOtaVerifyScreen(const char *status);

// Draws directly (see oledOtaVerifyScreen's doc comment) — only ever
// called from wifiProvision.cpp before its captive-portal loop starts,
// which is also before oledLoop() is ever reachable.
void oledShowProvisioning(const String &apName);

#endif