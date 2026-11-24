// Tells the server this page is open, so visits can be counted, and whether
// its visitor has touched a board, which separates people from crawlers
// that load a page and leave. Nothing identifying is sent: the Worker makes
// its own daily hash of the address (worker/index.ts).

const EVERY_MS = 5 * 60 * 1000

export function startPings(fetchFn: typeof fetch = fetch) {
  // A browser driven by a script says so
  if (navigator.webdriver) return
  let active = false
  const send = () => void fetchFn('/api/ping', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ active }), keepalive: true }).catch(() => {})
  send()
  document.addEventListener(
    'pointerdown',
    e => {
      if (active || !(e.target as Element | null)?.closest?.('cg-board')) return
      active = true
      send()
    },
    true,
  )
  // Keeps "on the site now" current while the tab is in front
  setInterval(() => document.visibilityState === 'visible' && send(), EVERY_MS)
}
