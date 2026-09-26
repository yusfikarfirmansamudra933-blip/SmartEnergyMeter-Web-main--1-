"use strict";

// Kartu "Riwayat 1 jam": rata-rata per menit dari smartmeter/history (dikirim
// ESP32 tiap menit, retained). script.js yang memegang koneksi MQTT dan
// memanggil applyHistory()/historyWaiting()/historyDenied()/historyDisconnected().

const HISTORY_METRICS = [
  { key: "power", label: "Daya", unit: "W", digits: 1, floor: 0 },
  { key: "voltage", label: "Tegangan", unit: "V", digits: 1 },
  { key: "current", label: "Arus", unit: "A", digits: 3, floor: 0 },
  { key: "frequency", label: "Frekuensi", unit: "Hz", digits: 2 },
  { key: "pf", label: "PF", unit: "", digits: 2, fixed: [0, 1] },
  { key: "chipTemperature", label: "Suhu", unit: "°C", digits: 1 },
];

const HISTORY_EMPTY_AFTER_MS = 6000;
const CHART_H = 200;
const PAD = { top: 10, right: 10, bottom: 24, left: 52 }; // left dihitung ulang tiap gambar

const hist = {
  data: null,           // payload terakhir dari ESP32
  state: "loading",     // loading | ready | empty | denied | disconnected
  metric: "power",
  cursor: null,         // indeks menit yang sedang ditunjuk, null = tidak ada
  emptyTimer: null,
  geometry: null,       // posisi titik untuk tooltip, diisi saat menggambar
};

try { const saved = localStorage.getItem("historyMetric"); if (HISTORY_METRICS.some((m) => m.key === saved)) hist.metric = saved; } catch { /* pakai default */ }

const hEl = (id) => document.getElementById(id);
const metricOf = (key) => HISTORY_METRICS.find((m) => m.key === key);

function fmt(value, digits) {
  return Number(value).toLocaleString("id-ID", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function withUnit(value, metric, digits = metric.digits) {
  return metric.unit ? `${fmt(value, digits)} ${metric.unit}` : fmt(value, digits);
}

// Batas sumbu Y yang "bulat" (misal 0, 20, 40, 60) supaya garis grid punya
// nilai yang enak dibaca, seperti 10 jt / 20 jt di referensi.
function niceScale(min, max, ticks = 4) {
  if (min === max) { const pad = Math.abs(min) * 0.05 || 1; min -= pad; max += pad; }
  const rough = (max - min) / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  // 2.5 hanya untuk langkah bulat (25 W); pada pecahan (0,025 Hz) langkah itu
  // butuh satu desimal ekstra dan labelnya jadi sulit dibaca.
  const factors = mag >= 1 ? [1, 2, 2.5, 5, 10] : [1, 2, 5, 10];
  const step = factors.map((f) => f * mag).find((s) => s >= rough);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const values = [];
  for (let v = lo; v <= hi + step / 2; v += step) values.push(v);
  return { lo, hi, step, values };
}

function tickDigits(step) {
  if (step >= 1) return 0;
  return -Math.floor(Math.log10(step) + 1e-9);
}

function minuteLabel(index, count) {
  const d = hist.data;
  const minutesAgo = count - 1 - index;
  if (d && d.end > 0) {
    const t = new Date((d.end - minutesAgo * (d.interval || 60)) * 1000);
    return t.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
  }
  return minutesAgo === 0 ? "Sekarang" : `-${minutesAgo} mnt`;
}

function setEmpty(text) {
  const el = hEl("history-empty");
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || "";
}

function renderTabs() {
  const wrap = hEl("history-tabs");
  if (!wrap) return;
  if (!wrap.childElementCount) {
    HISTORY_METRICS.forEach((m) => {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.metric = m.key;
      b.textContent = m.label;
      b.addEventListener("click", () => selectMetric(m.key));
      wrap.appendChild(b);
    });
  }
  wrap.querySelectorAll("button").forEach((b) => {
    const active = b.dataset.metric === hist.metric;
    b.setAttribute("aria-pressed", String(active));
    b.className = `min-h-[44px] px-3 rounded-md font-mono text-label transition-colors ${active ? "bg-btn text-on-btn" : "text-ink-2 hover:text-ink hover:bg-inset"}`;
  });
}

function selectMetric(key) {
  hist.metric = key;
  hist.cursor = null;
  try { localStorage.setItem("historyMetric", key); } catch { /* hanya untuk sesi ini */ }
  renderHistory();
}

function svgEl(tag, attrs, text) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  if (text !== undefined) el.textContent = text;
  return el;
}

function renderHistory() {
  renderTabs();
  const svg = hEl("history-svg");
  const tip = hEl("history-tip");
  if (!svg) return;
  svg.replaceChildren();
  if (tip) tip.hidden = true;
  hist.geometry = null;

  const metric = metricOf(hist.metric);
  const values = hist.data && Array.isArray(hist.data[metric.key]) ? hist.data[metric.key] : [];
  const real = values.filter((v) => v !== null && Number.isFinite(v));

  const messages = {
    loading: "Memuat riwayat...",
    empty: "Riwayat belum ada. ESP32 mengirim titik pertama satu menit setelah menyala.",
    denied: "Dashboard belum diizinkan membaca riwayat. Tambahkan izin Subscribe smartmeter/history di EMQX.",
    disconnected: "Tidak terhubung ke broker. Riwayat akan muncul lagi setelah tersambung.",
  };
  if (hist.state !== "ready") {
    setText("history-last", "-");
    setText("history-stats", "");
    setEmpty(messages[hist.state]);
    return;
  }
  if (!real.length) {
    setText("history-last", "-");
    setText("history-stats", "");
    setEmpty(`Belum ada data ${metric.label.toLowerCase()} dalam 1 jam terakhir.`);
    return;
  }
  setEmpty("");

  // Ringkasan di atas grafik: menit terakhir yang punya data, lalu min/rata/maks.
  let lastIdx = values.length - 1;
  while (lastIdx >= 0 && !Number.isFinite(values[lastIdx])) lastIdx--;
  const minV = Math.min(...real), maxV = Math.max(...real);
  const avg = real.reduce((s, v) => s + v, 0) / real.length;
  setText("history-last", withUnit(values[lastIdx], metric));
  setText("history-stats", `min ${fmt(minV, metric.digits)} · rata-rata ${fmt(avg, metric.digits)} · maks ${fmt(maxV, metric.digits)}`);

  const width = Math.max(240, svg.clientWidth || svg.parentElement.clientWidth);
  svg.setAttribute("viewBox", `0 0 ${width} ${CHART_H}`);

  let lo = metric.fixed ? metric.fixed[0] : Math.min(minV, metric.floor ?? minV);
  let hi = metric.fixed ? metric.fixed[1] : maxV;
  const scale = niceScale(lo, hi);
  if (!metric.fixed) { lo = scale.lo; hi = scale.hi; }
  const tickVals = metric.fixed ? [0, 0.25, 0.5, 0.75, 1] : scale.values;
  const dig = metric.fixed ? 2 : tickDigits(scale.step);
  const tickText = (v) => (metric.unit ? `${fmt(v, dig)} ${metric.unit}` : fmt(v, dig));

  // Kolom label Y selebar label terpanjang (huruf mono 11px sekitar 6,7px).
  PAD.left = Math.max(36, Math.ceil(Math.max(...tickVals.map((v) => tickText(v).length)) * 6.7) + 10);
  const plotW = width - PAD.left - PAD.right;
  const plotH = CHART_H - PAD.top - PAD.bottom;

  const n = values.length;
  const x = (i) => PAD.left + (n > 1 ? (i / (n - 1)) * plotW : plotW);
  const y = (v) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;

  // Garis grid horizontal bernilai + label sumbu Y.
  tickVals.forEach((v) => {
    const yy = y(v);
    svg.appendChild(svgEl("line", { x1: PAD.left, x2: width - PAD.right, y1: yy, y2: yy, style: "stroke:var(--line)", "stroke-width": 1 }));
    svg.appendChild(svgEl("text", { x: PAD.left - 8, y: yy + 4, "text-anchor": "end", class: "num", style: "fill:var(--ink-2);font:500 11px 'JetBrains Mono',monospace" }, tickText(v)));
  });

  // Label sumbu X: awal, tiap seperempat, dan menit terakhir.
  const xTicks = [...new Set([0, Math.round((n - 1) / 4), Math.round((n - 1) / 2), Math.round(((n - 1) * 3) / 4), n - 1])];
  xTicks.forEach((i, k) => {
    const anchor = k === 0 ? "start" : k === xTicks.length - 1 ? "end" : "middle";
    svg.appendChild(svgEl("text", { x: x(i), y: CHART_H - 6, "text-anchor": n > 1 ? anchor : "end", style: "fill:var(--ink-2);font:500 11px 'JetBrains Mono',monospace" }, minuteLabel(i, n)));
  });

  // Garis dan area dipotong di menit kosong (standby / sensor mati): celah
  // ditampilkan apa adanya, tidak disambung seolah ada data.
  const segments = [];
  let seg = [];
  values.forEach((v, i) => {
    if (Number.isFinite(v)) seg.push([x(i), y(v)]);
    else if (seg.length) { segments.push(seg); seg = []; }
  });
  if (seg.length) segments.push(seg);

  const baseY = y(lo);
  segments.forEach((pts) => {
    const line = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
    if (pts.length > 1) {
      svg.appendChild(svgEl("path", { d: `${line} L${pts[pts.length - 1][0].toFixed(1)},${baseY} L${pts[0][0].toFixed(1)},${baseY} Z`, style: "fill:var(--accent);fill-opacity:.12" }));
      svg.appendChild(svgEl("path", { d: line, fill: "none", style: "stroke:var(--accent)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    } else {
      svg.appendChild(svgEl("circle", { cx: pts[0][0], cy: pts[0][1], r: 2.5, style: "fill:var(--accent)" }));
    }
  });

  hist.geometry = { x, y, n, values, metric, width };
  drawCursor();
}

// Garis vertikal penunjuk menit, seperti garis tegak di referensi, plus
// tooltip nilai. Digambar ulang tanpa menggambar seluruh grafik.
function drawCursor() {
  const svg = hEl("history-svg");
  const tip = hEl("history-tip");
  svg.querySelectorAll("[data-cursor]").forEach((el) => el.remove());
  const g = hist.geometry;
  if (!g || hist.cursor === null) { if (tip) tip.hidden = true; return; }

  const i = Math.max(0, Math.min(g.n - 1, hist.cursor));
  const v = g.values[i];
  const cx = g.x(i);
  svg.appendChild(svgEl("line", { "data-cursor": "", x1: cx, x2: cx, y1: PAD.top, y2: CHART_H - PAD.bottom, style: "stroke:var(--ink)", "stroke-width": 1.5 }));
  if (Number.isFinite(v)) svg.appendChild(svgEl("circle", { "data-cursor": "", cx, cy: g.y(v), r: 4, style: "fill:var(--accent);stroke:var(--card)", "stroke-width": 2 }));

  tip.textContent = `${minuteLabel(i, g.n)} · ${Number.isFinite(v) ? withUnit(v, g.metric) : "tidak ada data"}`;
  tip.hidden = false;
  const tipW = tip.offsetWidth;
  tip.style.left = `${Math.max(0, Math.min(g.width - tipW, cx - tipW / 2))}px`;
  tip.style.top = "0px";
}

function cursorFromPointer(event) {
  const g = hist.geometry;
  if (!g) return;
  const rect = hEl("history-svg").getBoundingClientRect();
  const px = event.clientX - rect.left;
  const plotW = g.width - PAD.left - PAD.right;
  hist.cursor = Math.round(((px - PAD.left) / (plotW || 1)) * (g.n - 1));
  drawCursor();
}

function setupHistoryChart() {
  const chart = hEl("history-chart");
  if (!chart) return;
  chart.addEventListener("pointermove", cursorFromPointer);
  chart.addEventListener("pointerdown", cursorFromPointer);
  chart.addEventListener("pointerleave", () => { hist.cursor = null; drawCursor(); });
  chart.addEventListener("keydown", (event) => {
    const g = hist.geometry;
    if (!g) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const start = hist.cursor === null ? g.n - 1 : hist.cursor + (event.key === "ArrowLeft" ? -1 : 1);
      hist.cursor = Math.max(0, Math.min(g.n - 1, start));
      drawCursor();
    } else if (event.key === "Escape") {
      hist.cursor = null;
      drawCursor();
    }
  });
  chart.addEventListener("blur", () => { hist.cursor = null; drawCursor(); });

  let resizeTimer;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderHistory, 150); });
  renderHistory();
}

function applyHistory(payload) {
  clearTimeout(hist.emptyTimer);
  hist.data = payload;
  hist.state = "ready";
  renderHistory();
}

function historyWaiting() {
  if (hist.state === "ready") return;
  hist.state = "loading";
  renderHistory();
  clearTimeout(hist.emptyTimer);
  // Retained message datang seketika setelah subscribe; kalau tidak ada,
  // berarti ESP32 belum pernah mengirim riwayat.
  hist.emptyTimer = setTimeout(() => {
    if (hist.state === "loading") { hist.state = "empty"; renderHistory(); }
  }, HISTORY_EMPTY_AFTER_MS);
}

function historyDenied() {
  clearTimeout(hist.emptyTimer);
  hist.state = "denied";
  renderHistory();
}

function historyDisconnected() {
  if (hist.state === "ready") return; // data terakhir tetap berguna
  clearTimeout(hist.emptyTimer);
  hist.state = "disconnected";
  renderHistory();
}
