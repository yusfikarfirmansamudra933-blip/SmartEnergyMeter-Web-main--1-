const { normalizeDeviceId, topic, safeParse, collectRetained, publishOn, publishAndWait } = require("../lib/devices");
const db = require("../lib/supabase");

// Data for admin.html: every unit ever seen (Supabase plus whatever the broker
// holds), its owners, firmware and update state, and the commands only the
// seller needs. Admins are the accounts listed in ADMIN_EMAILS (comma
// separated) in Vercel.
//
//   GET  ?probe=1                        -> { admin }   (devices.html shows the link)
//   GET                                  -> { latest, devices: [...] }
//   POST { action: "update", device }    -> asks one unit to check for an update now
//   POST { action: "update-all" }        -> same, for every unit that is connected
//   POST { action: "restart", device }

const LIVE_TOPICS = ["status", "info", "ota", "data"];

function admins() {
  return (process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

async function adminUser(req) {
  const user = await db.userFromRequest(req);
  return user && user.email && admins().includes(user.email.toLowerCase()) ? user : null;
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return safeParse(req.body, {});
}

// latest.json without the key material: the page only needs what is released, when, and for whom.
async function latestRelease(req) {
  try {
    const res = await fetch(`https://${req.headers.host}/firmware/latest.json`, { cache: "no-store" });
    if (!res.ok) return null;
    const m = await res.json();
    return { version: m.version, released: m.released || null, devices: Array.isArray(m.devices) ? m.devices : null };
  } catch {
    return null;
  }
}

// { "sem-xxxxxx": { status, info, ota, data } } from smartmeter/+/<topic>.
function groupLive(values) {
  const out = {};
  for (const [t, payload] of Object.entries(values)) {
    const [, id, ...rest] = t.split("/");
    const key = rest.join("/");
    if (!normalizeDeviceId(id) || !LIVE_TOPICS.includes(key)) continue;
    (out[id] = out[id] || {})[key] = payload;
  }
  return out;
}

async function overview(req, res) {
  const [latest, live, devices, owners, users] = await Promise.all([
    latestRelease(req),
    collectRetained(LIVE_TOPICS.map((t) => `smartmeter/+/${t}`), { prefix: "admin" }).then(({ values, client }) => { client.end(true); return groupLive(values); }),
    db.rest("devices?select=id,first_seen,last_seen"),
    db.rest("device_owners?select=device_id,user_id,name,created_at&order=created_at"),
    db.listUsers(),
  ]);

  const emails = new Map(users.map((u) => [u.id, u.email]));
  const rows = new Map((devices || []).map((d) => [d.id, d]));
  const ids = [...new Set([...rows.keys(), ...Object.keys(live)])].sort();

  const list = ids.map((id) => {
    const l = live[id] || {};
    const info = safeParse(l.info, {});
    const data = safeParse(l.data, {});
    const row = rows.get(id) || {};
    return {
      id,
      status: l.status || null,
      firmware: info.fw || null,
      ip: info.ip || null,
      rssi: Number.isFinite(info.rssi) ? info.rssi : null,
      ota: safeParse(l.ota, null),
      power: l.status === "online" && Number.isFinite(data.power) ? data.power : null,
      firstSeen: row.first_seen || null,
      lastSeen: row.last_seen || null,
      owners: (owners || []).filter((o) => o.device_id === id).map((o) => ({ email: emails.get(o.user_id) || null, name: o.name, since: o.created_at })),
    };
  });

  res.status(200).json({ latest, devices: list });
}

async function command(req, res) {
  const { action, device } = readBody(req);

  if (action === "update-all") {
    const { values, client } = await collectRetained(["smartmeter/+/status"], { prefix: "admin" });
    const online = Object.entries(groupLive(values))
      .filter(([, l]) => l.status && l.status !== "offline")
      .map(([id]) => id);
    try {
      for (const id of online) await publishOn(client, topic(id, "cmd/update"), "check");
    } finally {
      client.end(true);
    }
    res.status(200).json({ ok: true, sent: online.length });
    return;
  }

  const deviceId = normalizeDeviceId(device);
  if (!deviceId) {
    res.status(400).json({ error: "ID perangkat tidak valid." });
    return;
  }
  if (action !== "update" && action !== "restart") {
    res.status(400).json({ error: "Perintah tidak dikenal." });
    return;
  }
  // Not retained: a retained restart would reboot the unit on every reconnect.
  await publishAndWait(topic(deviceId, action === "update" ? "cmd/update" : "cmd/restart"), action === "update" ? "check" : "1", { prefix: "admin" });
  res.status(200).json({ ok: true });
}

module.exports = async (req, res) => {
  if (!db.enabled()) {
    res.status(503).json({ error: "SUPABASE_SECRET_KEY belum diatur di Vercel." });
    return;
  }
  const user = await adminUser(req);

  if (req.method === "GET" && req.query && req.query.probe) {
    res.status(200).json({ admin: !!user });
    return;
  }
  if (!user) {
    res.status(403).json({ error: admins().length ? "Akun ini bukan admin." : "Belum ada admin. Isi ADMIN_EMAILS di pengaturan Vercel." });
    return;
  }

  try {
    if (req.method === "GET") await overview(req, res);
    else if (req.method === "POST") await command(req, res);
    else res.status(405).json({ error: "Gunakan GET atau POST." });
  } catch (err) {
    console.error("Admin request failed:", err);
    res.status(502).json({ error: "Gagal menghubungi broker atau database." });
  }
};
