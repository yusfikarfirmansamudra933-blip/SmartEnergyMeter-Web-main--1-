// Hanya file dari domain ini yang di-precache. Skrip dari CDN (Tailwind,
// MQTT, xlsx, jsPDF) sengaja tidak dimasukkan: kalau salah satu gagal
// diambil saat install, seluruh cache.addAll() ikut gagal dan halaman jadi
// tidak bisa dipasang sama sekali. Skrip CDN tetap lewat jaringan seperti
// biasa lewat fetch handler di bawah.
// Naikkan angka versi ini setiap kali isi urls di bawah berubah (termasuk isi
// index.html/bill.html sendiri) — activate() di bawah menghapus cache versi
// lama begitu ada versi baru, ini satu-satunya cara device yang sudah
// menginstal PWA menerima pembaruan. Nama yang sama = cache lama dipakai
// selamanya walau file di server sudah diganti.
const CACHE_NAME = "SmartEnergyMeterCloud-v4";

const urls = [
    "./",
    "./index.html",
    "./bill.html",
    "./script.js",
    "./bill.js",
    "./theme.css",
    "./theme.js",
    "./manifest.json",
    "./icon-192.png",
    "./icon-512.png"
];

self.addEventListener("install", event => {

    event.waitUntil(

        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(urls))

    );

    self.skipWaiting();

});

self.addEventListener("activate", event => {

    event.waitUntil(

        caches.keys()
            .then(keys => Promise.all(

                keys
                    .filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))

            ))

    );

    self.clients.claim();

});

// Data (MQTT/API) tidak pernah lewat sini — cuma halaman dan skrip statis.
// Cache-first untuk yang sudah dipunya, network untuk sisanya (termasuk
// semua aset CDN, yang tidak masuk daftar precache).
self.addEventListener("fetch", event => {

    if (event.request.method !== "GET") return;

    event.respondWith(

        caches.match(event.request)
            .then(response => response || fetch(event.request))

    );

});
