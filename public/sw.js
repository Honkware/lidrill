// Offline shell: pages come from the network when there is one and
// from the cache when there isn't; hashed assets, the engine, pieces and
// fonts are cached on first use. API calls to Lichess and Chess.com are
// never cached here.
const CACHE = 'lidrill-v1'
const STATIC = /^\/(assets|engine|pieces|fonts|board)\//

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin) return
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const copy = res.clone()
          caches.open(CACHE).then(c => c.put('/', copy))
          return res
        })
        .catch(() => caches.match('/')),
    )
    return
  }
  if (STATIC.test(url.pathname) || url.pathname === '/manifest.webmanifest')
    e.respondWith(
      caches.match(e.request).then(
        hit =>
          hit ||
          fetch(e.request).then(res => {
            if (res.ok) {
              const copy = res.clone()
              caches.open(CACHE).then(c => c.put(e.request, copy))
            }
            return res
          }),
      ),
    )
})
