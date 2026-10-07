import { db, SYNC_AUTO_ID, SYNC_ID, SYNC_TABLES, withoutSyncQueue, type Puzzle, type SyncTable } from '../db'
import { SignInExpired } from './lichess'

// Server tier: this browser is one device, the
// FastAPI service behind the lidrill Worker is the shared store keyed by the
// Lichess account. The client stays the FSRS scheduler and keeps working
// fully offline; this pass is fire-and-forget whenever a sync is triggered.
//
// Protocol: push the dirty-row queue (newer updatedAt wins per row on the
// server), then pull rows changed since the last watermark and apply the
// same rule locally. No tombstones in v1: rows are only added or updated.
// The Lichess token never travels to the backend - the Worker validates it
// with Lichess and adds the account key.

export interface SyncWireRow {
  table: string
  id: string
  updatedAt: number
  data: unknown
}

export interface SyncResult {
  pushed: number
  pulled: number
}

const PAGE = 500

async function api(token: string, path: string, init: RequestInit = {}, fetchFn: typeof fetch = fetch): Promise<Response> {
  const res = await fetchFn(`/api/sync${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  })
  if (res.status === 401) throw new SignInExpired()
  if (!res.ok) throw new Error(`sync failed (${res.status})`)
  return res
}

// Drain the dirty queue: read each row's current state (it may have changed
// since queuing - or been deleted, which v1 doesn't sync, so it's skipped)
// and upsert on the server. Entries are removed only after the push lands;
// a failure keeps everything for the next pass.
async function push(token: string, fetchFn: typeof fetch): Promise<number> {
  const entries = await db.syncQueue.toArray()
  if (!entries.length) return 0
  const byTable = new Map<SyncTable, string[]>()
  for (const e of entries) {
    if (!byTable.has(e.table)) byTable.set(e.table, [])
    byTable.get(e.table)!.push(e.key)
  }
  const rows: SyncWireRow[] = []
  const sent = new Set<string>()
  for (const [table, keys] of byTable) {
    const found = await db.table(table).where(SYNC_ID[table]).anyOf(keys.map(k => (SYNC_AUTO_ID.includes(table) ? Number(k) : k))).toArray()
    const byKey = new Map(found.map(r => [String((r as Record<string, unknown>)[SYNC_ID[table]]), r]))
    for (const key of keys) {
      const row = byKey.get(key)
      const entry = entries.find(e => e.table === table && e.key === key)!
      if (row) rows.push({ table, id: key, updatedAt: entry.at, data: row })
      sent.add(`${table}|${key}`)
    }
  }
  if (rows.length) {
    await api(token, '/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rows }) }, fetchFn)
  }
  await db.syncQueue.bulkDelete([...sent].map(k => {
    const i = k.indexOf('|')
    return [k.slice(0, i), k.slice(i + 1)] as [string, string]
  }))
  return rows.length
}

// JSON turns the FSRS card dates into strings; revive them like an import does
function revive(table: SyncTable, data: unknown): unknown {
  if (table !== 'puzzles') return data
  const p = data as Puzzle
  const card = { ...p.card, due: new Date(p.card.due) }
  if (card.last_review) card.last_review = new Date(card.last_review)
  return { ...p, card }
}

// Pull every row newer than the watermark and apply newer-wins per row. A
// locally dirty row with a newer write time keeps its version and stays
// queued; otherwise the server's row replaces the local one (and its pending
// queue entry is dropped, so the stale version isn't pushed back).
async function pull(token: string, fetchFn: typeof fetch): Promise<number> {
  const since = (await db.serverMeta.get('pullSince'))?.value ?? 0
  const rows: SyncWireRow[] = []
  let cursor: string | undefined
  for (;;) {
    const qs = new URLSearchParams({ since: String(since), limit: String(PAGE) })
    if (cursor) qs.set('cursor', cursor)
    const page = (await (await api(token, `/pull?${qs}`, {}, fetchFn)).json()) as { rows: SyncWireRow[]; nextCursor?: string }
    rows.push(...page.rows)
    if (!page.nextCursor) break
    cursor = page.nextCursor
  }

  await withoutSyncQueue(async () => {
    for (const row of rows) {
      const table = row.table as SyncTable
      if (!SYNC_TABLES.includes(table)) continue
      const field = SYNC_ID[table]
      const key: string | number = SYNC_AUTO_ID.includes(table) ? Number(row.id) : row.id
      const local = await db.table(table).get(key)
      const localDirty = await db.syncQueue.get([table, row.id])
      if (local && localDirty && localDirty.at > row.updatedAt) continue // local wins, stays queued
      await db.table(table).put({ ...(revive(table, row.data) as Record<string, unknown>), [field]: key })
      if (localDirty) await db.syncQueue.delete([table, row.id])
    }
  })
  await db.serverMeta.put({ key: 'pullSince', value: Date.now() })
  return rows.length
}

// The user deleted everything: the server copy goes too, so a later pull
// doesn't resurrect it on this or another device.
async function wipe(token: string, fetchFn: typeof fetch): Promise<void> {
  if (!(await db.serverMeta.get('wipe'))?.value) return
  await api(token, '/rows', { method: 'DELETE' }, fetchFn)
  await db.serverMeta.delete('wipe')
  await db.syncQueue.clear()
}

// One push/pull cycle. Never throws for ordinary failures (offline, server
// down): the caller logs and the next pass retries. Only an expired sign-in
// (401) propagates, so the app can sign out.
export async function serverSync(token: string, fetchFn: typeof fetch = fetch): Promise<SyncResult> {
  await wipe(token, fetchFn)
  const pushed = await push(token, fetchFn)
  const pulled = await pull(token, fetchFn)
  return { pushed, pulled }
}
