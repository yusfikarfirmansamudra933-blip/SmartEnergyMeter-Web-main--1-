#ifndef STORAGE_H
#define STORAGE_H

void storageBegin();

void loadConfig();

void saveConfig();

void resetConfig();

void saveLimit(float value);

// Survives a reboot (stored in NVS via Preferences) so the OTA rollback
// check in main.cpp's setup() can tell "just flashed, unverified" apart
// from every other boot — including a boot after rollBack() itself, since
// that's cleared before the rollback restart happens.
bool isOtaPendingVerify();

void markOtaPendingVerify();

void clearOtaPendingVerify();

#endif