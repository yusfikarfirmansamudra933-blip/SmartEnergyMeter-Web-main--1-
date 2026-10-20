"use strict";

// Akun pemilik (Supabase Auth), dipakai index.html, bill.html, dan devices.html.
// Kunci di bawah adalah kunci publishable: memang untuk browser. Yang membatasi
// data adalah aturan RLS di database (hanya pemilik alat yang bisa membaca
// riwayatnya), bukan kerahasiaan kunci ini.
const SUPABASE_URL = "https://omrjqsolejpxiduogzfn.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_OX599tu6WNtPPHZrhAkaKQ_JK9SQtkG";

const sb = window.supabase
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: true, detectSessionInUrl: true, flowType: "pkce" } })
  : null;

const Account = {
  available: !!sb,
  ready: false,       // true setelah sesi tersimpan (kalau ada) selesai dibaca
  session: null,
  owned: new Map(),   // deviceId -> nama (atau null)
  listeners: [],

  onChange(fn) { this.listeners.push(fn); if (this.ready) fn(this); },
  get email() { return this.session ? this.session.user.email : null; },
  isOwner(id) { return !!id && this.owned.has(id); },
  authHeader() { return this.session ? { Authorization: `Bearer ${this.session.access_token}` } : {}; },

  // Link masuk lewat email. Kembali ke halaman yang sama setelah link diklik.
  async signInEmail(email) {
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: returnUrl() } });
    if (error) throw error;
  },
  async signInGoogle() {
    const { error } = await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: returnUrl() } });
    if (error) throw error;
  },
  async signOut() { await sb.auth.signOut(); },

  async refreshOwned() {
    this.owned = new Map();
    if (this.session) {
      const { data, error } = await sb.from("device_owners").select("device_id, name, created_at").order("created_at");
      if (!error && data) data.forEach((r) => this.owned.set(r.device_id, r.name));
    }
    this.emit();
  },
  emit() { this.listeners.forEach((fn) => { try { fn(this); } catch (err) { console.error(err); } }); },
};

// Alamat kembali tanpa parameter sisa login sebelumnya (?code=..., #access_token=...).
function returnUrl() {
  const params = new URLSearchParams(location.search);
  ["code", "error", "error_code", "error_description"].forEach((k) => params.delete(k));
  const q = params.toString();
  return `${location.origin}${location.pathname}${q ? `?${q}` : ""}`;
}

if (sb) {
  sb.auth.onAuthStateChange((event, session) => {
    const changedUser = (Account.session && Account.session.user.id) !== (session && session.user.id);
    Account.session = session;
    // Token baru (TOKEN_REFRESHED) tidak mengubah kepemilikan; cukup simpan sesinya.
    if (!Account.ready || changedUser) {
      Account.ready = true;
      Account.refreshOwned();
    }
    // Bersihkan ?code=... dari alamat setelah login lewat link selesai.
    if (event === "SIGNED_IN" && new URLSearchParams(location.search).has("code")) history.replaceState(null, "", returnUrl());
  });
} else {
  Account.ready = true;
}
