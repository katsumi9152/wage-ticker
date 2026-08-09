/**
 * sw.js — オフライン対応は撤去した。
 *
 * 以前この Service Worker を登録済みの端末には、これが「最後の1回」として
 * 届く。届いたら自分自身を解除し、貯めていたキャッシュを全部消す(以後は
 * このファイルごと二度と読み込まれない)。開いたままのタブを強制的に
 * 読み込み直すことはしない(設定・日別編集の入力中に消えてしまうため)。
 * 次に手動で開き直したときには、もう Service Worker 自体が無い状態になる。
 */
self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      self.registration.unregister(),
      caches.keys().then(function (names) {
        return Promise.all(names.map(function (n) { return caches.delete(n); }));
      }),
    ])
  );
});
