const { safeParse } = require("./devices");
const db = require("./supabase");

// Copies what the broker holds for each device into Supabase, so history
// outlives the broker's one retained hour. Every write is an upsert keyed on
// (device, minute) or (device, day): running it again, or with overlapping
// hours, rewrites the same rows instead of adding duplicates.

const METRICS = [
  ["power", "power"],
  ["voltage", "voltage"],
  ["current", "current"],
  ["frequency", "frequency"],
  ["pf", "pf"],
  ["chipTemperature", "chip_temp"],
];

// .../history: {"interval":60,"end":<epoch>,"power":[...oldest..newest], ...}.
// end is the publish time, so the newest slot is the minute that just closed.
function minuteRows(deviceId, raw) {
  const h = safeParse(raw, null);
  if (!h || !(h.end > 0) || h.interval !== 60) return []; // clock not synced yet: no timestamps to trust
  const n = Math.max(0, ...METRICS.map(([key]) => (Array.isArray(h[key]) ? h[key].length : 0)));
  const lastMinute = Math.floor(h.end / 60) * 60 - 60;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const row = { device_id: deviceId, ts: new Date((lastMinute - (n - 1 - i) * 60) * 1000).toISOString() };
    let any = false;
    for (const [key, col] of METRICS) {
      const v = Array.isArray(h[key]) ? h[key][i] : null;
      row[col] = Number.isFinite(v) ? v : null;
      if (row[col] !== null) any = true;
    }
    if (any) rows.push(row); // minutes in standby / without sensor stay absent
  }
  return rows;
}

function billingRows(deviceId, dailyRaw, dailyKwhRaw) {
  const rp = safeParse(dailyRaw, {});
  const kwh = safeParse(dailyKwhRaw, {});
  return Object.keys(rp).filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)).map((day) => ({
    device_id: deviceId,
    day,
    rp: Number(rp[day]) || 0,
    kwh: Number.isFinite(Number(kwh[day])) ? Number(kwh[day]) : null,
  }));
}

// deviceValues: { "sem-xxxxxx": { "status": ..., "history": ..., "billing/daily": ... } }
async function ingest(deviceValues) {
  if (!db.enabled()) return { skipped: "SUPABASE_SECRET_KEY belum diatur" };
  const ids = Object.keys(deviceValues).filter((id) => deviceValues[id].status);
  if (!ids.length) return { devices: 0, minutes: 0, days: 0 };
  const now = new Date().toISOString();
  // Every device gets a row (readings reference it); last_seen only moves while
  // it is actually connected.
  await db.rest("devices?on_conflict=id", { method: "POST", body: ids.map((id) => ({ id })), prefer: "resolution=ignore-duplicates,return=minimal" });
  const live = ids.filter((id) => deviceValues[id].status !== "offline");
  await db.upsert("devices", live.map((id) => ({ id, last_seen: now })), "id");

  let minutes = 0, days = 0;
  for (const id of ids) {
    const v = deviceValues[id];
    const m = minuteRows(id, v.history);
    const b = billingRows(id, v["billing/daily"], v["billing/daily_kwh"]);
    await db.upsert("readings_minute", m, "device_id,ts");
    await db.upsert("billing_daily", b, "device_id,day");
    minutes += m.length;
    days += b.length;
  }
  return { devices: ids.length, minutes, days };
}

module.exports = { ingest, minuteRows, billingRows };
