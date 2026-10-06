import { db } from './db'
import { precertify, uploadPacketFor } from './explain'
import { getCertEngines, isExplaining } from './pipeline'

// One-time migration (docs/21k-design.md (b)), run in idle slices at app
// open. Two jobs:
//  1. stamp client-lite certs on explanation rows made before the tier existed
//  2. upload a packet for every puzzle that doesn't have one yet - the
//     existing precertify runs, an engine-only top-up for what they miss,
//     then the report upload
// Resumable (the marker persists across app opens) and idempotent (KV dedupe
// makes a repeated upload a read hit, and the marker skips finished puzzles).
// Uploads are throttled to a few per minute: KV writes are the day's scarce
// resource, and a big library must never spike them.

const MARKER_KEY = 'lidrill.packetBackfill'

interface Marker {
  uploaded: string[] // puzzle ids whose packet reached the store
}

const readMarker = (): Marker => {
  try {
    const m = JSON.parse(localStorage.getItem(MARKER_KEY) ?? '{}') as Marker
    return { uploaded: Array.isArray(m.uploaded) ? m.uploaded : [] }
  } catch {
    return { uploaded: [] }
  }
}

export async function backfillPackets(onStatus: (s: string) => void, signal: AbortSignal, delayMs = 20_000): Promise<void> {
  const unstamped = (await db.explanations.toArray()).filter(r => !r.certTier)
  if (unstamped.length) await db.explanations.bulkPut(unstamped.map(r => ({ ...r, certTier: 'client-lite' as const })))

  const marker = readMarker()
  const done = new Set(marker.uploaded)
  const todo = (await db.puzzles.toArray()).filter(p => !done.has(p.id))
  if (!todo.length) return
  const engines = getCertEngines()
  for (let i = 0; i < todo.length; i++) {
    while (isExplaining() && !signal.aborted) await new Promise(r => setTimeout(r, 1000))
    if (signal.aborted) return
    try {
      await precertify(todo[i], engines, () => signal.aborted)
      if (signal.aborted) return
      if (await uploadPacketFor(todo[i], engines)) {
        marker.uploaded.push(todo[i].id)
        localStorage.setItem(MARKER_KEY, JSON.stringify(marker))
      }
    } catch (e) {
      console.warn(e)
      return // try again next app open
    }
    onStatus(`Sharing explanations with the server (${i + 1}/${todo.length})…`)
    if (i + 1 < todo.length) await new Promise(r => setTimeout(r, delayMs))
  }
  onStatus('')
}
