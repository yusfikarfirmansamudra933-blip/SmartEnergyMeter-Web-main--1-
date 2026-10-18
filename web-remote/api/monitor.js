const { DEVICE_RE, topic, chatTopic, safeParse, collectRetained, publishOn } = require("../lib/devices");
const Tariffs = require("../tariffs");

// Triggered periodically by an external cron (cron-job.org, every few
// minutes — Vercel Hobby only allows daily cron, see README). Each tick, for
// every meter that has ever connected:
// 1. Computes daily/weekly billing totals from the device's cumulative
//    energy reading and stores them as retained MQTT state, shared by every
//    browser that opens bill.html for that device.
// 2. Pushes Telegram alerts on offline/overload state CHANGES (dedup via
//    retained alert-state) to every chat linked to that device, plus a daily
//    and weekly usage summary at a fixed time.
// Devices are discovered from the broker itself (smartmeter/+/status), so a
// new unit needs no registration here.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const FILTERS = [
  "smartmeter/+/status",
  "smartmeter/+/data",
  "smartmeter/+/billing/#",
  "smartmeter/+/telegram/#",
  "smartmeter/_bot/chat/+",
];

// Topics from the single-device firmware (before 1.15.0). Carried over once
// into the first device that shows up under the new layout, then cleared.
const LEGACY = {
  "billing/daily": "smartmeter/billing/daily",
  "billing/weekly": "smartmeter/billing/weekly",
  "billing/daily_start": "smartmeter/billing/daily_start",
  "billing/weekly_start": "smartmeter/billing/weekly_start",
  "telegram/alert_state": "smartmeter/telegram/alert_state",
  "telegram/summary_state": "smartmeter/telegram/summary_state",
  "telegram/reminder": "smartmeter/telegram/reminder",
  "telegram/reminder_state": "smartmeter/telegram/reminder_state",
};
const LEGACY_CHAT_ID = "smartmeter/telegram/chatid";
const LEGACY_CLEAR_ONLY = ["smartmeter/data", "smartmeter/status", "smartmeter/history", "smartmeter/telegram/control_lockout"];

const REMINDER_HOUR_WIB = 8;
const MONTH_NAMES = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

async function sendTelegramMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

function num(value, digits) { return Number(value || 0).toFixed(digits); }
function formatRupiah(value) { return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(value) || 0); }

// WIB (UTC+7) wall-clock time as a Date whose getUTC* fields read as WIB —
// avoids depending on the serverless runtime's local timezone.
function nowWIB() { return new Date(Date.now() + 7 * 60 * 60 * 1000); }
function dayKeyOf(d) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`; }
function monthKeyOf(d) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; }
function weekOfMonth(d) { return Math.min(Math.floor((d.getUTCDate() - 1) / 7) + 1, 5); }

// One device's view of the tick: its retained values (keyed by the topic
// suffix, e.g. "billing/daily"), a way to save them, and its Telegram chats.
function makeDevice(id, values, client, chats) {
  const linked = Object.entries(chats).filter(([, rec]) => rec.devices.includes(id));
  return {
    id,
    get: (suffix) => values[suffix] || null,
    save: async (suffix, value) => {
      values[suffix] = value;
      try { await publishOn(client, topic(id, suffix), value, { retain: true }); }
      catch (err) { console.error(`Failed to save ${id}/${suffix}:`, err); }
    },
    chatIds: linked.map(([chatId]) => chatId),
    // Owners with several units see which one a message is about.
    label: (chatId) => (chats[chatId].devices.length > 1 ? `[${id}] ` : ""),
  };
}

async function notify(device, text) {
  for (const chatId of device.chatIds) {
    try { await sendTelegramMessage(chatId, device.label(chatId) + text); }
    catch (err) { console.error("sendTelegramMessage failed:", err); }
  }
}

// Computes today's/this-week's usage from the device's cumulative energy
// counter and republishes the shared billing state if anything changed.
// kWh is stored next to rupiah: once a device's tariff changes, rupiah divided
// by the new rate no longer gives back the energy of earlier days.
async function updateBilling(device, energy, wib) {
  const rate = Tariffs.fromPayload(device.get("billing/tariff")).rate;
  const dayKey = dayKeyOf(wib);
  const monthKey = monthKeyOf(wib);
  const week = weekOfMonth(wib);

  const dailyStart = safeParse(device.get("billing/daily_start"), {});
  const weeklyStart = safeParse(device.get("billing/weekly_start"), {});
  const dailyData = safeParse(device.get("billing/daily"), {});
  const weeklyData = safeParse(device.get("billing/weekly"), {});
  const dailyKwh = safeParse(device.get("billing/daily_kwh"), {});
  const weeklyKwh = safeParse(device.get("billing/weekly_kwh"), {});
  let changed = false;

  if (dailyStart[dayKey] === undefined) { dailyStart[dayKey] = energy; changed = true; }
  let usedDaily = energy - dailyStart[dayKey];
  if (usedDaily < 0) { dailyStart[dayKey] = energy; usedDaily = 0; changed = true; }
  // Only today is recomputed, so a new rate never rewrites earlier days.
  const dailyRp = usedDaily * rate;
  if (dailyData[dayKey] !== dailyRp) { dailyData[dayKey] = dailyRp; changed = true; }
  if (dailyKwh[dayKey] !== usedDaily) { dailyKwh[dayKey] = usedDaily; changed = true; }

  if (!weeklyStart[monthKey]) weeklyStart[monthKey] = {};
  if (weeklyStart[monthKey]["week" + week] === undefined) { weeklyStart[monthKey]["week" + week] = energy; changed = true; }
  let usedWeekly = energy - weeklyStart[monthKey]["week" + week];
  if (usedWeekly < 0) { weeklyStart[monthKey]["week" + week] = energy; usedWeekly = 0; changed = true; }
  if (!weeklyData[monthKey]) weeklyData[monthKey] = {};
  const weeklyRp = usedWeekly * rate;
  if (weeklyData[monthKey]["week" + week] !== weeklyRp) { weeklyData[monthKey]["week" + week] = weeklyRp; changed = true; }
  if (!weeklyKwh[monthKey]) weeklyKwh[monthKey] = {};
  if (weeklyKwh[monthKey]["week" + week] !== usedWeekly) { weeklyKwh[monthKey]["week" + week] = usedWeekly; changed = true; }

  if (changed) {
    await Promise.all([
      device.save("billing/daily_start", JSON.stringify(dailyStart)),
      device.save("billing/weekly_start", JSON.stringify(weeklyStart)),
      device.save("billing/daily", JSON.stringify(dailyData)),
      device.save("billing/weekly", JSON.stringify(weeklyData)),
      device.save("billing/daily_kwh", JSON.stringify(dailyKwh)),
      device.save("billing/weekly_kwh", JSON.stringify(weeklyKwh)),
    ]);
  }

  return { dailyData, weeklyData };
}

// Sends a once-a-day recap (21:00 WIB) and a once-a-week recap (Sunday
// 21:00 WIB), each guarded by a retained "already sent today" date so a
// 5-minute cron doesn't fire it more than once.
// Energy for a period: the stored kWh when the cron already wrote it, else
// rupiah back-converted at the current rate (history from before kWh maps).
function kwhOf(device, kwhValue, rp) {
  if (Number.isFinite(Number(kwhValue))) return Number(kwhValue);
  return rp / Tariffs.fromPayload(device.get("billing/tariff")).rate;
}

async function checkSummaries(device, wib, dailyData, weeklyData) {
  const state = safeParse(device.get("telegram/summary_state"), {});
  const todayKey = dayKeyOf(wib);
  const hour = wib.getUTCHours();
  let changed = false;

  if (hour === 21 && state.lastDaily !== todayKey) {
    const rp = Number(dailyData[todayKey] || 0);
    const kwh = kwhOf(device, safeParse(device.get("billing/daily_kwh"), {})[todayKey], rp);
    await notify(device, [
      "📋 Ringkasan Hari Ini",
      `${wib.getUTCDate()} ${MONTH_NAMES[wib.getUTCMonth()]} ${wib.getUTCFullYear()}`,
      `Energi: ${kwh.toFixed(3)} kWh`,
      `Estimasi biaya: ${formatRupiah(rp)}`,
    ].join("\n"));
    state.lastDaily = todayKey;
    changed = true;
  }

  if (wib.getUTCDay() === 0 && hour === 21 && state.lastWeekly !== todayKey) {
    const week = weekOfMonth(wib);
    const rp = Number((weeklyData[monthKeyOf(wib)] || {})["week" + week] || 0);
    const kwh = kwhOf(device, (safeParse(device.get("billing/weekly_kwh"), {})[monthKeyOf(wib)] || {})["week" + week], rp);
    await notify(device, [
      "📅 Ringkasan Minggu Ini",
      `Minggu ${week}, ${MONTH_NAMES[wib.getUTCMonth()]} ${wib.getUTCFullYear()}`,
      `Energi: ${kwh.toFixed(3)} kWh`,
      `Estimasi biaya: ${formatRupiah(rp)}`,
    ].join("\n"));
    state.lastWeekly = todayKey;
    changed = true;
  }

  if (changed) await device.save("telegram/summary_state", JSON.stringify(state));
}

// User-set reminder (day-of-month + message, from the bot's /reminder
// command) fired once a month at a fixed hour, deduped the same way as
// checkSummaries: a retained "month already sent" marker.
async function checkReminder(device, wib) {
  const reminder = safeParse(device.get("telegram/reminder"), null);
  if (!reminder || !reminder.day || !reminder.message) return;

  const state = safeParse(device.get("telegram/reminder_state"), {});
  const monthKey = monthKeyOf(wib);
  if (wib.getUTCDate() !== reminder.day || wib.getUTCHours() !== REMINDER_HOUR_WIB || state.lastSent === monthKey) {
    return;
  }

  await notify(device, `🔔 Pengingat Pembayaran Listrik\n${reminder.message}`);
  state.lastSent = monthKey;
  await device.save("telegram/reminder_state", JSON.stringify(state));
}

async function checkAlerts(device) {
  // "standby" (sensor paused from the dashboard) is not offline: the device is
  // still connected, it just isn't publishing, so the retained data is stale.
  const status = device.get("status");
  const isStandby = status === "standby";
  const isOffline = status !== "online" && !isStandby;
  const isLive = status === "online";
  const data = safeParse(device.get("data"), null);

  const alertState = safeParse(device.get("telegram/alert_state"), {});
  const newState = { ...alertState };
  let changed = false;
  const notifications = [];

  if (isOffline && !alertState.offline) {
    notifications.push("🔴 Smart Energy Meter offline / kehilangan koneksi.");
    newState.offline = true;
    // Standby does not survive a reboot, so there's nothing to "resume" later.
    newState.standby = false;
    changed = true;
  } else if (!isOffline && alertState.offline) {
    notifications.push("🟢 Smart Energy Meter online kembali.");
    newState.offline = false;
    changed = true;
  }

  if (!isOffline) {
    if (isStandby && !alertState.standby) {
      notifications.push("⏸️ Pemantauan dihentikan dari dashboard (mode standby).");
      newState.standby = true;
      changed = true;
    } else if (isLive && alertState.standby) {
      notifications.push("▶️ Pemantauan aktif kembali.");
      newState.standby = false;
      changed = true;
    }
  }

  if (isLive && data) {
    const overloaded = !!data.trip;
    if (overloaded && !alertState.overload) {
      notifications.push(`⚠️ Daya melebihi batas! ${num(data.power, 0)} W (batas ${num(data.limit, 0)} W)`);
      newState.overload = true;
      changed = true;
    } else if (!overloaded && alertState.overload) {
      notifications.push(`✅ Daya kembali normal: ${num(data.power, 0)} W (batas ${num(data.limit, 0)} W)`);
      newState.overload = false;
      changed = true;
    }
  }

  for (const text of notifications) await notify(device, text);
  if (changed) await device.save("telegram/alert_state", JSON.stringify(newState));
  return notifications.length;
}

async function processDevice(device) {
  const status = device.get("status");
  const isLive = status === "online";
  const data = safeParse(device.get("data"), null);

  // Billing tracks regardless of whether any Telegram chat is linked — it's
  // shared state for bill.html, not a notification.
  let dailyData = safeParse(device.get("billing/daily"), {});
  let weeklyData = safeParse(device.get("billing/weekly"), {});
  if (isLive && data && Number.isFinite(Number(data.energy))) {
    ({ dailyData, weeklyData } = await updateBilling(device, Number(data.energy), nowWIB()));
  }

  const result = { id: device.id, status, chats: device.chatIds.length, notifications: 0 };
  if (!device.chatIds.length) return result;

  result.notifications = await checkAlerts(device);
  try { await checkSummaries(device, nowWIB(), dailyData, weeklyData); }
  catch (err) { console.error("checkSummaries failed:", err); }
  try { await checkReminder(device, nowWIB()); }
  catch (err) { console.error("checkReminder failed:", err); }
  return result;
}

// Merges two { key: value } maps, the device's own values winning.
function mergeFlat(legacyRaw, ownRaw) {
  return { ...safeParse(legacyRaw, {}), ...safeParse(ownRaw, {}) };
}

// Same, one level deeper: { "YYYY-MM": { week1: ... } }.
function mergeNested(legacyRaw, ownRaw) {
  const legacy = safeParse(legacyRaw, {});
  const own = safeParse(ownRaw, {});
  const out = { ...legacy };
  for (const [month, weeks] of Object.entries(own)) out[month] = { ...(legacy[month] || {}), ...weeks };
  return out;
}

// Moves the pre-1.15.0 single-device state into the one device now on the
// broker. Skipped while more than one device exists, since it would be a
// guess which unit the old history belongs to.
async function migrateLegacy(values, deviceValues, chats, client) {
  const hasLegacy = Object.values(LEGACY).some((t) => values[t]) || values[LEGACY_CHAT_ID];
  const ids = Object.keys(deviceValues);
  if (!hasLegacy || ids.length !== 1) return null;

  const id = ids[0];
  const own = deviceValues[id];
  const merged = {
    "billing/daily": mergeFlat(values[LEGACY["billing/daily"]], own["billing/daily"]),
    "billing/daily_start": mergeFlat(values[LEGACY["billing/daily_start"]], own["billing/daily_start"]),
    "billing/weekly": mergeNested(values[LEGACY["billing/weekly"]], own["billing/weekly"]),
    "billing/weekly_start": mergeNested(values[LEGACY["billing/weekly_start"]], own["billing/weekly_start"]),
  };
  for (const [suffix, value] of Object.entries(merged)) {
    own[suffix] = JSON.stringify(value);
    await publishOn(client, topic(id, suffix), own[suffix], { retain: true });
  }
  for (const suffix of ["telegram/alert_state", "telegram/summary_state", "telegram/reminder", "telegram/reminder_state"]) {
    const legacy = values[LEGACY[suffix]];
    if (legacy && !own[suffix]) {
      own[suffix] = legacy;
      await publishOn(client, topic(id, suffix), legacy, { retain: true });
    }
  }

  // The chat that used the bot before keeps getting this device's alerts.
  const legacyChat = values[LEGACY_CHAT_ID];
  if (legacyChat) {
    const rec = chats[legacyChat] || { active: null, devices: [] };
    if (!rec.devices.includes(id)) rec.devices.push(id);
    if (!rec.active) rec.active = id;
    chats[legacyChat] = rec;
    await publishOn(client, chatTopic(legacyChat), JSON.stringify(rec), { retain: true });
  }

  // An empty retained payload deletes the retained message.
  for (const t of [...Object.values(LEGACY), LEGACY_CHAT_ID, ...LEGACY_CLEAR_ONLY]) {
    await publishOn(client, t, "", { retain: true });
  }
  return id;
}

module.exports = async (req, res) => {
  const filters = [...FILTERS, ...Object.values(LEGACY), LEGACY_CHAT_ID];
  const { values, client } = await collectRetained(filters, { prefix: "monitor" });

  // smartmeter/<id>/<suffix> -> deviceValues[id][suffix]
  const deviceValues = {};
  const chats = {};
  for (const [t, payload] of Object.entries(values)) {
    const [, first, ...rest] = t.split("/");
    if (first === "_bot" && rest[0] === "chat" && rest[1]) {
      const rec = safeParse(payload, null);
      if (rec && Array.isArray(rec.devices)) chats[rest[1]] = rec;
    } else if (DEVICE_RE.test(first) && rest.length) {
      (deviceValues[first] ||= {})[rest.join("/")] = payload;
    }
  }

  let migratedTo = null;
  try { migratedTo = await migrateLegacy(values, deviceValues, chats, client); }
  catch (err) { console.error("Legacy migration failed:", err); }

  const results = [];
  for (const [id, vals] of Object.entries(deviceValues)) {
    // Only devices that have connected at least once (status is set on
    // connect and by the Last Will); stray billing/telegram leftovers alone
    // are not a device.
    if (!vals.status) continue;
    try { results.push(await processDevice(makeDevice(id, vals, client, chats))); }
    catch (err) { console.error(`Device ${id} failed:`, err); }
  }

  client.end();
  res.status(200).json({ ok: true, migratedTo, devices: results });
};
