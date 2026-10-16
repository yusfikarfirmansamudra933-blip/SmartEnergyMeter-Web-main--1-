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
bool standby = false;

float chipTemperature = 0;
bool chipTempValid = false;

unsigned long sensorTimer = 0;
unsigned long chipTempTimer = 0;