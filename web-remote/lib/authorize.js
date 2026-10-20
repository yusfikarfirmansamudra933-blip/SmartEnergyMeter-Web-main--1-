const { checkPin } = require("./devices");
const db = require("./supabase");

// Who may send a command to a meter: a signed-in owner of it (no PIN needed),
// or anyone holding the unit's PIN. Returns { ok: true } or the error to send.
async function authorizeControl(req, deviceId, pin, prefix) {
  try {
    const user = await db.userFromRequest(req);
    if (user && await db.isOwner(user.id, deviceId)) return { ok: true, by: "owner" };
  } catch (err) {
    // Database trouble falls back to the PIN instead of locking owners out.
    console.error("Owner check failed:", err);
  }

  if (!process.env.CONTROL_SECRET) {
    return { ok: false, status: 503, body: { error: "Kontrol belum diaktifkan. Tambahkan CONTROL_SECRET di pengaturan Vercel." } };
  }
  if (!pin) return { ok: false, status: 400, body: { error: "Masukkan PIN." } };
  const check = await checkPin(deviceId, pin, prefix);
  return check.ok ? { ok: true, by: "pin" } : check;
}

module.exports = { authorizeControl };
