"use strict";

// Konfigurasi Tailwind dan tombol tema yang dipakai bersama index.html dan bill.html.
// Harus dimuat setelah cdn.tailwindcss.com.
tailwind.config = { theme: { extend: {
  colors: {
    surface: "var(--surface)", card: "var(--card)", inset: "var(--inset)", line: "var(--line)", track: "var(--track)",
    ink: "var(--ink)", "ink-2": "var(--ink-2)",
    accent: "var(--accent)", "accent-ink": "var(--accent-ink)", "accent-soft": "var(--accent-soft)",
    warn: "var(--warn)", "warn-ink": "var(--warn-ink)", "warn-soft": "var(--warn-soft)",
    bad: "var(--bad)", "bad-ink": "var(--bad-ink)", "bad-soft": "var(--bad-soft)",
    btn: "var(--btn)", "on-btn": "var(--on-btn)"
  },
  borderRadius: { DEFAULT: "0.375rem", lg: "0.5rem", xl: "0.75rem" },
  fontFamily: {
    sans: ["Space Grotesk", "sans-serif"],
    mono: ["JetBrains Mono", "monospace"]
  },
  fontSize: {
    "display": ["32px", { lineHeight: "40px", letterSpacing: "-0.02em", fontWeight: "700" }],
    "headline": ["26px", { lineHeight: "32px", letterSpacing: "-0.01em", fontWeight: "600" }],
    "title": ["18px", { lineHeight: "24px", fontWeight: "600" }],
    "body": ["14px", { lineHeight: "20px" }],
    "small": ["12px", { lineHeight: "16px" }],
    "label": ["11px", { lineHeight: "14px", letterSpacing: "0.04em", fontWeight: "600" }]
  }
} } };

// Tema disimpan per browser; tanpa localStorage tema kembali ke terang.
function setupTheme() {
  const btn = document.getElementById("btn-theme");
  const icon = document.getElementById("btn-theme-icon");
  if (!btn) return;
  const apply = (theme) => {
    document.documentElement.dataset.theme = theme;
    const dark = theme === "dark";
    btn.setAttribute("aria-pressed", String(dark));
    btn.setAttribute("aria-label", dark ? "Ganti ke tema terang" : "Ganti ke tema gelap");
    if (icon) icon.textContent = dark ? "light_mode" : "dark_mode";
  };
  apply(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  btn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    apply(next);
    try { localStorage.setItem("theme", next); } catch { /* storage diblokir, tema hanya berlaku di sesi ini */ }
  });
}

window.addEventListener("DOMContentLoaded", setupTheme);
