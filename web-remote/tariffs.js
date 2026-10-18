"use strict";

// Golongan tarif listrik rumah tangga PLN, dipakai browser (bill.html) dan server
// (api/monitor.js, api/tariff.js, api/telegram.js). Satu-satunya tempat angka tarif.
// Angka: tarif triwulan III 2026, masih berlaku per Oktober 2026 karena tarif
// triwulan IV belum diumumkan. Perbarui di sini kalau ESDM/PLN menetapkan tarif baru.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Tariffs = api;
})(typeof self !== "undefined" ? self : this, function () {
  const LIST = [
    { code: "R1-450", label: "R-1 450 VA (subsidi)", rate: 415 },
    { code: "R1-900S", label: "R-1 900 VA (subsidi)", rate: 605 },
    { code: "R1-900", label: "R-1 900 VA (RTM)", rate: 1352 },
    { code: "R1-1300", label: "R-1 1.300 VA", rate: 1444.7 },
    { code: "R1-2200", label: "R-1 2.200 VA", rate: 1444.7 },
    { code: "R2", label: "R-2 3.500 - 5.500 VA", rate: 1699.53 },
    { code: "R3", label: "R-3 6.600 VA ke atas", rate: 1699.53 },
  ];
  // Tarif yang dipakai semua alat sebelum fitur ini ada.
  const DEFAULT_CODE = "R1-1300";

  function find(code) {
    const key = String(code || "").trim().toUpperCase();
    return LIST.find((t) => t.code === key) || null;
  }

  // Dari payload retained .../billing/tariff ({"code":...,"rate":...}); kode yang
  // tidak dikenal atau payload kosong jatuh ke default.
  function fromPayload(raw) {
    let code = null;
    try { code = raw ? JSON.parse(raw).code : null; } catch { /* payload rusak */ }
    return find(code) || find(DEFAULT_CODE);
  }

  return { LIST, DEFAULT_CODE, find, fromPayload, DEFAULT: find(DEFAULT_CODE) };
});
