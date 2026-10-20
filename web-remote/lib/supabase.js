// Server-side access to Supabase over plain HTTP (PostgREST + Auth), so the
// functions need no extra dependency. Uses the secret key, which bypasses RLS:
// never import this from browser code.
const SUPABASE_URL = "https://omrjqsolejpxiduogzfn.supabase.co";
const SECRET = () => process.env.SUPABASE_SECRET_KEY;

function enabled() {
  return !!SECRET();
}

function headers(extra = {}) {
  return { apikey: SECRET(), Authorization: `Bearer ${SECRET()}`, "Content-Type": "application/json", ...extra };
}

async function rest(path, { method = "GET", body, prefer } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: headers(prefer ? { Prefer: prefer } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase ${method} ${path.split("?")[0]}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

// Insert-or-update on the table's primary key; rows already there are replaced.
function upsert(table, rows, onConflict) {
  if (!rows.length) return Promise.resolve(null);
  return rest(`${table}?on_conflict=${onConflict}`, { method: "POST", body: rows, prefer: "resolution=merge-duplicates,return=minimal" });
}

// The signed-in user behind a browser's access token, or null. Auth checks the
// token's signature and expiry, so a forged or stale token is rejected here.
async function userFromRequest(req) {
  const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
  const token = auth && auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token || !enabled()) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SECRET(), Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const user = await res.json().catch(() => null);
  return user && user.id ? user : null;
}

async function isOwner(userId, deviceId) {
  const rows = await rest(`device_owners?select=device_id&device_id=eq.${encodeURIComponent(deviceId)}&user_id=eq.${encodeURIComponent(userId)}`);
  return Array.isArray(rows) && rows.length > 0;
}

module.exports = { SUPABASE_URL, enabled, rest, upsert, userFromRequest, isOwner };
