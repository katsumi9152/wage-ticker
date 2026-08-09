/**
 * sw.js — オフラインでも開けるようにするための、ごく単純なキャッシュ。
 *
 * 方針: 通信があるときは常に最新を取りに行き、失敗したとき(電波が無い等)だけ
 * 直近に成功したぶんを出す(ネットワーク優先・オフライン時だけキャッシュ)。
 * これにより、通常時は index.html?v=... のようなキャッシュ更新の仕組みと
 * 衝突せず、圏外でも「最後に開けたときの状態」で開けるようになる。
 *
 * 事前に決め打ちのファイル一覧をキャッシュするのではなく、実際に読み込まれた
 * ものをそのつどキャッシュに積む(あとからファイルが増減しても書き換え不要)。
 */
var CACHE_NAME = 'wageticker-v1';

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (n) { return n !== CACHE_NAME; }).map(function (n) { return caches.delete(n); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  var url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // 他サイトへのリクエストには関与しない

  event.respondWith(
    fetch(event.request)
      .then(function (response) {
        var copy = response.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
        return response;
      })
      .catch(function () {
        return caches.match(event.request).then(function (cached) {
          return cached || (event.request.mode === 'navigate' ? caches.match('./index.html') : undefined);
        });
      })
  );
});
