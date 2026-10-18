#ifndef BILLING_H
#define BILLING_H

#include <Arduino.h>

// Weekly / monthly cost since the start of the current period, computed from
// the PZEM's cumulative kWh counter. "Week" means week-of-month (days 1-7,
// 8-14, 15-21, 22-28, 29+), the same definition the cloud dashboard uses.
// billingValid is false until NTP has set the clock and a good energy
// reading has been seen — the OLED shows a waiting message until then.
extern bool billingValid;
extern float billingWeekRp;
extern float billingMonthRp;

// Rp/kWh for this unit. Starts at ELECTRICITY_RATE (config.h) and follows
// the tariff class set from the cloud (smartmeter/<id>/billing/tariff); kept
// in NVS so the OLED shows the right bill before MQTT connects.
extern float electricityRate;

void billingBegin();
void billingLoop();

// Ignores values outside 100-5000 Rp/kWh. Returns true when the rate changed.
bool billingSetRate(float rate);

#endif
