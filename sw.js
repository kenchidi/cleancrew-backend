// CleanCrew SW — network-first for HTML so deploys show up
self.addEventListener('install', function (e) {
  self.skipWaiting();
});
self.addEventListener('activate', function (e) {
  e.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').indexOf('text/html') >= 0) {
    e.respondWith(
      fetch(req).catch(function () {
        return caches.match(req);
      })
    );
    return;
  }
  // default: network
  e.respondWith(fetch(req).catch(function () { return caches.match(req); }));
});
