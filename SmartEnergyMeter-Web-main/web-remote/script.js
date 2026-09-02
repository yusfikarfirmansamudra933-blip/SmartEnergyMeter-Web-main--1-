"use strict";

// Cloud broker connection (EMQX Cloud). Read-only user scoped to this public
// dashboard — subscribe-only, cannot publish (see Authorization rule for
// "smartenergymeterweb": deny publish on "#"). Do NOT use the firmware's
// full-access MQTT credentials here, this code is publicly visible.
const MQTT_WS_URL = "wss://l660c516.ala.eu-central-1.emqxsl.com:8084/mqtt";
const MQTT_USERNAME = "smartenergymeterweb";
const MQTT_PASSWORD = "sMch!JtGn5gpYD4";
const TOPIC_DATA = "smartmeter/data";
const TOPIC_STATUS = "smartmeter/status";

const $ = id => document.getElementById(id);
const meter = { voltage:0,current:0,power:0,energy:0,frequency:0,pf:0,va:0,var:0,wifi:false,sensor:false };
const chartLabels = [], powerValues = [], voltageValues = [], currentValues = [];
const maxPoints = 40;
let chart;
let client;
let lastPacketAt = 0;

function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function setText(id, value) { const element = $(id); if (element) element.textContent = value; }
function format(value, digits) { return number(value).toFixed(digits); }

function createChart() {
  const canvas = $("powerChart");
  if (!canvas || typeof Chart === "undefined") return;
  chart = new Chart(canvas.getContext("2d"), {
    type:"line",
    data:{ labels:chartLabels, datasets:[
      { label:"Daya (W)", data:powerValues, borderColor:"#148a43", backgroundColor:"rgba(32,166,87,.12)", borderWidth:2.5, tension:.35, fill:true },
      { label:"Tegangan (V)", data:voltageValues, borderColor:"#5c7564", borderWidth:2, tension:.35, fill:false },
      { label:"Arus (A)", data:currentValues, borderColor:"#b77916", borderWidth:2, tension:.35, fill:false }
    ]},
    options:{ responsive:true, animation:false, interaction:{mode:"index",intersect:false}, plugins:{legend:{labels:{usePointStyle:true}}}, scales:{x:{grid:{display:false}},y:{beginAtZero:true,grid:{color:"#e8efea"}}} }
  });
}

function updateChart() {
  if (!chart) return;
  chartLabels.push(new Date().toLocaleTimeString());
  powerValues.push(number(meter.power));
  voltageValues.push(number(meter.voltage));
  currentValues.push(number(meter.current));
  if (chartLabels.length > maxPoints) {
    chartLabels.shift(); powerValues.shift(); voltageValues.shift(); currentValues.shift();
  }
  chart.update("none");
}

function updateDashboard() {
  setText("voltage", format(meter.voltage, 1)); setText("current", format(meter.current, 2));
  setText("power", format(meter.power, 0)); setText("energy", format(meter.energy, 3));
  setText("frequency", format(meter.frequency, 1)); setText("pf", format(meter.pf, 2));
  setText("va", format(meter.va, 0)); setText("var", format(meter.var, 0));
  setText("pzemStatus", meter.sensor ? "Online" : "Tidak terdeteksi");
}

function applyStatus(data) {
  Object.assign(meter, data || {});
  lastPacketAt = Date.now();
  updateDashboard();
  updateChart();
}

// Status baris "Koneksi broker MQTT": transport browser <-> cloud broker.
function setBrokerStatus(label) {
  setText("connectionText", label);
}

// Indikator utama (dot + teks di header): apakah ESP32 sendiri online, dilihat
// dari ada/tidaknya data segar yang masuk — BUKAN sekadar koneksi broker.
function setDeviceStatus(online) {
  setText("wifiText", online ? "Perangkat online" : "Perangkat offline");
  const led = $("wifiLed");
  if (led) led.className = `status-dot ${online ? "online" : "offline"}`;
}

function connectMQTT() {
  if (client) client.end(true);
  setBrokerStatus("Menghubungkan…");
  client = mqtt.connect(MQTT_WS_URL, {
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD,
    clientId: "web-" + Math.random().toString(16).slice(2),
    reconnectPeriod: 3000,
    connectTimeout: 8000,
  });
  client.on("connect", () => {
    setBrokerStatus("Terhubung ke broker");
    client.subscribe(TOPIC_STATUS);
    client.subscribe(TOPIC_DATA);
  });
  client.on("reconnect", () => setBrokerStatus("Mencoba ulang…"));
  client.on("close", () => setBrokerStatus("Terputus dari broker"));
  client.on("error", () => setBrokerStatus("Koneksi broker bermasalah"));
  client.on("message", (topic, payload) => {
    if (topic === TOPIC_STATUS) {
      setDeviceStatus(payload.toString() === "online");
      return;
    }
    if (topic !== TOPIC_DATA) return;
    try { applyStatus(JSON.parse(payload.toString())); } catch { /* ignore malformed packet */ }
  });
}

function showToast(message, isError = false) {
  let toast = document.querySelector(".toast");
  if (!toast) { toast = document.createElement("div"); toast.className = "toast"; document.body.append(toast); }
  toast.textContent = message; toast.classList.toggle("error", isError); toast.classList.add("show");
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function updateClock() { setText("clock", new Date().toLocaleTimeString()); }
window.addEventListener("load", () => {
  createChart(); updateClock(); connectMQTT();
  setDeviceStatus(false);
  setInterval(updateClock, 1000);
  setInterval(() => {
    const age = Date.now() - lastPacketAt;
    const fresh = lastPacketAt && age < 2500;
    setText("fps", fresh ? "1 Hz" : "Menunggu data");
  }, 1000);
});
