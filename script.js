"use strict";

const $ = id => document.getElementById(id);
const meter = { voltage:0,current:0,power:0,energy:0,frequency:0,pf:0,va:0,var:0,wifi:false,sensor:false };
const chartLabels = [], powerValues = [], voltageValues = [], currentValues = [];
const maxPoints = 40;
let chart;
let socket;
let reconnectTimer;
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
  setText("connectionText", meter.wifi ? "Terhubung" : "Wi-Fi terputus");
}

function applyStatus(data, appendChart = true) {
  Object.assign(meter, data || {});
  lastPacketAt = Date.now();
  updateDashboard();
  if (appendChart) updateChart();
}

function setConnectionStatus(label, online) {
  setText("wifiText", label);
  const led = $("wifiLed");
  if (led) led.className = `status-dot ${online ? "online" : "offline"}`;
}

function connectWebSocket() {
  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
  clearTimeout(reconnectTimer);
  setConnectionStatus("Menghubungkan…", false);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/ws`);
  socket.onopen = () => { setConnectionStatus("Terhubung", true); refreshStatus(false); };
  socket.onmessage = event => { try { applyStatus(JSON.parse(event.data)); } catch { setConnectionStatus("Data tidak valid", false); } };
  socket.onerror = () => setConnectionStatus("Koneksi bermasalah", false);
  socket.onclose = () => {
    setConnectionStatus("Mencoba ulang…", false);
    reconnectTimer = setTimeout(connectWebSocket, 3000);
  };
}

async function refreshStatus(appendChart = false) {
  try {
    const response = await fetch("/api/status", {cache:"no-store"});
    if (!response.ok) throw new Error("Status tidak tersedia");
    applyStatus(await response.json(), appendChart);
  } catch { setConnectionStatus("Tidak dapat menghubungi perangkat", false); }
}

function showToast(message, isError = false) {
  let toast = document.querySelector(".toast");
  if (!toast) { toast = document.createElement("div"); toast.className = "toast"; document.body.append(toast); }
  toast.textContent = message; toast.classList.toggle("error", isError); toast.classList.add("show");
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove("show"), 3200);
}

async function sendRequest(path, successMessage) {
  const response = await fetch(path);
  if (!response.ok) throw new Error("Permintaan gagal");
  showToast(successMessage);
}

async function restartESP() {
  if (!confirm("Restart perangkat sekarang?")) return;
  try { await sendRequest("/restart", "Perintah restart dikirim."); } catch { showToast("Restart gagal dikirim.", true); }
}

async function factoryReset() {
  if (!confirm("Factory reset mengembalikan pengaturan perangkat ke nilai awal. Lanjutkan?")) return;
  try { await sendRequest("/factoryReset", "Factory reset selesai."); await refreshStatus(false); } catch { showToast("Factory reset gagal.", true); }
}

function updateClock() { setText("clock", new Date().toLocaleTimeString()); }
window.addEventListener("load", () => {
  createChart(); updateClock(); connectWebSocket(); refreshStatus(false);
  setInterval(() => { updateClock(); if (!socket || socket.readyState !== WebSocket.OPEN) refreshStatus(false); }, 1000);
  setInterval(() => {
    const age = Date.now() - lastPacketAt;
    setText("fps", age < 2500 ? "1 Hz" : "Menunggu data");
  }, 1000);
});
