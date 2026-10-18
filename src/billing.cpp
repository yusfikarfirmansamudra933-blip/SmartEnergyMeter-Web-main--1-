#include "billing.h"

#include <Preferences.h>
#include <time.h>

#include "config.h"
#include "globals.h"

bool billingValid = false;
float billingWeekRp = 0;
float billingMonthRp = 0;
float electricityRate = ELECTRICITY_RATE;

namespace
{
constexpr long WIB_OFFSET_SEC = 7 * 3600;
constexpr time_t MIN_VALID_EPOCH = 1700000000;  // clock counts as synced after ~Nov 2023
constexpr unsigned long BILLING_INTERVAL_MS = 10000;

Preferences prefs;

int32_t monthKey = 0;   // yyyymm the stored start belongs to
int32_t weekKey = 0;    // yyyymm*10 + week-of-month
float monthStart = 0;   // kWh counter at the start of that month
float weekStart = 0;
unsigned long lastRun = 0;

void save()
{
    prefs.begin("billing", false);
    prefs.putInt("monthKey", monthKey);
    prefs.putInt("weekKey", weekKey);
    prefs.putFloat("monthStart", monthStart);
    prefs.putFloat("weekStart", weekStart);
    prefs.end();
}

void load()
{
    prefs.begin("billing", true);
    monthKey = prefs.getInt("monthKey", 0);
    weekKey = prefs.getInt("weekKey", 0);
    monthStart = prefs.getFloat("monthStart", 0);
    weekStart = prefs.getFloat("weekStart", 0);
    electricityRate = prefs.getFloat("rate", ELECTRICITY_RATE);
    prefs.end();
}
}  // namespace

void billingBegin()
{
    // WIB, no DST. Starts in the background; billingLoop() waits for it.
    configTime(WIB_OFFSET_SEC, 0, "pool.ntp.org", "time.google.com");
    load();
}

void billingLoop()
{
    if (millis() - lastRun < BILLING_INTERVAL_MS)
        return;
    lastRun = millis();

    time_t now = time(nullptr);
    if (now < MIN_VALID_EPOCH || !sensorOnline || isnan(energy) || energy < 0)
        return;

    struct tm t;
    // time() is UTC; configTime() only sets the timezone, which localtime_r
    // applies. gmtime_r here would put week/month boundaries at 07:00 WIB.
    localtime_r(&now, &t);

    int32_t curMonth = (t.tm_year + 1900) * 100 + (t.tm_mon + 1);
    int week = min((t.tm_mday - 1) / 7 + 1, 5);
    int32_t curWeek = curMonth * 10 + week;

    bool changed = false;

    if (curMonth != monthKey)
    {
        monthKey = curMonth;
        monthStart = energy;
        changed = true;
    }
    if (curWeek != weekKey)
    {
        weekKey = curWeek;
        weekStart = energy;
        changed = true;
    }
    // The PZEM counter went backwards (its energy was reset): restart the
    // period from here instead of showing a negative bill.
    if (energy < monthStart)
    {
        monthStart = energy;
        changed = true;
    }
    if (energy < weekStart)
    {
        weekStart = energy;
        changed = true;
    }

    if (changed)
        save();

    // The whole period at the current rate: after a mid-month tariff change
    // this is an estimate. The cloud bill keeps each day at its own rate.
    billingWeekRp = (energy - weekStart) * electricityRate;
    billingMonthRp = (energy - monthStart) * electricityRate;
    billingValid = true;
}

bool billingSetRate(float rate)
{
    if (isnan(rate) || rate < 100 || rate > 5000 || rate == electricityRate)
        return false;

    electricityRate = rate;
    prefs.begin("billing", false);
    prefs.putFloat("rate", rate);
    prefs.end();
    // Recompute on the next loop instead of waiting out the interval.
    lastRun = millis() - BILLING_INTERVAL_MS;
    return true;
}
