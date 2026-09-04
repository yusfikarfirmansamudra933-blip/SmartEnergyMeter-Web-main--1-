"use strict";

// Read-only user (subscribe-only, cannot publish) — see web-remote/script.js.
const MQTT_WS_URL = "wss://l660c516.ala.eu-central-1.emqxsl.com:8084/mqtt";
const MQTT_USERNAME = "smartenergymeterweb";
const MQTT_PASSWORD = "sMch!JtGn5gpYD4";
// Billing history is computed server-side (api/monitor.js, run by an
// external cron) and shared via these retained topics — every browser
// reads the SAME data, instead of each one tracking its own copy in
// localStorage (which meant your bill history didn't follow you between
// devices).
const TOPIC_BILLING_DAILY = "smartmeter/billing/daily";
const TOPIC_BILLING_WEEKLY = "smartmeter/billing/weekly";

const $ = (id) => document.getElementById(id);
const monthNames = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const monthShort = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

let weeklyData = {};
let dailyData = {};
let selectedMonth = new Date().getMonth();
const selectedYear = new Date().getFullYear();

function formatRupiah(value) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(value) || 0);
}

// Must match ELECTRICITY_RATE in api/monitor.js — there's no per-user rate
// setting (no UI for it), this is just the single source of truth.
function getElectricityRate() { return 1500; }

function monthKey(year, monthIndex) { return `${year}-${String(monthIndex + 1).padStart(2, "0")}`; }
function dayKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }

function getWeeklyBills(year, monthIndex) {
  const saved = weeklyData[monthKey(year, monthIndex)];
  if (saved && typeof saved === "object") return [1, 2, 3, 4, 5].map((w) => Number(saved["week" + w] || 0));
  return [0, 0, 0, 0, 0];
}

function getMonthTotal(year, monthIndex) {
  return getWeeklyBills(year, monthIndex).reduce((sum, v) => sum + v, 0);
}

function getPartialMonthTotal(year, monthIndex, uptoDay) {
  let total = 0;
  for (let d = 1; d <= uptoDay; d++) total += Number(dailyData[dayKey(new Date(year, monthIndex, d))] || 0);
  return total;
}

// --- Hero card: bulan berjalan, progres, proyeksi ---

function renderHero() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const total = getMonthTotal(year, month);
  const rate = getElectricityRate();
  const kwh = rate > 0 ? total / rate : 0;

  $("heroMonthLabel").textContent = `${monthNames[month]} ${year}`;
  $("heroTotal").textContent = formatRupiah(total);
  $("heroKwhRate").textContent = `${kwh.toFixed(3)} kWh • ${formatRupiah(rate)}/kWh`;

  const progress = Math.min(100, (day / daysInMonth) * 100);
  const circumference = 314.16;
  $("heroGauge").setAttribute("stroke-dashoffset", (circumference * (1 - progress / 100)).toFixed(2));
  $("heroGaugeValue").textContent = `${progress.toFixed(0)}%`;

  const projected = day > 0 ? (total / day) * daysInMonth : 0;
  $("projectionValue").textContent = total > 0 ? formatRupiah(projected) : "Belum ada data";

  const comparisonPct = computeComparisonPercent(year, month, day);
  const badge = $("heroBadge");
  const badgeText = $("heroBadgeText");
  if (comparisonPct === null) {
    badgeText.textContent = "Belum ada pembanding";
    badge.className = "inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-surface-container-high text-on-surface-variant";
  } else if (comparisonPct <= 0) {
    badgeText.textContent = `Hemat ${Math.abs(comparisonPct).toFixed(1)}%`;
    badge.className = "inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary-container/15 text-primary";
  } else {
    badgeText.textContent = `Naik ${comparisonPct.toFixed(1)}%`;
    badge.className = "inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-tertiary-container/15 text-tertiary";
  }
}

function computeComparisonPercent(year, month, day) {
  const thisPartial = getPartialMonthTotal(year, month, day);
  const prevDate = new Date(year, month - 1, 1);
  const prevDaysInMonth = new Date(prevDate.getFullYear(), prevDate.getMonth() + 1, 0).getDate();
  const prevPartial = getPartialMonthTotal(prevDate.getFullYear(), prevDate.getMonth(), Math.min(day, prevDaysInMonth));
  if (prevPartial <= 0) return null;
  return ((thisPartial - prevPartial) / prevPartial) * 100;
}

function renderInsight() {
  const now = new Date();
  const pct = computeComparisonPercent(now.getFullYear(), now.getMonth(), now.getDate());
  const icon = $("insightIcon");
  const text = $("insightText");
  if (pct === null) {
    icon.textContent = "info";
    icon.className = "material-symbols-outlined text-[18px] text-secondary shrink-0";
    text.innerHTML = "Belum cukup data bulan lalu untuk dibandingkan.";
    return;
  }
  const hemat = pct <= 0;
  icon.textContent = hemat ? "trending_down" : "trending_up";
  icon.className = `material-symbols-outlined text-[18px] ${hemat ? "text-primary" : "text-tertiary"} shrink-0`;
  text.innerHTML = `Penggunaan <span class="${hemat ? "text-primary" : "text-tertiary"} font-semibold">${Math.abs(pct).toFixed(1)}% ${hemat ? "lebih hemat" : "lebih tinggi"}</span> dibandingkan bulan lalu pada periode hari yang sama.`;
}

// --- Tren pengeluaran: bar chart 12 bulan ---

function renderTrendBars() {
  const container = $("trendBars");
  container.innerHTML = "";
  const now = new Date();
  const totals = monthNames.map((_, m) => getMonthTotal(selectedYear, m));
  const max = Math.max(...totals, 1);

  totals.forEach((total, m) => {
    const heightPct = Math.max(4, (total / max) * 100);
    const isCurrent = m === now.getMonth() && selectedYear === now.getFullYear();
    const isFuture = selectedYear === now.getFullYear() && m > now.getMonth();
    const col = document.createElement("div");
    col.className = "flex flex-col items-center flex-1 h-full justify-end group";
    col.innerHTML = `
      <span class="font-label-telemetry text-[10px] ${isCurrent ? "text-primary font-semibold" : "text-text-dim opacity-0 group-hover:opacity-100"} transition-opacity">${total > 0 ? formatRupiah(total) : ""}</span>
      <div class="w-full max-w-[28px] ${isCurrent ? "bg-gradient-to-t from-secondary-container to-primary shadow-md shadow-primary/30" : isFuture ? "bg-surface-container-high opacity-40" : "bg-surface-container-highest hover:bg-secondary/40"} rounded-t transition-all" style="height:${isFuture && total === 0 ? 12 : heightPct}%;"></div>
      <span class="font-metric-unit text-metric-unit ${isCurrent ? "text-primary font-bold" : "text-on-surface-variant"} mt-2">${monthShort[m]}</span>
    `;
    container.appendChild(col);
  });
}

// --- Rincian mingguan: tab bulan + kartu minggu ---

function weekStatusLabel(bill, weekBills, isCurrentWeek) {
  if (isCurrentWeek) return { text: "Berjalan", cls: "text-secondary" };
  const valid = weekBills.filter((b) => b > 0);
  if (!valid.length || bill <= 0) return { text: "-", cls: "text-text-dim" };
  const avg = valid.reduce((s, v) => s + v, 0) / valid.length;
  if (bill > avg * 1.15) return { text: "Puncak Pemakaian", cls: "text-tertiary" };
  if (bill < avg * 0.85) return { text: "Hemat", cls: "text-primary" };
  return { text: "Stabil", cls: "text-primary" };
}

function renderMonthTabs() {
  const container = $("month-tabs");
  container.innerHTML = "";
  monthShort.forEach((label, m) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.month = m;
    btn.textContent = label;
    btn.className = tabClass(m === selectedMonth);
    btn.addEventListener("click", () => {
      selectedMonth = m;
      renderMonthTabs();
      renderWeekCards();
    });
    container.appendChild(btn);
  });
}

function tabClass(active) {
  return active
    ? "px-3.5 py-1.5 rounded-lg bg-primary text-on-primary font-label-telemetry text-label-telemetry uppercase font-bold shadow-md shadow-primary/20 shrink-0"
    : "px-3.5 py-1.5 rounded-lg bg-surface-container text-on-surface-variant font-label-telemetry text-label-telemetry uppercase transition-all hover:bg-surface-container-high shrink-0";
}

function renderWeekCards() {
  const container = $("weekCards");
  container.innerHTML = "";
  const now = new Date();
  const isCurrentMonth = selectedMonth === now.getMonth() && selectedYear === now.getFullYear();
  const currentWeek = isCurrentMonth ? Math.min(Math.floor((now.getDate() - 1) / 7) + 1, 5) : -1;
  const lastDayOfMonth = new Date(selectedYear, selectedMonth + 1, 0).getDate();
  const bills = getWeeklyBills(selectedYear, selectedMonth);
  const rate = getElectricityRate();

  let hasAny = false;
  for (let w = 0; 1 + w * 7 <= lastDayOfMonth && w < 5; w++) {
    const bill = bills[w];
    const kwh = rate > 0 ? bill / rate : 0;
    const start = new Date(selectedYear, selectedMonth, 1 + w * 7);
    const end = new Date(selectedYear, selectedMonth, Math.min(1 + w * 7 + 6, lastDayOfMonth));
    const status = weekStatusLabel(bill, bills, currentWeek === w + 1);
    if (bill > 0 || currentWeek === w + 1) hasAny = true;

    const card = document.createElement("div");
    card.className = "w-full rounded-xl bg-surface-container p-gutter-sm flex items-center justify-between hover:bg-surface-container-high transition-colors";
    card.innerHTML = `
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-lg bg-surface-charcoal flex flex-col items-center justify-center shrink-0">
          <span class="font-label-telemetry text-[10px] text-text-dim leading-none">MGG</span>
          <span class="font-title-md text-title-md text-secondary font-bold leading-none">${String(w + 1).padStart(2, "0")}</span>
        </div>
        <div class="flex flex-col">
          <span class="font-body-md text-body-md text-on-surface font-semibold">Minggu ${w + 1} (${start.toLocaleDateString("id-ID")} - ${end.toLocaleDateString("id-ID")})</span>
          <span class="font-metric-unit text-metric-unit text-text-dim">${kwh.toFixed(1)} kWh</span>
        </div>
      </div>
      <div class="flex flex-col items-end">
        <span class="font-headline-metric-mobile text-[18px] ${currentWeek === w + 1 ? "text-primary" : "text-on-surface"} font-semibold">${formatRupiah(bill)}</span>
        <span class="font-label-telemetry text-label-telemetry ${status.cls}">${status.text}</span>
      </div>
    `;
    container.appendChild(card);
  }

  if (!hasAny) {
    const empty = document.createElement("div");
    empty.className = "w-full rounded-xl bg-surface-container p-card-pad text-center text-on-surface-variant font-body-sm text-body-sm";
    empty.textContent = "Belum ada data tagihan mingguan untuk bulan ini.";
    container.appendChild(empty);
  }
}

// --- Ekspor Excel / PDF (untuk bulan yang sedang dipilih di tab) ---

function downloadMonthExcel() {
  if (typeof XLSX === "undefined") return;
  const year = selectedYear, monthIndex = selectedMonth;
  const rate = getElectricityRate();
  const lastDayOfMonth = new Date(year, monthIndex + 1, 0).getDate();

  const rows = [["Minggu", "Rincian", "Hari 1", "Hari 2", "Hari 3", "Hari 4", "Hari 5", "Hari 6", "Hari 7", "Total"]];
  const merges = [];
  let rowIndex = 1;
  let grandTotal = 0;

  for (let week = 0; 1 + week * 7 <= lastDayOfMonth && week < 5; week++) {
    const weekStartDay = 1 + week * 7;
    const weekEndDay = Math.min(weekStartDay + 6, lastDayOfMonth);
    const weekStart = new Date(year, monthIndex, weekStartDay);
    const weekEnd = new Date(year, monthIndex, weekEndDay);
    const weekLabel = `Minggu ${week + 1}\n${weekStart.toLocaleDateString("id-ID")} - ${weekEnd.toLocaleDateString("id-ID")}`;

    const kwhRow = [weekLabel, "Pemakaian (kWh)"];
    const rpRow = ["", "Tagihan (Rp)"];
    let weekTotal = 0;

    for (let day = weekStartDay; day <= weekStartDay + 6; day++) {
      if (day > weekEndDay) { kwhRow.push(""); rpRow.push(""); continue; }
      const date = new Date(year, monthIndex, day);
      const dayBill = Number(dailyData[dayKey(date)] || 0);
      const dayKwh = rate > 0 ? dayBill / rate : 0;
      kwhRow.push(Number(dayKwh.toFixed(3)));
      rpRow.push(Math.round(dayBill));
      weekTotal += dayBill;
    }

    kwhRow.push(rate > 0 ? Number((weekTotal / rate).toFixed(3)) : 0);
    rpRow.push(Math.round(weekTotal));
    rows.push(kwhRow, rpRow);
    merges.push({ s: { r: rowIndex, c: 0 }, e: { r: rowIndex + 1, c: 0 } });
    rowIndex += 2;
    grandTotal += weekTotal;
  }

  rows.push(["Total Bulan", "", "", "", "", "", "", "", "", Math.round(grandTotal)]);

  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["!cols"] = [{ wch: 22 }, { wch: 16 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 14 }];
  sheet["!merges"] = merges;

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Rincian");
  XLSX.writeFile(workbook, `Tagihan-${monthNames[monthIndex]}-${year}.xlsx`);
}

function downloadMonthPdf() {
  if (typeof window.jspdf === "undefined") return;
  const year = selectedYear, monthIndex = selectedMonth;
  const rate = getElectricityRate();
  const lastDayOfMonth = new Date(year, monthIndex + 1, 0).getDate();

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape" });
  doc.setFontSize(14);
  doc.text(`Tagihan Listrik - ${monthNames[monthIndex]} ${year}`, 14, 15);

  const head = [["Minggu", "Rincian", "Hari 1", "Hari 2", "Hari 3", "Hari 4", "Hari 5", "Hari 6", "Hari 7", "Total"]];
  const body = [];
  let grandTotal = 0;

  for (let week = 0; 1 + week * 7 <= lastDayOfMonth && week < 5; week++) {
    const weekStartDay = 1 + week * 7;
    const weekEndDay = Math.min(weekStartDay + 6, lastDayOfMonth);
    const weekStart = new Date(year, monthIndex, weekStartDay);
    const weekEnd = new Date(year, monthIndex, weekEndDay);
    const weekLabel = `Minggu ${week + 1}\n${weekStart.toLocaleDateString("id-ID")} - ${weekEnd.toLocaleDateString("id-ID")}`;

    const kwhRow = [weekLabel, "Pemakaian (kWh)"];
    const rpRow = [weekLabel, "Tagihan (Rp)"];
    let weekTotal = 0;

    for (let day = weekStartDay; day <= weekStartDay + 6; day++) {
      if (day > weekEndDay) { kwhRow.push(""); rpRow.push(""); continue; }
      const date = new Date(year, monthIndex, day);
      const dayBill = Number(dailyData[dayKey(date)] || 0);
      const dayKwh = rate > 0 ? dayBill / rate : 0;
      kwhRow.push(dayKwh.toFixed(3));
      rpRow.push(formatRupiah(dayBill));
      weekTotal += dayBill;
    }

    kwhRow.push(rate > 0 ? (weekTotal / rate).toFixed(3) : "0");
    rpRow.push(formatRupiah(weekTotal));
    body.push(kwhRow, rpRow);
    grandTotal += weekTotal;
  }

  body.push(["Total Bulan", "", "", "", "", "", "", "", "", formatRupiah(grandTotal)]);

  doc.autoTable({
    head, body, startY: 22,
    styles: { fontSize: 8, cellPadding: 2, valign: "middle" },
    headStyles: { fillColor: [20, 138, 67] },
    columnStyles: { 0: { cellWidth: 40 }, 1: { cellWidth: 30 } },
  });
  doc.save(`Tagihan-${monthNames[monthIndex]}-${year}.pdf`);
}

function renderAll() {
  renderHero();
  renderInsight();
  renderTrendBars();
  renderWeekCards();
}

// --- MQTT ---

let mqttClient = null;
function connectMQTT() {
  mqttClient = mqtt.connect(MQTT_WS_URL, {
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD,
    clientId: "bill-" + Math.random().toString(16).slice(2),
    reconnectPeriod: 3000,
  });
  mqttClient.on("connect", () => {
    $("brokerBadge").textContent = "Terhubung";
    mqttClient.subscribe(TOPIC_BILLING_DAILY);
    mqttClient.subscribe(TOPIC_BILLING_WEEKLY);
  });
  mqttClient.on("reconnect", () => { $("brokerBadge").textContent = "Mencoba ulang"; });
  mqttClient.on("close", () => { $("brokerBadge").textContent = "Terputus"; });
  mqttClient.on("message", (topic, message) => {
    try {
      const parsed = JSON.parse(message.toString());
      if (topic === TOPIC_BILLING_DAILY) dailyData = parsed;
      else if (topic === TOPIC_BILLING_WEEKLY) weeklyData = parsed;
      else return;
      renderAll();
    } catch { /* ignore malformed packet */ }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  $("downloadExcelBtn").addEventListener("click", downloadMonthExcel);
  $("downloadPdfBtn").addEventListener("click", downloadMonthPdf);
  renderMonthTabs();
  renderAll();
  connectMQTT();
});
