// sw.js — кэш оболочки приложения
const CACHE = 'p2p-msg-v1';
const ASSETS = [
  './', './index.html', './css/styles.css',
  './js/app.js', './js/peer-manager.js', './js/crypto.js',
  './js/storage.js', './js/file-transfer.js',
  './js/call-manager.js', './js/ui.js'
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});
self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});