/* CleanCrew — service worker (installable PWA + light offline shell) */
const CACHE = 'cleancrew-shell-v2';
const SHELL = [
  '/',
  '/index.html',
  '/dashboard.html',
  '/login.html',
  '/signup.html',
  '/reset-password.html',
  '/site.webmanifest',
  '/favicon.ico',
  '/favicon-32x32.png',
  '/favicon-16x16.png',
  '/apple-touch-icon.png',
  '/android-chrome-192x192.png',
  '/android-chrome-512x512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(SHELL).catch(function () {});
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE; }).map(function (k) {
          return caches.delete(k);
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (e) { return; }

  if (url.pathname.indexOf('/api/') !== -1) return;
  if (url.hostname.indexOf('onrender.com') !== -1) return;
  if (url.hostname.indexOf('supabase') !== -1) return;
  if (url.hostname.indexOf('paystack') !== -1) return;

  var isHTML =
    req.mode === 'navigate' ||
    (req.headers.get('accept') || '').indexOf('text/html') !== -1 ||
    /\.html?$/.test(url.pathname) ||
    url.pathname === '/';

  if (isHTML) {
    event.respondWith(
      fetch(req)
        .then(function (res) {
          if (res && res.ok && url.origin === self.location.origin) {
            var copy = res.clone();
            caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
          }
          return res;
        })
        .catch(function () {
          return caches.match(req).then(function (cached) {
            return cached || caches.match('/dashboard.html') || caches.match('/index.html');
          });
        })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(function (cached) {
      var network = fetch(req)
        .then(function (res) {
          if (res && res.ok && url.origin === self.location.origin) {
            var copy = res.clone();
            caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
          }
          return res;
        })
        .catch(function () { return cached; });
      return cached || network;
    })
  );
});
