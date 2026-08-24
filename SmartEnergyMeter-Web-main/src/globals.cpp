#include "globals.h"

float voltage = 0;
float current = 0;
float power = 0;
float energy = 0;
float frequency = 0;
float pf = 0;

float apparentPower = 0;
float reactivePower = 0;

float powerLimit = 700;

bool overload = false;
bool sensorOnline = false;

uint32_t pzemReadCount = 0;
uint32_t pzemErrorCount = 0;

uint8_t signalQuality = 100;

unsigned long sensorTimer = 0;
unsigned long oledTimer = 0;

int powerPercent = 0;

uint32_t overloadCount = 0;