#include "oled.h"

#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <WiFi.h>

#include "globals.h"
#include "wifiManager.h"

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 32

Adafruit_SSD1306 display(
SCREEN_WIDTH,
SCREEN_HEIGHT,
&Wire,
-1);

uint8_t page=0;

unsigned long pageMillis=0;

// oledOtaProgress()/oledOtaResult() are called from the OTA upload handler,
// which runs on AsyncWebServer's own task — NOT the main loop() task. They
// must only touch these plain variables and never the I2C display directly:
// an earlier version drew straight from that handler and it reliably reset
// the board mid-upload (SSD1306 I2C writes block for a few ms each, and
// enough of them piling up on the network task starved the idle-task
// watchdog on that core). oledLoop(), which runs on the main task, is the
// only place allowed to actually call display.* — see the otaActive branch
// at the top of oledLoop() below.
bool otaActive=false;
uint8_t otaPercent=0;
bool otaResultPending=false;
bool otaResultSuccess=false;

void drawHeader(String title)
{

display.fillRect(0,0,128,9,WHITE);

display.setTextColor(BLACK);

display.setCursor(2,1);

display.print(title);

display.setTextColor(WHITE);

}

void oledBegin()
{

display.begin(
SSD1306_SWITCHCAPVCC,
0x3C);

display.clearDisplay();

display.display();

}

void oledSplash()
{

display.clearDisplay();

display.setTextSize(2);

display.setCursor(8,2);

display.println("SMART");

display.setCursor(18,18);

display.println("METER");

display.display();

delay(2000);

display.setTextSize(1);

}

void page1()
{

drawHeader("Realtime");

display.setCursor(0,12);

display.printf("V: %.1fV",voltage);

display.setCursor(70,12);

display.printf("A: %.2f",current);

display.setCursor(0,23);

display.printf("P: %.0fW",power);

}

void page2()
{

drawHeader("Energy");

display.setCursor(0,12);

display.printf("E: %.3fk",energy);

display.setCursor(70,12);

display.printf("Hz:%.1f",frequency);

display.setCursor(0,23);

display.printf("PF: %.2f",pf);

}

void page3()
{

drawHeader("Protection");

display.setCursor(0,12);

display.setCursor(70,12);

display.print("WiFi:");

display.print(
wifiConnected()?
"OK":"NO");

display.setCursor(0,23);

display.print("Limit:");

display.print(powerLimit);

}

void page4()
{

drawHeader("System");

display.setCursor(0,12);

display.print(sensorOnline?
"PZEM OK":
"PZEM ERR");

display.setCursor(70,12);

display.print(overload?
"TRIP":
"NORMAL");

display.setCursor(0,23);

display.print(WiFi.localIP());

}

// Fast, non-blocking: only sets state. Safe to call from the OTA upload
// handler's task. The actual I2C drawing happens in oledLoop() instead.
void oledOtaProgress(uint8_t percent)
{

if(percent>100)
percent=100;

otaActive=true;
otaPercent=percent;

}

// Same rule as oledOtaProgress(): just records state, drawn later from
// oledLoop() on the main task.
void oledOtaResult(bool success)
{

otaActive=true;
otaResultPending=true;
otaResultSuccess=success;

}

void drawOtaProgress(uint8_t percent)
{

display.clearDisplay();

display.setTextSize(1);

drawHeader("Update Firmware");

display.setCursor(0,12);

display.printf("Uploading... %u%%",percent);

const int16_t barX=0;
const int16_t barY=23;
const int16_t barW=128;
const int16_t barH=8;

display.drawRect(barX,barY,barW,barH,WHITE);

const int16_t filled=(int16_t)((barW-2)*percent/100);

if(filled>0)
display.fillRect(barX+1,barY+1,filled,barH-2,WHITE);

display.display();

}

void drawOtaResult(bool success)
{

display.clearDisplay();

display.setTextSize(1);

drawHeader("Update Firmware");

display.setCursor(0,12);

display.print(success?"Berhasil!":"Update gagal");

display.setCursor(0,23);

display.print(success?"Merestart...":"Coba lagi ya");

display.display();

}

// Draws directly (see oled.h doc comment) — only ever called from setup(),
// where nothing else is touching the display yet, so there's no need to
// route it through the otaActive state machine the way the other two do.
void oledOtaVerifyScreen(const char *status)
{

display.clearDisplay();

display.setTextSize(1);

drawHeader("Update Firmware");

display.setCursor(0,14);

display.print(status);

display.display();

}

void oledLoop()
{

if(otaActive)
{

static uint8_t lastDrawnPercent=255;
static bool resultDrawn=false;

if(otaResultPending)
{
if(!resultDrawn)
{
drawOtaResult(otaResultSuccess);
resultDrawn=true;

// Success: webServer.cpp restarts the device shortly after calling
// oledOtaResult(), so this screen just needs to stay up till then —
// nothing here resets otaActive, the reboot does that for free.
// Failure: nobody else is going to clear this state, so give the
// user a moment to read it, then hand the display back ourselves.
if(!otaResultSuccess)
{
delay(1500);
otaActive=false;
otaResultPending=false;
resultDrawn=false;
lastDrawnPercent=255;
}

}
return;
}

if(otaPercent!=lastDrawnPercent)
{
lastDrawnPercent=otaPercent;
drawOtaProgress(otaPercent);
}

return;

}

if(
millis()-pageMillis>3000)
{

pageMillis=millis();

page++;

if(page>3)
page=0;

}

display.clearDisplay();

switch(page)
{

case 0:

page1();

break;

case 1:

page2();

break;

case 2:

page3();

break;

case 3:

page4();

break;

}

display.display();

}