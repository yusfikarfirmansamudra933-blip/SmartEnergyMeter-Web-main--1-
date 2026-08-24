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

void oledLoop()
{

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