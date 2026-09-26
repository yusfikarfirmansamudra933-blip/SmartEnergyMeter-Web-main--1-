#ifndef HISTORY_H
#define HISTORY_H

// One-minute averages of the live readings for the last hour, published
// retained on smartmeter/history so the cloud dashboard can draw the full
// hour as soon as it opens. A minute with no readings (standby, sensor
// offline) is kept as a gap rather than a made-up value.

// Called after every successful PZEM read and every valid chip temperature
// read, feeding the minute that is currently being averaged.
void historyAddPzemSample();
void historyAddChipSample();

// Closes the current minute when it is over and publishes the hour.
void historyLoop();

#endif
