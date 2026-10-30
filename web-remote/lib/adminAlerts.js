const { safeParse } = require("./devices");

// Which units need the seller's attention, decided once per cron tick by
// api/monitor.js. Pure: takes what the broker and Supabase hold, returns the
// notifications to send and the new dedup state (retained on
// smartmeter/_admin/alerts), so each event is announced once.
//
// state: { "sem-xxxxxx": { offline: true, ota: "1.17.1|Unduhan terputus" } }

const OFFLINE_ALERT_MS = 24 * 60 * 60 * 1000;

function wibTime(iso) {
  return new Date(iso).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

// deviceValues: { id: { status, ota, ... } } from the broker
// lastSeen:     { id: ISO time the unit was last connected } from Supabase
function adminAlerts(deviceValues, stateRaw, lastSeen, now = Date.now()) {
  const state = safeParse(stateRaw, {});
  const next = {};
  const notifications = [];

  for (const [id, vals] of Object.entries(deviceValues)) {
    if (!vals.status) continue;
    const prev = state[id] || {};
    const cur = { offline: !!prev.offline, ota: prev.ota || null };

    const offline = vals.status === "offline";
    const seen = lastSeen[id] ? new Date(lastSeen[id]).getTime() : null;
    if (offline && !cur.offline && seen && now - seen > OFFLINE_ALERT_MS) {
      notifications.push({ title: `${id} offline lebih dari 1 hari`, body: `Terakhir online ${wibTime(lastSeen[id])} WIB.`, tag: `${id}-offline` });
      cur.offline = true;
    } else if (!offline && cur.offline) {
      notifications.push({ title: `${id} online lagi`, body: "Unit ini sudah terhubung kembali ke broker.", tag: `${id}-offline` });
      cur.offline = false;
    }

    // Only failures of an actual release; a check that could not reach
    // latest.json is the server's problem, not this unit's.
    const ota = safeParse(vals.ota, null);
    if (ota && ota.state === "failed" && ota.version) {
      const key = `${ota.version}|${ota.error || ""}`;
      if (key !== cur.ota) {
        notifications.push({ title: `Update gagal di ${id}`, body: `${ota.version}: ${ota.error || "tanpa keterangan"}`, tag: `${id}-ota` });
        cur.ota = key;
      }
    } else if (ota && ota.state !== "failed") {
      cur.ota = null;
    }

    if (cur.offline || cur.ota) next[id] = cur;
  }

  const changed = JSON.stringify(next) !== JSON.stringify(state);
  return { notifications, state: next, changed };
}

module.exports = { adminAlerts, OFFLINE_ALERT_MS };
