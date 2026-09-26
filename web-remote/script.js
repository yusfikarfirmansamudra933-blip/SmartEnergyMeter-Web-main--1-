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
const TOPIC_BILLING_WEEKLY = "smartmeter/billing/weekly";

// Warna berasal dari variabel CSS di index.html, jadi ikut berganti dengan tema.
const TONE_STROKE = { good: "var(--accent)", warn: "var(--warn)", bad: "var(--bad)" };
const BADGE_BASE = "px-2 py-0.5 rounded-md font-mono text-label";
const CIRC_LARGE = 2 * Math.PI * 68;
const CIRC_SMALL = 2 * Math.PI * 40;
const maxPoints = 40;

const $ = id => document.getElementById(id);
const meter = { voltage: 0, current: 0, power: 0, energy: 0, frequency: 0, pf: 0, va: 0, var: 0, limit: 0, wifi: false, sensor: false, trip: false, chipTemperature: null };
const powerValues = [], voltageValues = [], currentValues = [];
const chartState = { metric: "power" };
let client;
let lastPacketAt = 0;
let lastIntervalMs = 0;
let deviceOnline = false;
let deviceState = null; // "online" | "standby" | "offline", null sampai status pertama tiba

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
  const colorClass = state === "good" ? "text-accent-ink bg-accent-soft" : state === "warn" ? "text-warn-ink bg-warn-soft" : "text-bad-ink bg-bad-soft";
  el.className = `${baseClass} ${colorClass}`;
}

// Warna busur gauge membawa status (normal/hangat/bahaya), bukan hiasan.
function setGaugeTone(id, tone) {
  const el = $(id);
  if (el) el.style.color = TONE_STROKE[tone] || TONE_STROKE.good;
}

// Broker meretensi pesan smartmeter/data terakhir, jadi angkanya tetap ada
// walau perangkat sudah mati — kosongkan tampilan saat status bukan "online"
// supaya tidak terlihat seolah masih data langsung.
function clearMetricsDisplay() {
  const standby = deviceState === "standby";
  const unknown = deviceState === null;
  ["metric-watt", "metric-kwh", "metric-voltage", "metric-current", "metric-freq", "metric-pf", "metric-va", "metric-var", "metric-chip"].forEach((id) => setText(id, "-"));
  ["watt-percent-label", "metric-limit", "metric-remaining", "pf-label"].forEach((id) => setText(id, "-"));
  setText("chip-label", "Belum tersedia");
  ["gauge-watt", "gauge-voltage", "gauge-current", "gauge-freq", "gauge-pf", "gauge-va", "gauge-var", "gauge-chip"].forEach((id) => setGauge(id, id === "gauge-watt" ? CIRC_LARGE : CIRC_SMALL, 0));
  setGaugeTone("gauge-watt", "good");
  setGaugeTone("gauge-chip", "good");
  setBadge("loadStatusBadge", standby ? "Standby" : unknown ? "Memeriksa" : "Offline", standby || unknown ? "warn" : "bad", BADGE_BASE + " uppercase");
  setBadge("sensorStatusBadge", standby ? "Dimatikan" : unknown ? "Memeriksa" : "Tidak diketahui", standby || unknown ? "warn" : "bad", BADGE_BASE);
  setText("fps", idleDataText());
}

// Teks baris "Pembaruan data" saat tidak ada data langsung.
function idleDataText() {
  if (deviceState === "standby") return "Standby";
  if (deviceState === "offline") return "Perangkat offline";
  return "Menunggu data";
}

const STATUS_VIEW = {
  online: { label: "Online", dot: "var(--accent)", ink: "var(--accent-ink)" },
  standby: { label: "Standby", dot: "var(--warn)", ink: "var(--warn-ink)" },
  offline: { label: "Offline", dot: "var(--bad)", ink: "var(--bad-ink)" },
};

// Indikator header dari smartmeter/status: "online", "standby" (pemantauan
// dijeda dari kartu Pemantauan), atau "offline" (Last Will dari broker). Ini
// status ESP32 sendiri, bukan koneksi browser ke broker.
function setDeviceStatus(state) {
  deviceState = state === "online" || state === "standby" ? state : "offline";
  deviceOnline = deviceState === "online";
  const view = STATUS_VIEW[deviceState];
  const dot = $("headerDot");
  if (dot) dot.style.background = view.dot;
  const headerText = $("headerStatusText");
  if (headerText) { headerText.textContent = view.label; headerText.style.color = view.ink; }
  if (!deviceOnline) clearMetricsDisplay();
  renderPowerCard();
}

// --- Kartu Pemantauan (standby / nyala lewat api/power.js) ---

const POWER_TIMEOUT_MS = 15000;
const powerUi = { formOpen: false, sending: false, pendingAction: null, pendingTimer: null };

function setPowerMessage(text, tone) {
  const el = $("power-msg");
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || "";
  el.className = `text-small ${tone === "bad" ? "text-bad-ink" : tone === "good" ? "text-accent-ink" : "text-ink-2"}`;
}

function renderPowerCard() {
  const btn = $("btn-power");
  const form = $("power-form");
  if (!btn || !form) return;

  const desc = {
    online: "Aktif. Sensor dan layar OLED menyala, data terkirim tiap detik.",
    standby: "Standby. Sensor tidak dibaca dan data tidak dikirim, layar OLED menampilkan STANDBY. ESP32 tetap terhubung, jadi bisa dinyalakan lagi dari sini.",
    offline: "Perangkat offline, jadi tidak bisa dikendalikan dari sini.",
  }[deviceState] || "Menunggu status perangkat.";
  setText("power-desc", desc);

  const controllable = deviceState === "online" || deviceState === "standby";
  const turningOn = deviceState === "standby";
  btn.hidden = !controllable || powerUi.formOpen || !!powerUi.pendingAction;
  btn.className = `w-full min-h-[44px] py-3 px-4 rounded-lg flex items-center justify-center gap-2 font-semibold transition-colors ${
    turningOn ? "bg-btn text-on-btn hover:opacity-90" : "bg-card border border-line text-ink hover:bg-inset"}`;
  setText("btn-power-label", turningOn ? "Nyalakan pemantauan" : "Matikan pemantauan");
  setText("power-submit", powerUi.sending ? "Mengirim..." : turningOn ? "Nyalakan" : "Matikan");
  $("power-submit").disabled = powerUi.sending;
  form.hidden = !controllable || !powerUi.formOpen;
  if (!controllable && powerUi.formOpen) powerUi.formOpen = false;

  // Status baru dari perangkat menyelesaikan perintah yang sedang ditunggu.
  if (powerUi.pendingAction) {
    const expected = powerUi.pendingAction === "off" ? "standby" : "online";
    if (deviceState === expected) {
      clearTimeout(powerUi.pendingTimer);
      powerUi.pendingAction = null;
      setPowerMessage(expected === "standby" ? "Pemantauan dimatikan." : "Pemantauan menyala lagi.", "good");
      renderPowerCard();
    }
  }
}

function openPowerForm() {
  powerUi.formOpen = true;
  setPowerMessage("");
  $("power-pin-error").hidden = true;
  renderPowerCard();
  $("power-pin").focus();
}

function closePowerForm() {
  powerUi.formOpen = false;
  setPowerMessage("");
  $("power-pin").value = "";
  $("power-pin-error").hidden = true;
  renderPowerCard();
  $("btn-power").focus();
}

function powerErrorText(status, body) {
  if (status === 401) return `PIN salah. Sisa ${body.attemptsLeft} percobaan.`;
  if (status === 429) return `Terlalu banyak PIN salah. Coba lagi dalam ${Math.max(1, Math.ceil((body.retryAfterSec || 900) / 60))} menit.`;
  if (status === 503) return "Kontrol belum diaktifkan di server (CONTROL_PIN belum diatur di Vercel).";
  return "Gagal mengirim perintah. Periksa koneksi lalu coba lagi.";
}

async function submitPower(event) {
  event.preventDefault();
  const pinInput = $("power-pin");
  const pin = pinInput.value.trim();
  if (!pin) { $("power-pin-error").hidden = false; pinInput.focus(); return; }

  const action = deviceState === "standby" ? "on" : "off";
  powerUi.sending = true;
  setPowerMessage("");
  renderPowerCard();

  let status = 0, body = {};
  try {
    const res = await fetch("api/power", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, pin }) });
    status = res.status;
    body = await res.json().catch(() => ({}));
  } catch { /* status tetap 0: gagal jaringan */ }

  powerUi.sending = false;
  pinInput.value = "";

  if (status === 200) {
    powerUi.formOpen = false;
    powerUi.pendingAction = action;
    setPowerMessage("Perintah terkirim. Menunggu perangkat...", "info");
    powerUi.pendingTimer = setTimeout(() => {
      powerUi.pendingAction = null;
      setPowerMessage("Perangkat belum merespons. Periksa koneksinya lalu coba lagi.", "bad");
      renderPowerCard();
    }, POWER_TIMEOUT_MS);
    renderPowerCard();
    // Form dan tombol tersembunyi selama menunggu: pindahkan fokus ke pesan status.
    $("power-msg").focus();
    return;
  }

  // Terkunci: tutup form, karena PIN apa pun akan ditolak sampai waktunya habis.
  if (status === 429 || status === 503) powerUi.formOpen = false;
  setPowerMessage(powerErrorText(status, body), "bad");
  renderPowerCard();
  if (powerUi.formOpen) pinInput.focus(); else $("btn-power").focus();
}

function setupPowerCard() {
  $("btn-power")?.addEventListener("click", openPowerForm);
  $("power-cancel")?.addEventListener("click", closePowerForm);
  $("power-form")?.addEventListener("submit", submitPower);
  $("power-form")?.addEventListener("keydown", (event) => { if (event.key === "Escape") closePowerForm(); });
  $("power-pin")?.addEventListener("input", () => { $("power-pin-error").hidden = true; });
}

// Status baris "Koneksi Broker MQTT": transport browser <-> cloud broker,
// terpisah dari status device di atas.
function setBrokerStatus(label) { setText("brokerStatusBadge", label); }

function setLoadBadge(percent, trip) {
  let state = "good", text = "Normal";
  if (trip) { state = "bad"; text = "Overload"; }
  else if (percent >= 85) { state = "warn"; text = "Tinggi"; }
  setBadge("loadStatusBadge", text, state, BADGE_BASE + " uppercase");
  setGaugeTone("gauge-watt", state);
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

  // Firmware sengaja tidak mengirim chipTemperature kalau belum ada pembacaan
  // valid — tampilkan "-" alih-alih 0.0 atau angka palsu.
  const chip = meter.chipTemperature;
  const hasChip = chip !== null && chip !== undefined && Number.isFinite(Number(chip));
  setText("metric-chip", hasChip ? format(chip, 1) : "-");
  setGauge("gauge-chip", CIRC_SMALL, hasChip ? rangePercent(chip, 30, 90) : 0);
  setText("chip-label", !hasChip ? "Belum tersedia" : chip >= 85 ? "Terlalu panas" : chip >= 70 ? "Hangat" : "Normal");
  setGaugeTone("gauge-chip", !hasChip || chip < 70 ? "good" : chip < 85 ? "warn" : "bad");

  setBadge("sensorStatusBadge", meter.sensor ? "Online" : "Tidak terdeteksi", meter.sensor ? "good" : "bad", BADGE_BASE);
}

// A fixed baseline scale instead of auto-fitting to whatever's in the
// current data window — auto-fit made the line always stretch to fill the
// full height (even a current reading jittering by 0.01A looked like a
// dramatic swing) and the background gridlines were purely decorative
// since they didn't correspond to any real value. Power/current follow the
// same limit-based range already used for the round gauges above, so a
// "70% full" gauge and a trace sitting 70% up the chart mean the same thing.
//
// The baseline is a floor, not a ceiling: if a reading actually exceeds it
// (an overload spike above the configured limit, a voltage sag/surge past
// 180-250V) the scale expands to fit, with a little headroom, instead of
// clipping the line flat at the top/bottom and hiding how far out of range
// things really got.
function getMetricRange(metric, values) {
  const limit = Math.max(number(meter.limit), 1);
  const observedMax = values.length ? Math.max(...values) : 0;
  const observedMin = values.length ? Math.min(...values) : 0;

  if (metric === "voltage") {
    const baseMin = 180, baseMax = 250;
    return {
      min: Math.min(baseMin, observedMin),
      max: Math.max(baseMax, observedMax * 1.05),
    };
  }
  if (metric === "current") {
    return { min: 0, max: Math.max(limit / 220, observedMax * 1.1) };
  }
  return { min: 0, max: Math.max(limit, observedMax * 1.1) };
}

function buildPath(values, min, max) {
  if (!values.length) return { line: "", area: "", lastX: 300, lastY: 90 };
  const range = (max - min) || 1;
  const n = values.length;
  const stepX = n > 1 ? 300 / (n - 1) : 0;
  const points = values.map((v, i) => {
    const clamped = Math.min(max, Math.max(min, v));
    return [n > 1 ? i * stepX : 300, 90 - ((clamped - min) / range) * 80];
  });
  const line = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lastX, lastY] = points[points.length - 1];
  return { line, area: `${line} L${lastX.toFixed(1)},100 L0,100 Z`, lastX, lastY };
}

function renderChart() {
  const dataMap = { power: powerValues, voltage: voltageValues, current: currentValues };
  const values = dataMap[chartState.metric] || [];
  const { min, max } = getMetricRange(chartState.metric, values);
  const { line, area, lastX, lastY } = buildPath(values, min, max);
  const emptyEl = $("chart-empty");
  if (emptyEl) emptyEl.hidden = values.length > 0;
  const lineEl = $("telemetry-line");
  const areaEl = $("telemetry-area");
  const dotEl = $("telemetry-dot");
  if (lineEl) lineEl.setAttribute("d", line);
  if (areaEl) areaEl.setAttribute("d", area);
  if (dotEl && values.length) { dotEl.setAttribute("cx", lastX.toFixed(1)); dotEl.setAttribute("cy", lastY.toFixed(1)); }

  const unit = chartState.metric === "power" ? "W" : chartState.metric === "voltage" ? "V" : "A";
  const digits = chartState.metric === "current" ? 2 : 0;
  setText("axis-top", `${format(max, digits)}${unit}`);
  setText("axis-mid", `${format(min + (max - min) / 2, digits)}${unit}`);
  setText("axis-bottom", `${format(min, digits)}${unit}`);

  const observedMax = values.length ? Math.max(...values) : 0;
  setText("chart-max-label", values.length ? `Puncak ${format(observedMax, digits)}${unit}` : "-");
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
  const now = Date.now();
  if (lastPacketAt) lastIntervalMs = now - lastPacketAt;
  lastPacketAt = now;
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
    client.subscribe(TOPIC_BILLING_WEEKLY);
  });
  client.on("reconnect", () => setBrokerStatus("Mencoba ulang…"));
  client.on("close", () => setBrokerStatus("Terputus dari broker"));
  client.on("error", () => setBrokerStatus("Koneksi broker bermasalah"));
  client.on("message", (topic, payload) => {
    if (topic === TOPIC_STATUS) { setDeviceStatus(payload.toString()); return; }
    if (topic === TOPIC_BILLING_WEEKLY) {
      try { applyBillPreview(JSON.parse(payload.toString())); } catch { /* ignore malformed packet */ }
      return;
    }
    if (topic !== TOPIC_DATA) return;
    try { applyStatus(JSON.parse(payload.toString())); } catch { /* ignore malformed packet */ }
  });
}

// Estimasi tagihan bulan berjalan — dihitung server-side (api/monitor.js)
// dan dibagikan lewat MQTT retained, sama seperti yang dipakai bill.html.
// Sebelumnya nilai ini dari localStorage per-browser, jadi tidak sinkron
// antar perangkat; sekarang satu sumber data untuk semua.
function applyBillPreview(weeklyData) {
  const now = new Date();
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const weeks = (weeklyData && weeklyData[key]) || {};
  let total = 0;
  for (let w = 1; w <= 5; w++) total += Number(weeks["week" + w] || 0);
  setText("bill-preview", new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(total));
}

function updateClock() { setText("telemetry-clock", new Date().toLocaleTimeString("id-ID")); }

function setupChartTabs() {
  const tabs = [$("tab-watt"), $("tab-volt"), $("tab-amp")].filter(Boolean);
  tabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabs.forEach((t) => {
        t.classList.remove("bg-btn", "text-on-btn");
        t.classList.add("text-ink-2");
        t.setAttribute("aria-pressed", "false");
      });
      btn.classList.add("bg-btn", "text-on-btn");
      btn.classList.remove("text-ink-2");
      btn.setAttribute("aria-pressed", "true");
      chartState.metric = btn.dataset.metric;
      renderChart();
    });
  });
}

window.addEventListener("load", () => {
  updateClock();
  setupChartTabs();
  setupPowerCard();
  connectMQTT();
  // Belum ada status dari broker: tampilkan sebagai belum diketahui, bukan offline.
  deviceState = null;
  clearMetricsDisplay();
  renderPowerCard();

  $("btn-reconnect")?.addEventListener("click", () => connectMQTT());

  setInterval(updateClock, 1000);
  setInterval(() => {
    const age = Date.now() - lastPacketAt;
    const fresh = lastPacketAt && age < 2500;
    if (!deviceOnline) { setText("fps", idleDataText()); return; }
    setText("fps", fresh && lastIntervalMs ? `Tiap ${(lastIntervalMs / 1000).toFixed(1)} detik` : fresh ? "Data masuk" : "Menunggu data");
  }, 1000);
});
