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

const ONLINE_COLOR = "#4edea3";
const OFFLINE_COLOR = "#ffb4ab";
const CIRC_LARGE = 2 * Math.PI * 68;
const CIRC_SMALL = 2 * Math.PI * 40;
const maxPoints = 40;

const $ = id => document.getElementById(id);
const meter = { voltage: 0, current: 0, power: 0, energy: 0, frequency: 0, pf: 0, va: 0, var: 0, limit: 0, wifi: false, sensor: false, trip: false };
const powerValues = [], voltageValues = [], currentValues = [];
const chartState = { metric: "power" };
let client;
let lastPacketAt = 0;
let deviceOnline = false;

function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function setText(id, value) { const el = $(id); if (el) el.textContent = value; }
function format(value, digits) { return number(value).toFixed(digits); }
function clampPercent(value) { return Math.max(0, Math.min(100, value)); }
function rangePercent(value, min, max) { return max <= min ? 0 : ((number(value) - min) / (max - min)) * 100; }

function setGauge(id, circumference, percent) {
  const el = $(id);
  if (!el) return;
  const clamped = clampPercent(percent);
  el.setAttribute("stroke-dasharray", circumference.toFixed(2));
  el.setAttribute("stroke-dashoffset", (circumference * (1 - clamped / 100)).toFixed(2));
}

function setBadge(id, text, state, baseClass) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  const colorClass = state === "good" ? "text-primary bg-primary/10" : state === "warn" ? "text-tertiary bg-tertiary/10" : "text-error bg-error/10";
  el.className = `${baseClass} ${colorClass}`;
}

// Broker meretensi pesan smartmeter/data terakhir, jadi angkanya tetap ada
// walau perangkat sudah mati — kosongkan tampilan saat status bukan "online"
// supaya tidak terlihat seolah masih data langsung.
function clearMetricsDisplay() {
  ["metric-watt", "metric-kwh", "metric-voltage", "metric-current", "metric-freq", "metric-pf", "metric-va", "metric-var"].forEach((id) => setText(id, "-"));
  ["watt-percent-label", "metric-limit", "metric-remaining", "watt-percent-small", "pf-label"].forEach((id) => setText(id, "-"));
  ["gauge-watt", "gauge-kwh", "gauge-voltage", "gauge-current", "gauge-freq", "gauge-pf", "gauge-va", "gauge-var"].forEach((id) => setGauge(id, id === "gauge-watt" ? CIRC_LARGE : CIRC_SMALL, 0));
  setBadge("loadStatusBadge", "Offline", "bad", "px-2 py-0.5 rounded-full font-label-telemetry text-label-telemetry uppercase tracking-wider");
  setBadge("sensorStatusBadge", "Tidak diketahui", "bad", "font-label-telemetry text-label-telemetry px-2.5 py-0.5 rounded-full font-semibold");
  setText("fps", "Perangkat offline");
}

// Indikator utama (header + subheader): apakah ESP32 sendiri online, dari MQTT
// Last Will (smartmeter/status) — bukan sekadar koneksi browser ke broker.
function setDeviceStatus(online) {
  deviceOnline = online;
  const color = online ? ONLINE_COLOR : OFFLINE_COLOR;
  ["headerDot", "headerPulse", "subHeaderDot", "subHeaderPulse"].forEach((id) => {
    const el = $(id);
    if (el) el.style.background = color;
  });
  const headerText = $("headerStatusText");
  if (headerText) { headerText.textContent = online ? "ONLINE" : "OFFLINE"; headerText.style.color = color; }
  const subText = $("subHeaderStatusText");
  if (subText) { subText.textContent = online ? "Aktif Terhubung" : "Terputus"; subText.style.color = color; }
  if (!online) clearMetricsDisplay();
}

// Status baris "Koneksi Broker MQTT": transport browser <-> cloud broker,
// terpisah dari status device di atas.
function setBrokerStatus(label) { setText("brokerStatusBadge", label); }

function setLoadBadge(percent, trip) {
  let state = "good", text = "Normal";
  if (trip) { state = "bad"; text = "Overload"; }
  else if (percent >= 85) { state = "warn"; text = "Tinggi"; }
  setBadge("loadStatusBadge", text, state, "px-2 py-0.5 rounded-full font-label-telemetry text-label-telemetry uppercase tracking-wider");
}

function updateDashboard() {
  const limit = Math.max(number(meter.limit), 1);
  const power = number(meter.power);
  const powerPercent = clampPercent((power / limit) * 100);
  const remaining = Math.max(0, limit - power);

  setText("metric-watt", Math.round(power));
  setText("watt-percent-label", `${powerPercent.toFixed(0)}% / ${Math.round(limit)}W`);
  setText("metric-limit", `${Math.round(limit)} Watt`);
  setText("metric-remaining", `${Math.round(remaining)} Watt`);
  setGauge("gauge-watt", CIRC_LARGE, powerPercent);
  setText("watt-percent-small", `${powerPercent.toFixed(0)}%`);
  setGauge("gauge-kwh", CIRC_SMALL, powerPercent);
  setLoadBadge(powerPercent, meter.trip);

  setText("metric-kwh", format(meter.energy, 3));

  setText("metric-voltage", format(meter.voltage, 1));
  setGauge("gauge-voltage", CIRC_SMALL, rangePercent(meter.voltage, 180, 250));

  const maxAmp = limit / 220;
  setText("metric-current", format(meter.current, 2));
  setGauge("gauge-current", CIRC_SMALL, rangePercent(meter.current, 0, maxAmp));

  setText("metric-freq", format(meter.frequency, 1));
  setGauge("gauge-freq", CIRC_SMALL, rangePercent(meter.frequency, 45, 55));

  const pf = number(meter.pf);
  setText("metric-pf", format(meter.pf, 2));
  setGauge("gauge-pf", CIRC_SMALL, pf * 100);
  setText("pf-label", pf === 0 ? "-" : pf >= 0.9 ? "Efisiensi Tinggi" : pf >= 0.7 ? "Efisiensi Sedang" : "Efisiensi Rendah");

  setText("metric-va", Math.round(number(meter.va)));
  setGauge("gauge-va", CIRC_SMALL, rangePercent(meter.va, 0, limit));

  const maxVar = Math.max(limit * 0.5, 1);
  setText("metric-var", Math.round(number(meter.var)));
  setGauge("gauge-var", CIRC_SMALL, rangePercent(meter.var, 0, maxVar));

  setBadge("sensorStatusBadge", meter.sensor ? "Online" : "Tidak terdeteksi", meter.sensor ? "good" : "bad", "font-label-telemetry text-label-telemetry px-2.5 py-0.5 rounded-full font-semibold");
}

function buildPath(values) {
  if (!values.length) return { line: "", area: "", lastX: 300, lastY: 50, max: 0 };
  const max = Math.max(...values, 0.001);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const n = values.length;
  const stepX = n > 1 ? 300 / (n - 1) : 0;
  const points = values.map((v, i) => [n > 1 ? i * stepX : 300, 90 - ((v - min) / range) * 80]);
  const line = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lastX, lastY] = points[points.length - 1];
  return { line, area: `${line} L${lastX.toFixed(1)},100 L0,100 Z`, lastX, lastY, max };
}

function renderChart() {
  const dataMap = { power: powerValues, voltage: voltageValues, current: currentValues };
  const values = dataMap[chartState.metric] || [];
  const { line, area, lastX, lastY, max } = buildPath(values);
  const lineEl = $("telemetry-line");
  const areaEl = $("telemetry-area");
  const dotEl = $("telemetry-dot");
  if (lineEl) lineEl.setAttribute("d", line);
  if (areaEl) areaEl.setAttribute("d", area);
  if (dotEl && values.length) { dotEl.setAttribute("cx", lastX.toFixed(1)); dotEl.setAttribute("cy", lastY.toFixed(1)); }
  const unit = chartState.metric === "power" ? "W" : chartState.metric === "voltage" ? "V" : "A";
  const digits = chartState.metric === "current" ? 2 : 0;
  setText("chart-max-label", values.length ? `Maks ${format(max, digits)}${unit}` : "-");
}

function updateChart() {
  powerValues.push(number(meter.power));
  voltageValues.push(number(meter.voltage));
  currentValues.push(number(meter.current));
  if (powerValues.length > maxPoints) { powerValues.shift(); voltageValues.shift(); currentValues.shift(); }
  renderChart();
}

function applyStatus(data) {
  Object.assign(meter, data || {});
  // smartmeter/data is retained, so it can arrive even when the device is
  // known offline (smartmeter/status) — don't render it as if it were live.
  if (!deviceOnline) return;
  lastPacketAt = Date.now();
  updateDashboard();
  updateChart();
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
    if (topic === TOPIC_STATUS) { setDeviceStatus(payload.toString() === "online"); return; }
    if (topic !== TOPIC_DATA) return;
    try { applyStatus(JSON.parse(payload.toString())); } catch { /* ignore malformed packet */ }
  });
}

// Estimasi tagihan bulan berjalan, dibaca dari data yang sama dipakai
// bill.html (localStorage bersama, sama origin) — bukan angka fiktif.
function getElectricityRate() {
  const rate = Number(localStorage.getItem("electricityRate"));
  return Number.isFinite(rate) && rate > 0 ? rate : 1500;
}

function updateBillPreview() {
  try {
    const weeklyData = JSON.parse(localStorage.getItem("weeklyElectricity") || "{}");
    const now = new Date();
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const weeks = weeklyData[key] || {};
    let total = 0;
    for (let w = 1; w <= 5; w++) total += Number(weeks["week" + w] || 0);
    setText("bill-preview", new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(total));
  } catch {
    setText("bill-preview", "Rp 0");
  }
}

function updateClock() { setText("telemetry-clock", new Date().toLocaleTimeString("id-ID")); }

function setupChartTabs() {
  const tabs = [$("tab-watt"), $("tab-volt"), $("tab-amp")].filter(Boolean);
  tabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabs.forEach((t) => { t.classList.remove("bg-primary", "text-on-primary", "font-bold"); t.classList.add("text-on-surface-variant"); });
      btn.classList.add("bg-primary", "text-on-primary", "font-bold");
      btn.classList.remove("text-on-surface-variant");
      chartState.metric = btn.dataset.metric;
      renderChart();
    });
  });
}

function setupBottomNav() {
  document.querySelectorAll(".nav-tab").forEach((tab) => {
    tab.addEventListener("click", (event) => {
      const href = tab.getAttribute("href");
      if (href && href.startsWith("#") && href.length > 1) {
        event.preventDefault();
        $(href.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" });
      } else if (href === "#") {
        event.preventDefault();
      } else {
        return; // real link (bill.html), let it navigate.
      }
      document.querySelectorAll(".nav-tab").forEach((t) => { t.classList.remove("text-primary", "border-primary"); t.classList.add("text-on-surface-variant", "border-transparent"); });
      tab.classList.remove("text-on-surface-variant", "border-transparent");
      tab.classList.add("text-primary", "border-primary");
    });
  });
}

window.addEventListener("load", () => {
  updateClock();
  updateBillPreview();
  setupChartTabs();
  setupBottomNav();
  connectMQTT();
  setDeviceStatus(false);

  $("btn-refresh")?.addEventListener("click", () => connectMQTT());
  $("btn-reconnect")?.addEventListener("click", () => connectMQTT());
  window.addEventListener("storage", updateBillPreview);

  setInterval(updateClock, 1000);
  setInterval(() => {
    const age = Date.now() - lastPacketAt;
    const fresh = lastPacketAt && age < 2500;
    setText("fps", fresh ? "1 Hz (Real-time)" : "Menunggu data");
  }, 1000);
});
