const { normalizeDeviceId, safeParse, checkPin } = require("../lib/devices");
const db = require("../lib/supabase");

// Adds a meter to the signed-in account. Proving the unit's PIN once (the one
// on its label) is what makes someone an owner; after that the account can
// read the meter's long history and control it without the PIN.

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return safeParse(req.body, {});
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Gunakan POST." });
    return;
  }
  if (!db.enabled() || !process.env.CONTROL_SECRET) {
    res.status(503).json({ error: "Akun belum diaktifkan di server (SUPABASE_SECRET_KEY atau CONTROL_SECRET belum diatur di Vercel)." });
    return;
  }

  const user = await db.userFromRequest(req);
  if (!user) {
    res.status(401).json({ error: "Masuk dulu untuk menambah alat." });
    return;
  }

  const { device, pin, name } = readBody(req);
  const deviceId = normalizeDeviceId(device);
  if (!deviceId) {
    res.status(400).json({ error: "ID perangkat tidak valid." });
    return;
  }
  if (!pin) {
    res.status(400).json({ error: "Masukkan PIN." });
    return;
  }
  const label = typeof name === "string" && name.trim() ? name.trim().slice(0, 40) : null;

  const check = await checkPin(deviceId, pin, "claim");
  if (!check.ok) {
    res.status(check.status).json(check.body);
    return;
  }

  try {
    await db.rest("devices?on_conflict=id", { method: "POST", body: [{ id: deviceId }], prefer: "resolution=ignore-duplicates,return=minimal" });
    await db.upsert("device_owners", [{ device_id: deviceId, user_id: user.id, ...(label ? { name: label } : {}) }], "device_id,user_id");
  } catch (err) {
    console.error("Claim failed:", err);
    res.status(502).json({ error: "Gagal menyimpan ke database." });
    return;
  }

  res.status(200).json({ ok: true, device: deviceId });
};
