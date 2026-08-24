#include "pzem.h"

#include <Arduino.h>
#include <PZEM004Tv30.h>

#include "config.h"
#include "globals.h"

HardwareSerial PZEMSerial(2);

PZEM004Tv30 pzem(PZEMSerial, PZEM_RX, PZEM_TX);

//======================================================

void pzemBegin()
{
    PZEMSerial.begin(
        9600,
        SERIAL_8N1,
        PZEM_RX,
        PZEM_TX
    );
}

//======================================================

void readPZEM()
{
    float v = pzem.voltage();
    float i = pzem.current();
    float p = pzem.power();
    float e = pzem.energy();
    float f = pzem.frequency();
    float pfValue = pzem.pf();

    // -----------------------------
    // Validasi Sensor
    // -----------------------------

    if (isnan(v) || isnan(i) || isnan(p) || isnan(e) || isnan(f) || isnan(pfValue))
    {
        sensorOnline = false;
        pzemErrorCount++;
        return;
    }

    sensorOnline = true;
    pzemReadCount++;

    voltage = v;
    current = i;
    power = p;
    energy = e;
    frequency = f;
    pf = pfValue;

    voltage = max(voltage, 0.0f);
    current = max(current, 0.0f);
    power = max(power, 0.0f);
    energy = max(energy, 0.0f);
    frequency = max(frequency, 0.0f);
    pf = max(pf, 0.0f);

    // PF maksimum 1.0
    pf = min(pf, 1.0f);

    apparentPower = voltage * current;
    reactivePower = sqrt(max(0.0f, apparentPower * apparentPower - power * power));

}
