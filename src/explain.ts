import { Chess } from 'chessops/chess'
import { makeFen, parseFen } from 'chessops/fen'
import { parseUci } from 'chessops/util'
import type { CertifiedRun, Engine } from './analysis/engine'
import { db, type Band, type ExplanationRow, type Game, type Puzzle } from './db'
import { CERT, dedupeKey, nullMoveFen, packetHash, PROMPT_VERSION, REPORT_SCHEMA, type EngineReport, type Packet, type PuzzleKind } from './server/packet'
import { gameState } from './server/gamestate'
import { lineEvalCp } from './server/consistency'
import type { Slot } from './server/render'
import { sha256Hex, solve } from './server/sha256'

// Client side of "Why?": Stockfish certifies the facts here, in
// the browser; lidrill's Worker builds the packet from that report, has the
// narrator word it, checks it, and sends back the four slots in ref form
// with the packet that renders them. Stored per (puzzle, first wrong try).

export const EXPLAIN_VERSION = 11

export interface ExplainContext {
  band: Band
  history?: string[] // earlier FENs of the game, for repetition counts
  lineCp?: number // the game's stored eval line at the puzzle position, player's point of view
  weeklyFocusHabit?: string
  opening?: string
  eco?: string
}

export type Progress = (done: number, total: number) => void

const after = (fen: string, ucis: string[]): string => {
  const pos = Chess.fromSetup(parseFen(fen).unwrap()).unwrap()
  for (const u of ucis) pos.play(parseUci(u)!)
  return makeFen(pos.toSetup())
}

export const kindOf = (p: Puzzle): PuzzleKind =>
  p.source === 'lichess' || p.type === 'external' ? 'lichess' : p.alternatives ? 'hold' : p.tag === 'defensive' ? 'defensive' : p.type === 'conversion' ? 'conversion' : p.type === 'hang' ? 'hang' : 'missed-win'

// Bumped when the search settings change: older cached runs are redone
export const CERT_RUN_VERSION = 'certrun/2'

type Job = [name: string, fen: string, multipv: number, budget: number]

// The searches a puzzle needs: the answer at MultiPV 2, the
// null-move threat at MultiPV 3, the game move at MultiPV 1. One run each:
// the stability check is the same search two iterations earlier.
function jobsFor(p: Puzzle): Job[] {
  const jobs: Job[] = [['best', p.fen, Math.max(CERT.multipv, Math.min(CERT.kMax, (p.alternatives?.length ?? 0) + 1)), CERT.budgetMs.best]]
  const nullFen = nullMoveFen(p.fen)
  if (nullFen) jobs.push(['threat', nullFen, CERT.threatMultipv, CERT.budgetMs.threat])
  if (p.played) jobs.push(['played', after(p.fen, [p.played]), 1, CERT.budgetMs.line])
  return jobs
}

// Side by side when there are several engines (each takes the next search)
async function runJobs(jobs: Job[], engines: Engine[], progress: Progress, stopped: () => boolean = () => false): Promise<Record<string, CertifiedRun[]>> {
  const out: Record<string, CertifiedRun[]> = {}
  let next = 0
  let done = 0
  progress(0, jobs.length)
  await Promise.all(
    engines.map(async engine => {
      while (next < jobs.length && !stopped()) {
        const [name, fen, multipv, budget] = jobs[next++]
        out[name] = [await engine.certify(fen, { depth: CERT.depth, nodes: CERT.nodesCap, movetime: budget, multipv, clearHash: true })]
        progress(++done, jobs.length)
      }
    }),
  )
  return out
}

// Certify ahead, in idle time: "Why?" then only has to check the wrong try
export async function precertify(p: Puzzle, engines: Engine[], interrupted: () => boolean = () => false): Promise<void> {
  const saved = await db.certs.get(p.id)
  if (saved?.version === CERT_RUN_VERSION) return
  const runs = await runJobs(jobsFor(p), engines, () => {}, interrupted)
  // A search cut short for "Why?" isn't a certification
  if (interrupted()) return
  await db.certs.put({ puzzleId: p.id, version: CERT_RUN_VERSION, runs, createdAt: Date.now() })
}

export async function certifyReport(p: Puzzle, engines: Engine[], ctx: ExplainContext, tried: string | undefined, recent: string[], progress: Progress = () => {}): Promise<EngineReport> {
  const saved = await db.certs.get(p.id)
  const cached = saved?.version === CERT_RUN_VERSION ? saved.runs : {}
  const tryIt = tried && tried !== p.played && !(p.alternatives ?? [p.solution[0]]).includes(tried)
  const jobs = [...jobsFor(p).filter(([name]) => !cached[name]), ...(tryIt ? [['tried', after(p.fen, [tried]), 1, CERT.budgetMs.line] as Job] : [])]
  const fresh = jobs.length ? await runJobs(jobs, engines, progress) : {}
  // Engine lines can run past what the Worker accepts; the packet uses at most 8 plies
  const trim = (runs: CertifiedRun[]) => runs.map(r => ({ ...r, lines: r.lines.map(l => ({ ...l, pv: l.pv.slice(0, 16) })), check: r.check && { ...r.check, pv: r.check.pv.slice(0, 16) } }))
  const out = Object.fromEntries(Object.entries({ ...cached, ...fresh }).map(([k, v]) => [k, trim(v)]))
  if (jobs.some(([name]) => name !== 'tried')) await db.certs.put({ puzzleId: p.id, version: CERT_RUN_VERSION, runs: Object.fromEntries(Object.entries(out).filter(([k]) => k !== 'tried')), createdAt: Date.now() })
  return {
    schema: REPORT_SCHEMA,
    fen: p.fen,
    history: ctx.history?.slice(-600),
    lineCp: ctx.lineCp,
    solution: p.solution,
    holding: p.alternatives,
    kind: kindOf(p),
    band: ctx.band,
    themes: p.themes,
    opening: ctx.opening,
    eco: ctx.eco,
    best: out.best,
    threat: out.threat,
    played: p.played && out.played ? { uci: p.played, runs: out.played } : undefined,
    tried: tryIt ? { uci: tried!, runs: out.tried } : undefined,
    habit: { weeklyFocus: ctx.weeklyFocusHabit, recent },
  }
}

// The proof of work for the request, in slices so the page stays responsive
async function proof(body: string): Promise<string> {
  const res = await fetch('/api/challenge')
  if (!res.ok) throw new Error('No explanation right now. Try again later.')
  const c = (await res.json()) as { nonce: string; exp: number; bits: number; sig: string }
  const hash = sha256Hex(body)
  for (let start = 0; start < 1 << 24; start += 4096) {
    const found = solve(c.nonce, hash, c.bits, 4096, start)
    if (found !== undefined) return `${c.nonce}.${c.exp}.${c.bits}.${c.sig}.${found}`
    await new Promise(r => setTimeout(r, 0))
  }
  throw new Error('No explanation right now. Try again later.')
}

// Fire-and-forget packet upload: after a certification the
// report goes to the packet store so the slim /api/explain can serve the
// position without the engine chain. Failures change nothing - the next
// build retries, and KV dedupe makes repeats harmless. Resolves to whether
// the packet is stored (true includes the already-stored dedupe hit).
export function uploadPacket(report: EngineReport): Promise<boolean> {
  const body = JSON.stringify({ ...report, tier: 'client-lite' })
  return (async () => {
    try {
      const res = await fetch('/api/packet', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-lidrill-proof': await proof(body) }, body })
      return res.ok
    } catch {
      return false
    }
  })()
}

// Which habits the packet build should avoid repeating: the three newest
// explanations' habit ids, oldest first (rows without a habit carry null)
export const recentHabits = async (): Promise<string[]> =>
  (await db.explanations.orderBy('createdAt').reverse().limit(3).toArray()).map(e => e.habitId).filter((h): h is string => !!h).reverse()

// The sync-time build: from the cached certification runs
// (no new engine work when precertify already covered the puzzle) build the
// report and upload it. Returns whether the packet is stored.
export async function uploadPacketFor(p: Puzzle, engines: Engine[]): Promise<boolean> {
  const saved = await db.certs.get(p.id)
  if (saved?.version !== CERT_RUN_VERSION) return false
  const game = p.gameId ? await db.games.get(p.gameId) : undefined
  const ctx = await contextFor(p, game)
  const report = await certifyReport(p, engines, ctx, undefined, await recentHabits())
  return uploadPacket(report)
}

const WEEK = 7 * 24 * 3600 * 1000

// What the packet needs from the rest of the app: the band, the game's
// earlier positions (repetitions), its opening, and the weekly focus as a
// habit when the week's journal says hanging pieces are the leak
export async function contextFor(p: Puzzle, game?: Game): Promise<ExplainContext> {
  const profile = await db.profile.get('me')
  const history: string[] = []
  if (game && p.ply > 1) {
    const pos = Chess.default()
    history.push(makeFen(pos.toSetup()))
    for (const m of game.moves.slice(0, p.ply - 2)) {
      pos.play(parseUci(m.uci)!)
      history.push(makeFen(pos.toSetup()))
    }
  }
  const week = await db.journal.where('at').above(Date.now() - WEEK).toArray()
  const hangs = week.filter(j => j.hung).length
  const weeklyFocusHabit = week.length >= 3 && hangs / week.length >= 0.3 ? 'habit:blunder-check' : undefined
  // The game's own stored eval line at the puzzle position, so the
  // packet can be reconciled against what the review screen already shows
  const lineCp = game ? lineEvalCp(game, p.ply) : undefined
  return { band: profile?.band ?? 'beginner', history, lineCp, weeklyFocusHabit, opening: game?.opening, eco: game?.eco }
}

export const rowId = (puzzleId: string, tried?: string) => `${puzzleId}|${tried ?? ''}`

export const isCurrent = (e: ExplanationRow | undefined, band: Band): e is ExplanationRow => !!e && e.version === EXPLAIN_VERSION && e.band === band && e.promptVersion === PROMPT_VERSION

export interface ExplainResult {
  slots: Slot[]
  packet: Packet
  floor: boolean
}

interface ExplainResponse {
  slots?: Slot[]
  packet?: Packet
  source?: string
  version?: number
  models?: string[]
  error?: string
}

// The slim shape: one cheap request carrying only the
// packet reference. A miss, a band/tried mismatch, or any failure resolves
// undefined and the caller falls back to the certify-and-POST path - the
// legacy path is the safety net, not a parallel code path.
async function explainSlim(p: Puzzle, band: Band, tried?: string): Promise<ExplainResponse | undefined> {
  try {
    const hash = await packetHash({ fen: p.fen, solution: p.solution, band })
    const body = JSON.stringify({ v: 2, packetHash: hash, band, ...(tried ? { tried } : {}) })
    const res = await fetch('/api/explain', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-lidrill-proof': await proof(body) }, body })
    if (!res.ok) return undefined
    const data = (await res.json()) as ExplainResponse
    return data.slots && data.packet ? data : undefined
  } catch {
    return undefined
  }
}

export async function explain(p: Puzzle, engines: Engine[], ctx: ExplainContext, tried?: string, progress?: Progress): Promise<ExplainResult> {
  const id = rowId(p.id, tried)
  const saved = await db.explanations.get(id)
  if (isCurrent(saved, ctx.band)) return { slots: saved.slots, packet: saved.packet, floor: saved.floor }
  const recent = await recentHabits()

  // Slim first: no engine work when the packet is already stored
  const slim = await explainSlim(p, ctx.band, tried)
  if (slim) return storeRow(id, p, ctx, tried, slim)

  // Fail closed to the certify-and-POST path on a packet-miss or any failure
  if (!engines.length) throw new Error('Stockfish isn’t ready yet.')
  const report = await certifyReport(p, engines, ctx, tried, recent, progress)
  void uploadPacket(report)
  const body = JSON.stringify(report)
  const res = await fetch('/api/explain', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-lidrill-proof': await proof(body) }, body })
  const data = (await res.json().catch(() => ({}))) as ExplainResponse
  if (!res.ok || !data.slots || !data.packet) throw new Error(data.error ?? 'No explanation right now. Try again later.')
  return storeRow(id, p, ctx, tried, data)
}

async function storeRow(id: string, p: Puzzle, ctx: ExplainContext, tried: string | undefined, data: ExplainResponse): Promise<ExplainResult> {
  const row: ExplanationRow = {
    id,
    puzzleId: p.id,
    tried,
    dedupeKey: dedupeKey({ fen: p.fen, occurrenceCount: gameState(Chess.fromSetup(parseFen(p.fen).unwrap()).unwrap(), ctx.history).occurrenceCount, band: ctx.band, kind: kindOf(p) }),
    packetHash: data.packet!.meta.packetHash,
    band: ctx.band,
    slots: data.slots!,
    floor: data.source !== 'model',
    models: Array.isArray(data.models) ? data.models.slice(0, 5).map(String) : undefined,
    certTier: data.packet!.meta.certification.tier ?? 'client-lite',
    promptVersion: data.packet!.meta.promptVersion,
    version: data.version ?? EXPLAIN_VERSION,
    habitId: data.packet!.didactic.habitSlotId,
    createdAt: Date.now(),
    packet: data.packet!,
  }
  await db.explanations.put(row)
  return { slots: row.slots, packet: row.packet, floor: row.floor }
}
