#ifndef CHIP_TEMP_H
#define CHIP_TEMP_H

// Updates chipTemperature / chipTempValid in globals from the ESP32's own
// internal sensor. Cheap enough to call every couple of seconds.
void readChipTemperature();

#endif
