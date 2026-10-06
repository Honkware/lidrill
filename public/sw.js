// Offline shell. The shell (page, its hashed JS/CSS, fonts) is
// cached at install so later starts don't wait on the network; pages still
// come from the network first when it answers within two seconds, so a new
// deploy shows up on the next load. The engine, pieces and boards are cached
// on first use. Lichess and Chess.com calls are never cached here.
const CACHE = 'lidrill-v2'
const STATIC = /^\/(assets|engine|pieces|fonts|board)\//

self.addEventListener('install', e =>
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      const res = await fetch('/', { cache: 'no-cache' })
      const html = await res.clone().text()
      await cache.put('/', res)
      const urls = [...new Set(html.match(/\/(assets|fonts)\/[^"']+/g) ?? [])]
      await cache.addAll([...urls, '/manifest.webmanifest', '/favicon.svg'])
      await self.skipWaiting()
    })(),
  ),
)

self.addEventListener('activate', e =>
  e.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key)
      await self.clients.claim()
    })(),
  ),
)

const fromCache = req => caches.match(req).then(hit => hit || Promise.reject(new Error('not cached')))

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin) return
  if (e.request.mode === 'navigate') {
    const network = fetch(e.request).then(res => {
      if (res.ok) {
        const copy = res.clone()
        caches.open(CACHE).then(c => c.put('/', copy))
      }
      return res
    })
    const slow = new Promise(resolve => setTimeout(resolve, 2000)).then(() => fromCache('/'))
    e.respondWith(Promise.any([network, slow]).catch(() => fromCache('/')))
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
