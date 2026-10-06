import { Chess } from 'chessops/chess'
import { makeFen } from 'chessops/fen'
import { makeSan } from 'chessops/san'
import type { Color, Role } from 'chessops/types'
import { makeSquare, parseSquare, parseUci } from 'chessops/util'
import type { Band } from '../db'
import { amount } from './amount'
import { featureBlock, FEATURES_VERSION, type FeatureBlock, type FeatureDelta } from './features'
import { canonicalFen, drawRule, gameState, validPosition, type DrawRule, type GameState } from './gamestate'
import { family, HABIT_LIB_VERSION, selectHabit } from './habits'
import { MOTIF_LIB_VERSION, motifEntry, type MotifKey } from './motifLib'
import { motifs, type Motif, type MotifName } from './motifs'
import { fromFen, replay, type LineReplay, type PlayedMove } from './facts'
import { READABILITY_VERSION } from './readability'

// The facts packet. The browser runs Stockfish and sends
// its raw search output (an EngineReport); this file turns that into the
// packet deterministically, on the server, so every fact the narrator may
// mention is computed here and nowhere else. Engine numbers are the
// browser's word (only its own player is fooled if they're forged); every
// move is replayed and every pattern is detected again here.

export type PuzzleKind = 'missed-win' | 'hang' | 'conversion' | 'hold' | 'defensive' | 'lichess'
export const KINDS: PuzzleKind[] = ['missed-win', 'hang', 'conversion', 'hold', 'defensive', 'lichess']
export const BANDS: Band[] = ['beginner', 'club', 'advanced']

export const PACKET_SCHEMA = 'lidrill-packet/2.1'
export const REPORT_SCHEMA = 'lidrill-report/1'
export const BUILDER_VERSION = 'builder/1.0'
export const DETECTOR_VERSION = 'det/1.0'
export const THREAT_DEF = 'nullmove/1.0'
export const ENGINE = { name: 'stockfish', version: '19-wasm-lite', id: 'sf19-wasm-lite' } as const

// Certification policy v1.0
export const CERT = {
  version: 'cert/1.0',
  depth: 24, // D_cert
  refuseDepth: 22,
  instabCp: 50, // τ_instab: run-to-run range above this is unstable
  nullCp: 50, // τ_null: "no threat" only below the eval noise floor, every band
  kMax: 8,
  // measured 2M nodes reaching depth 21 (median) on one thread, so 68%
  // of hard positions were refused; depth 22 took 3.7M nodes (median) and
  // 9.4M (p90). So a time budget per search with a hard node stop: the
  // searches run side by side, mostly ahead of time in idle moments.
  nodesCap: 12_000_000,
  budgetMs: { best: 15000, threat: 15000, line: 8000 },
  multipv: 2,
  threatMultipv: 3,
  margin: { beginner: 150, club: 100, advanced: 80 } as Record<Band, number>,
  threat: { beginner: 300, club: 150, advanced: 100 } as Record<Band, number>, // τ_threat
} as const

// --- the browser's report ---------------------------------------------------

export interface RawEval {
  type: 'cp' | 'mate'
  value: number // the searched position's side to move, as UCI reports it
}

export interface EngineLine {
  pv: string[] // UCI
  eval: RawEval
}

export interface EngineRun {
  lines: EngineLine[] // MultiPV order, best first
  depth: number // depth reached
  nodes: number
  capped: boolean // stopped by the budget before the target depth
  check?: { depth: number; pv: string[]; eval: RawEval } // the best line two iterations earlier
}

export interface EngineReport {
  schema: typeof REPORT_SCHEMA
  fen: string // the puzzle position, player to move
  history?: string[] // earlier positions of the game, for repetition counts
  solution: string[] // UCI, the stored answer
  holding?: string[] // UCI, every move that holds (hold puzzles)
  kind: PuzzleKind
  band: Band
  themes?: string[]
  opening?: string
  eco?: string
  best: EngineRun[] // two runs at `fen`, hash cleared in between
  threat?: EngineRun[] // two runs at the null-move position
  played?: { uci: string; runs: EngineRun[] } // runs after the game move
  tried?: { uci: string; runs: EngineRun[] } // runs after the player's first wrong try
  habit: { weeklyFocus?: string; recent: string[] }
}

// --- the packet ---------------------------------------------------------------

export type Side = 'w' | 'b'
export interface TypedEval {
  type: 'cp' | 'mate'
  value: number // the player's point of view
  range?: [number, number]
  stable: boolean
  reachedDepth?: number
}

export interface PvMove {
  id: string
  san: string
  uci: string
  side: Side
  givesCheck: boolean
  isCapture: boolean
  captured?: Role
  mate: boolean
  from: string
  to: string
  fenBefore: string
  fenAfter: string
}

export interface MoveFact extends PvMove {
  label?: 'inaccuracy' | 'mistake' | 'blunder' | 'good'
  swing?: TypedEval
  reply: PvMove[] // the engine's best line after it
}

export interface Certificate {
  id: string
  type: 'forced' | 'tactical' | 'mate' | 'featureDelta' | 'noThreat' | 'drawRule' | 'stopsThreat'
  subject?: string
  side: Side
  targetSide?: Side
  motif?: MotifName
  payload: Record<string, unknown>
  text: string // the certified fact in words, rendered verbatim
}

export type ThreatStatus = 'certified' | 'certifiedNull' | 'uncertified'
export type Verdict = 'winning' | 'better' | 'slightly better' | 'equal' | 'slightly worse' | 'worse' | 'lost' | 'dead-draw' | 'draw (automatic)'
export type SlotName = 'whatHappened' | 'why' | 'pattern' | 'nextTime'

export interface Packet {
  schema: typeof PACKET_SCHEMA
  meta: {
    packetHash: string
    promptVersion: string
    engine: typeof ENGINE & { certDepth: number; multipv: number; nodesCap: number }
    certification: { status: 'certified' | 'partial' | 'refused'; policyVersion: string; refusals: string[]; evalStable: boolean }
    readabilityVersion: string
    versions: Record<string, string>
  }
  position: {
    fenBefore: string
    fenAfter: string // after the game move if there is one, else after the answer
    sideToMove: Color
    playerColor: Color
    moveNumber: number
    phase: 'opening' | 'middlegame' | 'endgame'
    check: { before: boolean; after: boolean; kingSquare: string | null }
    gameState: GameState
    drawRule?: Exclude<DrawRule, undefined>
  }
  played?: MoveFact
  tried?: MoveFact
  eval: { source: 'stockfish'; before: TypedEval; afterPlayed?: TypedEval; verdict: { before: Verdict; afterPlayed?: Verdict; forColor: Color } }
  best: {
    id: 'best'
    san: string
    uci: string
    side: Side
    unique: boolean
    uniquenessGapCp: number | null
    certifiedAtDepth: number | null
    reachedDepth: number
    mateIn: number | null
    materialAfterPv: number
    pv: PvMove[]
    pvComplete: boolean
    pvTerminal: 'mate' | 'advantage-stable' | 'truncated'
  }
  holding: { id: string; san: string; uci: string }[]
  alternatives: { id: string; san: string; side: Side; eval: TypedEval; gapCp: number; verdict: 'worse' | 'close' }[]
  threatStatus: ThreatStatus
  threat?: {
    id: 'threat'
    san: string
    side: Side
    targetSide: Side
    viaNullMove: true
    threatDef: typeof THREAT_DEF
    line: PvMove[] // ids t0, t1, …
    consequence: { type: 'mate' | 'winsMaterial' | 'other'; swingCp: number; mateIn?: number; material?: number }
    certifiedAtDepth: number
    complete: boolean
  }
  features?: FeatureBlock
  certificates: Certificate[]
  concepts: { tag: MotifName; cert: string }[]
  material: { before: number; after: number; delta: number }
  claimAnchors: string[]
  didactic: {
    puzzleType: PuzzleKind
    family: string
    motif: MotifKey
    motifCert: string | null
    requiredRefs: Record<SlotName, string[]> // "a|b" = at least one of them
    habitSlotId: string
    glossId: string
    mechanismMin: number
  }
  context: { opening?: string; eco?: string; band: Band }
}

// --- helpers ------------------------------------------------------------------

const VALUE: Record<Role, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 }
const sideOf = (c: Color): Side => (c === 'white' ? 'w' : 'b')
const other = (c: Color): Color => (c === 'white' ? 'black' : 'white')

// Centipawns for comparisons; a mate outranks any cp and nearer is bigger
export function cpOf(e: { type: 'cp' | 'mate'; value: number }): number {
  if (e.type === 'cp') return Math.max(-10000, Math.min(10000, e.value))
  return e.value > 0 ? 10000 - e.value * 10 : -10000 - e.value * 10
}

// The searched position's side to move → the player's point of view
const pov = (e: RawEval, flip: boolean): { type: 'cp' | 'mate'; value: number } => ({ type: e.type, value: flip ? -e.value : e.value })

function materialOf(pos: Chess, color: Color): number {
  let d = 0
  for (const [, p] of pos.board) d += (p.color === color ? 1 : -1) * VALUE[p.role]
  return d
}

export function verdictOf(e: { type: 'cp' | 'mate'; value: number }): Verdict {
  const cp = cpOf(e)
  const a = Math.abs(cp)
  if (a < 50) return 'equal'
  if (cp > 0) return a >= 500 ? 'winning' : a >= 200 ? 'better' : 'slightly better'
  return a >= 500 ? 'lost' : a >= 200 ? 'worse' : 'slightly worse'
}

// Lila's winning-chances drop, for the game move's label
const chances = (cp: number) => 2 / (1 + Math.exp(-0.00368208 * Math.max(-1000, Math.min(1000, cp)))) - 1
function labelOf(before: number, after: number): MoveFact['label'] {
  const drop = (chances(before) - chances(after)) / 2
  return drop >= 0.15 ? 'blunder' : drop >= 0.1 ? 'mistake' : drop >= 0.05 ? 'inaccuracy' : 'good'
}

// UCI line → SAN, replayed; undefined if any move is illegal
export function uciLine(fen: string, ucis: string[]): { sans: string[]; replay: LineReplay } | undefined {
  const pos = fromFen(fen)
  if (!pos) return undefined
  const sans: string[] = []
  for (const u of ucis) {
    const move = parseUci(u)
    if (!move || !pos.isLegal(move)) return undefined
    sans.push(makeSan(pos, move))
    pos.play(move)
  }
  const r = replay(fen, sans)
  return r ? { sans, replay: r } : undefined
}

const pvMoves = (r: LineReplay, ucis: string[], prefix: string, start = 0): PvMove[] =>
  r.moves.map((m: PlayedMove, i) => ({
    id: `${prefix}${i + start}`,
    san: m.san,
    uci: ucis[i],
    side: sideOf(m.color),
    givesCheck: m.check || m.mate,
    isCapture: !!m.captured,
    captured: m.captured,
    mate: m.mate,
    from: m.from,
    to: m.to,
    fenBefore: m.fenBefore,
    fenAfter: m.fenAfter,
  }))

// The position with the other side to move: what they'd do with a free move.
// Flips the side, clears en passant, counts the null move on the halfmove
// clock; none in check.
export function nullMoveFen(fen: string): string | undefined {
  const pos = fromFen(fen)
  if (!pos || pos.isCheck()) return undefined
  const passed = pos.clone()
  passed.turn = other(pos.turn)
  passed.epSquare = undefined
  passed.halfmoves = pos.halfmoves + 1
  if (passed.turn === 'white') passed.fullmoves = pos.fullmoves + 1
  const out = makeFen(passed.toSetup())
  const back = fromFen(out)
  return back && !back.isCheck() ? out : undefined
}

function phaseOf(pos: Chess): Packet['position']['phase'] {
  let pieces = 0
  for (const [, p] of pos.board) if (p.role !== 'king' && p.role !== 'pawn') pieces += VALUE[p.role]
  return pieces <= 26 ? 'endgame' : pos.fullmoves <= 12 ? 'opening' : 'middlegame'
}

// --- validation of the report -------------------------------------------------

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/
const THEME = /^[a-zA-Z]{2,32}$/

function validRun(run: unknown, maxLines: number): run is EngineRun {
  if (!run || typeof run !== 'object') return false
  const r = run as EngineRun
  return (
    Array.isArray(r.lines) &&
    r.lines.length >= 1 &&
    r.lines.length <= maxLines &&
    r.lines.every(
      l =>
        l &&
        Array.isArray(l.pv) &&
        l.pv.length >= 1 &&
        l.pv.length <= 24 &&
        l.pv.every(u => typeof u === 'string' && UCI.test(u)) &&
        l.eval &&
        (l.eval.type === 'cp' || l.eval.type === 'mate') &&
        Number.isInteger(l.eval.value) &&
        Math.abs(l.eval.value) <= 100000,
    ) &&
    Number.isInteger(r.depth) &&
    r.depth >= 0 &&
    r.depth <= 99 &&
    Number.isFinite(r.nodes) &&
    typeof r.capped === 'boolean' &&
    (r.check === undefined ||
      (!!r.check &&
        Number.isInteger(r.check.depth) &&
        Array.isArray(r.check.pv) &&
        r.check.pv.length >= 1 &&
        r.check.pv.length <= 24 &&
        r.check.pv.every(u => typeof u === 'string' && UCI.test(u)) &&
        !!r.check.eval &&
        (r.check.eval.type === 'cp' || r.check.eval.type === 'mate') &&
        Number.isInteger(r.check.eval.value)))
  )
}

const runs = (x: unknown, n: number, maxLines: number) => Array.isArray(x) && x.length >= 1 && x.length <= n && x.every(r => validRun(r, maxLines))

// Strings that reach the prompt: NFKC, no control/bidi/zero-width, capped
export function cleanText(s: unknown, max = 64): string | undefined {
  if (typeof s !== 'string') return undefined
  const t = s
    .normalize('NFKC')
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g, '')
    .replace(/[^\p{L}\p{N} '’\-,.:()/&]/gu, '')
    .trim()
    .slice(0, max)
  return t || undefined
}

export function validReport(body: unknown): EngineReport | undefined {
  if (!body || typeof body !== 'object') return undefined
  const b = body as EngineReport
  if (b.schema !== REPORT_SCHEMA || typeof b.fen !== 'string' || b.fen.length > 100) return undefined
  if (!KINDS.includes(b.kind) || !BANDS.includes(b.band)) return undefined
  if (!Array.isArray(b.solution) || !b.solution.length || b.solution.length > 24 || !b.solution.every(u => typeof u === 'string' && UCI.test(u))) return undefined
  if (b.holding !== undefined && !(Array.isArray(b.holding) && b.holding.length <= 4 && b.holding.every(u => typeof u === 'string' && UCI.test(u)))) return undefined
  if (b.history !== undefined && !(Array.isArray(b.history) && b.history.length <= 600 && b.history.every(f => typeof f === 'string' && f.length <= 100))) return undefined
  if (!runs(b.best, 2, CERT.kMax)) return undefined
  if (b.threat !== undefined && !runs(b.threat, 2, CERT.threatMultipv)) return undefined
  for (const m of [b.played, b.tried]) if (m !== undefined && !(m && typeof m.uci === 'string' && UCI.test(m.uci) && runs(m.runs, 2, 2))) return undefined
  if (!b.habit || !Array.isArray(b.habit.recent) || b.habit.recent.length > 8 || !b.habit.recent.every(h => typeof h === 'string' && /^habit:[a-z0-9-]{1,40}$/.test(h))) return undefined
  if (b.habit.weeklyFocus !== undefined && !(typeof b.habit.weeklyFocus === 'string' && /^habit:[a-z0-9-]{1,40}$/.test(b.habit.weeklyFocus))) return undefined
  const themes = Array.isArray(b.themes) ? b.themes.filter(t => typeof t === 'string' && THEME.test(t)).slice(0, 12) : undefined
  return {
    schema: REPORT_SCHEMA,
    fen: b.fen,
    history: b.history,
    solution: b.solution,
    holding: b.holding,
    kind: b.kind,
    band: b.band,
    themes,
    opening: cleanText(b.opening),
    eco: typeof b.eco === 'string' && /^[A-E]\d\d$/.test(b.eco) ? b.eco : undefined,
    best: b.best,
    threat: b.threat,
    played: b.played,
    tried: b.tried,
    habit: { weeklyFocus: b.habit.weeklyFocus, recent: b.habit.recent },
  }
}

// --- certification decisions ----------------------------------------------------

interface RunPair {
  a: EngineRun
  b?: EngineRun
}
// The second opinion: a second run if there is one, else the same search two
// iterations earlier (a cleared-hash rerun on one thread is identical, so
// the iteration check is the one that can disagree)
const pair = (rs: EngineRun[]): RunPair => {
  const a = rs[0]
  if (rs[1]) return { a, b: rs[1] }
  if (!a.check) return { a }
  return { a, b: { lines: [{ pv: a.check.pv, eval: a.check.eval }], depth: a.depth, nodes: a.nodes, capped: false } }
}

// The same best move, both runs deep enough, uncapped, and evals within τ_instab
function stability(p: RunPair, flip: boolean) {
  const ea = pov(p.a.lines[0].eval, flip)
  const eb = p.b ? pov(p.b.lines[0].eval, flip) : undefined
  const reached = Math.min(p.a.depth, p.b?.depth ?? p.a.depth)
  const sameMove = !!p.b && p.b.lines[0].pv[0] === p.a.lines[0].pv[0]
  const range: [number, number] = eb ? [Math.min(cpOf(ea), cpOf(eb)), Math.max(cpOf(ea), cpOf(eb))] : [cpOf(ea), cpOf(ea)]
  const mateBoth = ea.type === 'mate' && !!eb && eb.type === 'mate' && Math.sign(ea.value) === Math.sign(eb.value)
  const stable = !!eb && sameMove && reached >= CERT.refuseDepth && (mateBoth || range[1] - range[0] <= CERT.instabCp)
  const typed: TypedEval = { type: ea.type, value: ea.type === 'mate' && eb?.type === 'mate' ? (ea.value > 0 ? Math.max(ea.value, eb.value) : Math.min(ea.value, eb.value)) : ea.value, range: ea.type === 'cp' ? range : undefined, stable, reachedDepth: reached }
  return { typed, reached, sameMove, stable, mateBoth, capped: p.a.capped || !!p.b?.capped }
}

// --- the builder ----------------------------------------------------------------

export type BuildResult = { ok: true; packet: Packet } | { ok: false; error: string }

export const PROMPT_VERSION = 'p2.1'
export const RENDERER_VERSION = 'render/1.0'

export function buildPacket(report: EngineReport, promptVersion = PROMPT_VERSION): BuildResult {
  const v = validPosition(report.fen)
  if (!v.ok) return { ok: false, error: v.reason }
  const pos = v.pos
  const fen = makeFen(pos.toSetup())
  const player = pos.turn
  const opp = other(player)
  const band = report.band
  const refusals: string[] = []

  // The answer: two runs at the puzzle position
  const best = pair(report.best)
  const bs = stability(best, false)
  if (bs.reached < CERT.refuseDepth) refusals.push(`depth ${bs.reached} < ${CERT.refuseDepth}`)
  if (!best.b) refusals.push('no second opinion')
  else if (!bs.sameMove) refusals.push('best move differs between runs')
  else if (!bs.stable && !bs.capped && bs.reached >= CERT.refuseDepth) refusals.push(`eval range over ${CERT.instabCp} cp`)
  const accepted = report.holding?.length ? report.holding : [report.solution[0]]
  const engineBest = best.a.lines[0].pv[0]
  if (!accepted.includes(engineBest)) refusals.push('engine best move is not the puzzle answer')

  const answer = accepted.includes(engineBest) ? engineBest : report.solution[0]
  const pvUci = engineBest === answer ? best.a.lines[0].pv.slice(0, 8) : report.solution.slice(0, 8)
  const pvLine = uciLine(fen, pvUci)
  if (!pvLine) return { ok: false, error: 'best line is not legal' }
  const pv = pvMoves(pvLine.replay, pvUci, 'pv')

  // Uniqueness: the second line is worse by the band margin in both runs
  const margin = CERT.margin[band]
  const gapOf = (run: EngineRun) => {
    const second = run.lines[1]
    if (!second) return Infinity // only one legal move, or MultiPV 1
    const b0 = pov(run.lines[0].eval, false)
    const b1 = pov(second.eval, false)
    if (b0.type === 'mate' && b0.value > 0 && !(b1.type === 'mate' && b1.value > 0)) return Infinity
    return cpOf(b0) - cpOf(b1)
  }
  const gaps = [gapOf(best.a), best.b ? gapOf(best.b) : -Infinity]
  const minGap = Math.min(...gaps)
  const isHold = !!report.holding?.length
  const unique = !isHold && minGap >= margin
  if (!isHold && minGap < margin) refusals.push(`gap ${Number.isFinite(minGap) ? minGap : '?'} cp < margin ${margin}`)
  const mateIn = bs.mateBoth && bs.typed.value > 0 ? bs.typed.value : null

  // The game move and the player's try: their own runs
  const moveFact = (m: { uci: string; runs: EngineRun[] } | undefined, id: 'played' | 'tried', prefix: string): MoveFact | undefined => {
    if (!m) return undefined
    const first = uciLine(fen, [m.uci])
    if (!first) return undefined
    const after = first.replay.moves[0].fenAfter
    const p = pair(m.runs)
    const st = stability(p, true)
    const replyUci = p.a.lines[0].pv.slice(0, 6)
    const reply = uciLine(after, replyUci)
    const head = pvMoves(first.replay, [m.uci], id)[0]
    // A missed or allowed mate is a mate, never a number of pawns
    const stable = st.stable && bs.stable
    const swing: TypedEval =
      st.typed.type === 'mate' && st.typed.value < 0
        ? { type: 'mate', value: st.typed.value, stable, reachedDepth: st.reached }
        : bs.typed.type === 'mate' && bs.typed.value > 0
          ? { type: 'mate', value: bs.typed.value, stable, reachedDepth: st.reached }
          : { type: 'cp', value: cpOf(st.typed) - cpOf(bs.typed), stable, reachedDepth: st.reached }
    return {
      ...head,
      id,
      label: labelOf(cpOf(bs.typed), cpOf(st.typed)),
      swing,
      reply: reply ? pvMoves(reply.replay, replyUci, prefix, 1) : [],
    }
  }
  const played = moveFact(report.played, 'played', 'pl')
  const tried = report.tried && report.tried.uci !== report.played?.uci && !accepted.includes(report.tried.uci) ? moveFact(report.tried, 'tried', 'tr') : undefined
  const afterPlayed = report.played ? stability(pair(report.played.runs), true) : undefined
  if (played && !played.swing!.stable) refusals.push('game move eval unstable')

  // Threat: the opponent's best with a free move
  let threatStatus: ThreatStatus = 'uncertified'
  let threat: Packet['threat']
  const nullFen = nullMoveFen(fen)
  if (nullFen && report.threat) {
    const tp = pair(report.threat)
    const ts = stability(tp, false) // opponent's point of view
    const beforeOpp = -cpOf(bs.typed)
    const swings = (run: EngineRun) => run.lines.map(l => cpOf(pov(l.eval, false)) - beforeOpp)
    const sa = swings(tp.a)
    const sb = tp.b ? swings(tp.b) : []
    const lineUci = tp.a.lines[0].pv.slice(0, 4)
    const tl = uciLine(nullFen, lineUci)
    if (ts.stable && tl && Math.min(sa[0], sb[0] ?? -Infinity) >= CERT.threat[band]) {
      threatStatus = 'certified'
      const t = pvMoves(tl.replay, lineUci, 't')
      let net = 0
      for (const m of t) if (m.captured) net += (m.side === sideOf(opp) ? 1 : -1) * VALUE[m.captured]
      const nullEval = ts.typed
      threat = {
        id: 'threat',
        san: t[0].san,
        side: sideOf(opp),
        targetSide: sideOf(player),
        viaNullMove: true,
        threatDef: THREAT_DEF,
        line: t,
        consequence: ts.mateBoth && nullEval.value > 0 ? { type: 'mate', swingCp: Math.round(Math.min(sa[0], sb[0])), mateIn: nullEval.value } : net > 0 ? { type: 'winsMaterial', swingCp: Math.round(Math.min(sa[0], sb[0])), material: net } : { type: 'other', swingCp: Math.round(Math.min(sa[0], sb[0])) },
        certifiedAtDepth: ts.reached,
        complete: true,
      }
    } else if (ts.stable && sa.length && sb.length && [...sa, ...sb].every(s => s < CERT.nullCp)) threatStatus = 'certifiedNull'
  }

  // Rule-draw state overrules the eval
  const gs = gameState(pos, report.history)
  const rule = drawRule(gs)
  if (rule === 'claimable') refusals.push('a draw can be claimed')
  if (rule === 'automatic') refusals.push('the game is drawn by rule')
  if (rule === 'dead-draw') {
    threatStatus = 'certifiedNull'
    threat = undefined
  }

  const fenAfter = played ? played.fenAfter : pv[0].fenAfter
  const afterPos = fromFen(fenAfter)!
  const kingSquare = (p: Chess) => {
    const k = p.board.kingOf(p.turn)
    return p.isCheck() && k !== undefined ? makeSquare(k) : null
  }

  // Alternatives from the first run's other lines
  const alternatives: Packet['alternatives'] = best.a.lines.slice(1, 4).flatMap((l, i) => {
    const line = uciLine(fen, [l.pv[0]])
    if (!line) return []
    const e = pov(l.eval, false)
    const gap = cpOf(bs.typed) - cpOf(e)
    return [{ id: `alt${i + 1}`, san: line.sans[0], side: sideOf(player), eval: { type: e.type, value: e.value, stable: false }, gapCp: Math.round(gap), verdict: gap >= margin ? ('worse' as const) : ('close' as const) }]
  })

  // Certificates (≤ 8): patterns detected again here, never taken on trust
  const certificates: Certificate[] = []
  const add = (c: Certificate) => certificates.length < 8 && certificates.push(c)
  if (rule) add({ id: 'c-draw', type: 'drawRule', side: sideOf(player), payload: { rule, gameState: gs }, text: DRAW_TEXT[rule] })
  if (mateIn !== null && pv.some(m => m.mate)) add({ id: 'c-mate', type: 'mate', subject: 'best', side: sideOf(player), targetSide: sideOf(opp), payload: { mateIn, lineIds: pv.slice(0, pv.findIndex(m => m.mate) + 1).map(m => m.id) }, text: `mate in at most ${mateIn}` })
  if (unique && bs.stable) {
    const alts = alternatives.map(a => ({ move: a.san, gapCp: a.gapCp }))
    add({ id: 'c-forced', type: 'forced', subject: 'best', side: sideOf(player), payload: { allAlternativesWorse: true, checkedAtDepth: CERT.depth, reachedDepth: bs.reached, marginCp: margin, complete: true, alternatives: alts }, text: `every other move is at least ${amount(margin, band)} worse` })
  }
  const bestMotif = rule === 'dead-draw' ? undefined : motifs(pvLine.replay)[0]
  const motifCert = (m: Motif, id: string, side: Color, line: PvMove[], subject: string): Certificate => ({
    id,
    type: 'tactical',
    subject,
    side: sideOf(side),
    targetSide: sideOf(other(side)),
    motif: m.name,
    payload: { ply: m.ply, moveId: line[m.ply]?.id, detectorVersion: DETECTOR_VERSION, ...hangingPayload(m, line) },
    text: m.text,
  })
  if (bestMotif) add(motifCert(bestMotif, 'c-motif', player, pv, 'best'))
  const punish = (fact: MoveFact | undefined, id: string) => {
    if (!fact) return
    const ucis = [fact.uci, ...fact.reply.map(r => r.uci)]
    const l = uciLine(fen, ucis)
    const m = l && motifs(l.replay, 1)[0]
    if (m) add(motifCert(m, id, opp, [fact, ...fact.reply], fact.id))
  }
  punish(tried, 'c-try')
  punish(played, 'c-punish')
  // "The answer stops the threat" only when it does: after the answer, the
  // threatening move is illegal, no longer mates, or no longer wins the same thing
  if (threat && stopsThreat(pv[0].fenAfter, threat.line[0])) add({ id: 'c-stops', type: 'stopsThreat', subject: 'best', side: sideOf(player), payload: { threat: threat.san }, text: `${pv[0].san} stops ${threat.san}` })
  if (threatStatus === 'certifiedNull') add({ id: 'c-nothreat', type: 'noThreat', side: sideOf(opp), targetSide: sideOf(player), payload: { threatDef: THREAT_DEF, floorCp: CERT.nullCp }, text: 'no forcing reply' })

  // Quiet-position facts: what the answer changes (feature deltas)
  const features = featureBlock(fen, pv[0].fenAfter, 'best')
  if (features) for (const d of features.deltas) add({ id: `c-${d.id}`, type: 'featureDelta', side: d.side, payload: { deltaId: d.id }, text: deltaText(d) })

  const concepts = certificates.filter(c => c.type === 'tactical' && c.side === sideOf(player)).map(c => ({ tag: c.motif!, cert: c.id }))
  const matBefore = materialOf(pos, player)
  const pvEnd = fromFen(pv[pv.length - 1].fenAfter)!
  const matAfter = played ? materialOf(fromFen((played.reply.at(-1) ?? played).fenAfter)!, player) : materialOf(pvEnd, player)

  const status: Packet['meta']['certification']['status'] = refusals.length === 0 ? 'certified' : refusals.some(r => /depth|differs|not the puzzle|second opinion|range/.test(r)) ? 'refused' : 'partial'
  const holding = (report.holding ?? []).flatMap((u, i) => {
    const l = uciLine(fen, [u])
    return l ? [{ id: `hold${i + 1}`, san: l.sans[0], uci: u }] : []
  })

  // Didactics: the point is fixed here, the narrator only phrases it
  const kind = report.kind
  const motifKey: MotifKey = bestMotif?.name ?? 'none'
  const habit = selectHabit({ kind, band, weeklyFocusHabitId: report.habit.weeklyFocus, recent: report.habit.recent })
  const gloss = motifEntry(motifKey, band)
  const ids = {
    pv: pv.map(m => m.id),
    played: played ? ['played', ...played.reply.map(r => r.id)] : [],
    tried: tried ? ['tried', ...tried.reply.map(r => r.id)] : [],
    threat: threat ? ['threat', ...threat.line.map(m => m.id)] : [],
  }
  const claimAnchors = [
    'best',
    ...ids.pv,
    ...ids.played,
    ...(played ? ['swing'] : []),
    ...ids.tried,
    ...holding.map(h => h.id),
    ...alternatives.map(a => a.id),
    ...ids.threat,
    ...(pos.isCheck() ? ['check'] : []),
    ...certificates.map(c => c.id),
    'material',
    habit.id,
    gloss.id,
  ]
  const required: Record<SlotName, string[]> = {
    whatHappened: played ? ['played', 'swing'] : ['best'],
    why: [threatRequirement(threatStatus, threat, pos.isCheck())].filter((x): x is string => !!x),
    pattern: bestMotif ? ['c-motif', gloss.id] : [gloss.id],
    nextTime: [habit.id],
  }
  // Per-type additions
  if (kind === 'hang' || kind === 'hold' || kind === 'defensive') required.why.push(holding.length > 1 ? holding.map(h => h.id).join('|') : 'best')
  if ((kind === 'missed-win' || kind === 'lichess') && pv.length > 1) required.why.push(pv.slice(1, 4).map(m => m.id).join('|'))
  if (kind === 'conversion') required.why.push('material')

  const packet: Packet = {
    schema: PACKET_SCHEMA,
    meta: {
      packetHash: '',
      promptVersion,
      engine: { ...ENGINE, certDepth: CERT.depth, multipv: CERT.multipv, nodesCap: CERT.nodesCap },
      certification: { status, policyVersion: CERT.version, refusals, evalStable: bs.stable },
      readabilityVersion: READABILITY_VERSION,
      versions: versions(promptVersion),
    },
    position: {
      fenBefore: fen,
      fenAfter,
      sideToMove: player,
      playerColor: player,
      moveNumber: pos.fullmoves,
      phase: phaseOf(pos),
      check: { before: pos.isCheck(), after: afterPos.isCheck(), kingSquare: kingSquare(afterPos) ?? kingSquare(pos) },
      gameState: gs,
      drawRule: rule,
    },
    played,
    tried,
    eval: {
      source: 'stockfish',
      before: bs.typed,
      afterPlayed: afterPlayed?.typed,
      verdict: { before: rule === 'dead-draw' ? 'dead-draw' : rule === 'automatic' ? 'draw (automatic)' : verdictOf(bs.typed), afterPlayed: afterPlayed ? verdictOf(afterPlayed.typed) : undefined, forColor: player },
    },
    best: {
      id: 'best',
      san: pv[0].san,
      uci: pv[0].uci,
      side: sideOf(player),
      unique,
      uniquenessGapCp: Number.isFinite(minGap) ? Math.round(minGap) : null,
      certifiedAtDepth: bs.stable ? bs.reached : null,
      reachedDepth: bs.reached,
      mateIn,
      materialAfterPv: materialOf(pvEnd, player) - matBefore,
      pv,
      pvComplete: pv.some(m => m.mate) || pv.length >= Math.min(8, pvUci.length),
      pvTerminal: pv.some(m => m.mate) ? 'mate' : bs.stable ? 'advantage-stable' : 'truncated',
    },
    holding,
    alternatives,
    threatStatus,
    threat,
    features,
    certificates,
    concepts: rule === 'dead-draw' ? [] : concepts,
    material: { before: matBefore, after: matAfter, delta: matAfter - matBefore },
    claimAnchors,
    didactic: {
      puzzleType: kind,
      family: family(kind),
      motif: motifKey,
      motifCert: bestMotif ? 'c-motif' : null,
      requiredRefs: required,
      habitSlotId: habit.id,
      glossId: gloss.id,
      mechanismMin: band === 'beginner' ? 1 : 2,
    },
    context: { opening: report.opening, eco: report.eco, band },
  }
  return { ok: true, packet }
}

function stopsThreat(fenAfterBest: string, t: PvMove): boolean {
  const pos = fromFen(fenAfterBest)
  if (!pos) return false
  // The threat needs the opponent to move; after the answer they do
  const move = parseUci(t.uci)
  if (!move || !pos.isLegal(move)) return true
  const victim = 'from' in move ? pos.board.get(move.to) : undefined
  const next = pos.clone()
  next.play(move)
  if (t.mate) return !next.isCheckmate()
  if (t.captured) return !victim || victim.role !== t.captured
  return false
}

function threatRequirement(status: ThreatStatus, threat: Packet['threat'], inCheck: boolean): string | undefined {
  if (status === 'certified' && threat) return 'threat'
  if (status === 'certifiedNull') return 'threat|c-nothreat'
  // In check the threat is already on the board: the check itself
  if (inCheck) return 'check'
  return undefined // uncertified: the narrator can't pass U7, so the floor serves
}

const DRAW_TEXT: Record<Exclude<DrawRule, undefined>, string> = {
  'dead-draw': 'neither side has enough material left to checkmate, so the game is a draw',
  claimable: 'a draw can be claimed here (fifty moves without a capture or pawn move, or the same position three times)',
  automatic: 'the game is drawn by rule here (seventy-five moves, or the same position five times)',
}

// The arithmetic behind a hanging piece: who attacks it, who can defend it
function hangingPayload(m: Motif, line: PvMove[]): Record<string, unknown> {
  if (m.name !== 'hanging piece') return {}
  const move = line[m.ply]
  if (!move?.captured) return {}
  const pos = fromFen(move.fenBefore)!
  const sq = parseSquare(move.to)!
  const victim = pos.board.get(sq)!
  const attackers = [...pos.kingAttackers(sq, pos.turn, pos.board.occupied)].map(makeSquare)
  const defenders = [...pos.kingAttackers(sq, victim.color, pos.board.occupied)].map(makeSquare)
  return { square: move.to, piece: victim.role, attackers, legalDefenders: defenders, swingOnCapture: VALUE[victim.role] * 100 }
}

const FILE_STATE: Record<string, string> = { open: 'open', halfOpenW: 'half-open for White', halfOpenB: 'half-open for Black', closed: 'closed' }
const SIDE_NAME = (s: Side) => (s === 'w' ? 'White' : 'Black')

// One plain sentence per feature delta, built from the delta itself
export function deltaText(d: FeatureDelta): string {
  const b = d.before as unknown
  const a = d.after as unknown
  switch (d.feature) {
    case 'openFiles': {
      const fa = a as { file: string; state: string }
      const fb = b as { file: string; state: string }
      return `the ${fa.file}-file goes from ${FILE_STATE[fb.state] ?? fb.state} to ${FILE_STATE[fa.state] ?? fa.state}`
    }
    case 'luft':
      return a ? `${SIDE_NAME(d.side)}'s king gains a safe escape square` : `${SIDE_NAME(d.side)}'s king loses its safe escape square`
    case 'shieldBroken':
      return `${SIDE_NAME(d.side)}'s pawn cover in front of the king changes from ${b} to ${a} broken files`
    case 'activity': {
      const aa = a as { diff: number }
      const ab = b as { diff: number }
      return `${SIDE_NAME(d.side)}'s pieces gain room: the mobility gap moves from ${ab.diff} to ${aa.diff}`
    }
    default: {
      const added = (a as string[]).filter(x => !(b as string[]).includes(x))
      const word = { passed: 'passed', isolated: 'isolated', backward: 'backward', doubled: 'doubled' }[d.feature] ?? d.feature
      return `${SIDE_NAME(d.side)} gets a new ${word} pawn on ${added.join(' and ')}`
    }
  }
}

export function versions(promptVersion = PROMPT_VERSION): Record<string, string> {
  return {
    schema: PACKET_SCHEMA,
    builder: BUILDER_VERSION,
    detector: DETECTOR_VERSION,
    features: FEATURES_VERSION,
    threatDef: THREAT_DEF,
    certPolicy: CERT.version,
    habitLib: HABIT_LIB_VERSION,
    motifLib: MOTIF_LIB_VERSION,
    readability: READABILITY_VERSION,
    renderer: RENDERER_VERSION,
    prompt: promptVersion,
  }
}

// --- hashing -------------------------------------------------

// Stable JSON: keys sorted, so the same inputs always hash the same
export function canonicalJSON(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonicalJSON).join(',')}]`
  if (x && typeof x === 'object')
    return `{${Object.keys(x)
      .sort()
      .filter(k => (x as Record<string, unknown>)[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${canonicalJSON((x as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(x)
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return `sha256:${[...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')}`
}

// Inputs and config only, never eval values or PV text (evals aren't
// bit-reproducible): a hash change means the logic or the puzzle changed
export function packetHash(input: { fen: string; solution: string[]; band: Band; promptVersion?: string }): Promise<string> {
  return sha256(
    canonicalJSON({
      fenCanonical: canonicalFen(input.fen) ?? input.fen,
      solutionUci: input.solution,
      engine: { id: ENGINE.id, version: ENGINE.version, certDepth: CERT.depth, multipv: CERT.multipv },
      band: input.band,
      ...versions(input.promptVersion),
    }),
  )
}

// One packet per position, band, type and colour
export function dedupeKey(input: { fen: string; occurrenceCount: number; band: Band; kind: PuzzleKind }): string {
  const fen = canonicalFen(input.fen) ?? input.fen
  return [fen, input.occurrenceCount, input.band, input.kind, fen.split(' ')[1]].join('|')
}

// --- packet self-check ("the reference packet must pass") --------------

export function packetProblems(p: Packet): string[] {
  const problems: string[] = []
  const anchors = new Set(p.claimAnchors)
  const forbidden = ['fenBefore', 'fenAfter', 'context', 'gameState', 'meta', 'position']
  for (const a of p.claimAnchors) {
    if (forbidden.includes(a)) problems.push(`state field ${a} is a claim anchor`)
    if (!/^[a-z0-9:-]+$/.test(a)) problems.push(`anchor ${a} has a bad id`)
  }
  if (anchors.has('habit') || anchors.has('gloss')) problems.push('bare habit/gloss anchor')
  if (!anchors.has(p.didactic.habitSlotId) || !p.didactic.habitSlotId.startsWith('habit:')) problems.push('habit slot is not a prefixed anchor')
  if (!anchors.has(p.didactic.glossId) || !p.didactic.glossId.startsWith('gloss:')) problems.push('gloss is not a prefixed anchor')
  for (const [slot, refs] of Object.entries(p.didactic.requiredRefs))
    for (const r of refs) if (!r.split('|').some(x => anchors.has(x))) problems.push(`required ref ${r} in ${slot} is not an anchor`)
  if (p.certificates.length > 8) problems.push('more than 8 certificates')
  if (p.alternatives.length > 3) problems.push('more than 3 alternatives')
  if (p.features && JSON.stringify(p.features).length > 4096) problems.push('features block over 4 KB')
  const forced = p.certificates.find(c => c.id === 'c-forced')
  if (forced) {
    const pl = forced.payload as { marginCp: number; alternatives: { gapCp: number }[]; complete: boolean }
    if (!p.best.unique) problems.push('forced certificate on a move that is not unique')
    if (pl.alternatives.some(a => a.gapCp < pl.marginCp)) problems.push('forced certificate with an alternative inside the margin')
    if (p.best.uniquenessGapCp !== null && p.best.uniquenessGapCp < pl.marginCp) problems.push('uniqueness gap below the margin')
  }
  if (p.threatStatus === 'certified' && !p.threat) problems.push('certified threat without a threat')
  if (p.threatStatus !== 'certifiedNull' && anchors.has('c-nothreat')) problems.push('no-threat certificate without certifiedNull')
  if (p.threat && p.threat.side === sideOf(p.position.playerColor)) problems.push('threat owned by the player')
  if (p.meta.certification.status === 'certified' && p.meta.certification.refusals.length) problems.push('certified with refusals')
  return problems
}

export const SIDE = sideOf
