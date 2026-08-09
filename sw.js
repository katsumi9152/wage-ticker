/**
 * sw.js — オフライン対応は撤去した。
 *
 * 以前この Service Worker を登録済みの端末には、これが「最後の1回」として
 * 届く。届いたら自分自身を解除し、貯めていたキャッシュを全部消してから
 * 開いているタブを読み込み直す(以後はこのファイルごと二度と読み込まれない)。
 */
self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    Promise.all([
      self.registration.unregister(),
      caches.keys().then(function (names) {
        return Promise.all(names.map(function (n) { return caches.delete(n); }));
      }),
    ]).then(function () {
      return self.clients.matchAll({ type: 'window' });
    }).then(function (clients) {
      clients.forEach(function (client) { client.navigate(client.url); });
    })
  );
});
