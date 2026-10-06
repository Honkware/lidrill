import { Chess } from 'chessops/chess'
import { parseUci } from 'chessops/util'
import type { Band, Game, JournalEntry, Profile, Review } from './db'
import { BAND_DEFAULTS } from './profile'
import { cleanSolve } from './train'

const DAY = 24 * 3600 * 1000
const ROLE_NAME = { pawn: 'pawn', knight: 'knight', bishop: 'bishop', rook: 'rook', queen: 'queen', king: 'king' } as const

export interface Metrics {
  games: number
  hangRate: number // share of games with a hang
  conversionRate?: number // won / games with a held 5-point lead; undefined if none
  solveRate?: number // share of attempts solved without the hint
  timeouts: number
  earlyResigns: number // resigned before move 20
}

const VALUE = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 }

// Did the player hold a lead of 5+ pawn-points for 4+ plies in a row?
export function heldLead(game: Game): boolean {
  const pos = Chess.default()
  let run = 0
  for (const m of game.moves) {
    pos.play(parseUci(m.uci)!)
    let lead = 0
    for (const [, p] of pos.board) lead += (p.color === game.color ? 1 : -1) * VALUE[p.role]
    run = lead >= 5 ? run + 1 : 0
    if (run >= 4) return true
  }
  return false
}

export function metrics(games: Game[], journal: Map<string, JournalEntry>, reviews: Review[]): Metrics {
  const withLead = games.filter(heldLead)
  const attempts = reviews.length
  return {
    games: games.length,
    hangRate: games.length ? games.filter(g => journal.get(g.id)?.hung).length / games.length : 0,
    conversionRate: withLead.length ? withLead.filter(g => g.result === 'win').length / withLead.length : undefined,
    solveRate: attempts ? reviews.filter(cleanSolve).length / attempts : undefined,
    timeouts: games.filter(g => g.result === 'loss' && /timeout|outoftime|timevs/i.test(g.termination)).length,
    earlyResigns: games.filter(g => g.result === 'loss' && /resign/i.test(g.termination) && g.moves.length < 40).length,
  }
}

export interface Leak {
  role: string
  count: number
  file?: string // set when most of them landed on one file
}

// Recurring-leak detector: the same piece hung 3+ times in 90 days.
// "Hung" is the journal's band-relative hang; the piece is the one moved.
export function recurringLeak(games: Game[], journal: JournalEntry[], now: Date): Leak | undefined {
  const byId = new Map(games.map(g => [g.id, g]))
  const groups = new Map<string, string[]>()
  for (const j of journal) {
    if (!j.hung || +now - j.at > 90 * DAY) continue
    const game = byId.get(j.gameId)
    const move = game?.moves[j.hung.ply - 1]
    if (!game || !move) continue
    const pos = Chess.default()
    for (const m of game.moves.slice(0, j.hung.ply - 1)) pos.play(parseUci(m.uci)!)
    const from = parseUci(move.uci)
    const piece = from && 'from' in from ? pos.board.get(from.from) : undefined
    if (!piece) continue
    groups.set(piece.role, [...(groups.get(piece.role) ?? []), move.uci.slice(2, 3)])
  }
  const [role, files] = [...groups].sort((a, b) => b[1].length - a[1].length)[0] ?? []
  if (!role || files.length < 3) return undefined
  const fileCounts = new Map<string, number>()
  for (const f of files) fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1)
  const [file, n] = [...fileCounts].sort((a, b) => b[1] - a[1])[0]
  return { role: ROLE_NAME[role as keyof typeof ROLE_NAME], count: files.length, file: n >= 3 ? file : undefined }
}

export function leakLine(leak: Leak): string {
  const where = leak.file ? ` on the ${leak.file}-file` : ''
  const piece = leak.role === 'queen' ? 'your queen' : `${leak.role}s`
  return `Your hangs keep involving ${piece}${where}: ${leak.count} in the last 90 days. Before moving one, check what attacks the square it lands on.`
}

// One focus for the week: the recurring leak if there is one, else the
// weakest of the three areas.
export function weeklyFocus(m: Metrics, leak: Leak | undefined, band: Band): string {
  if (leak) return leakLine(leak)
  if (m.games >= 3 && m.hangRate >= 0.3)
    return band === 'beginner'
      ? 'Blunder check before every move: what does my move leave undefended, and what can take it?'
      : 'Before each move, list your opponent\'s checks, captures and threats.'
  if (m.conversionRate !== undefined && m.conversionRate < 0.7) return 'You\'re letting winning positions slip. Trade pieces when ahead and work through the conversion drills.'
  if (m.timeouts >= 2) return 'Clock trouble: you lost on time this week more than once. Spend less time on the opening.'
  return 'Keep the streak going: one careful game at a time.'
}

export interface WeekReport {
  thisWeek: Metrics
  lastWeek: Metrics
  focus: string
  leak?: Leak
}

export function weekReport(games: Game[], journal: JournalEntry[], reviews: Review[], profile: Profile, now: Date): WeekReport {
  const j = new Map(journal.map(e => [e.gameId, e]))
  const span = (from: number, to: number) => {
    const g = games.filter(x => x.analyzedAt && x.playedAt >= from && x.playedAt < to)
    const r = reviews.filter(x => x.at >= from && x.at < to)
    return metrics(g, j, r)
  }
  const thisWeek = span(+now - 7 * DAY, +now + 1)
  const lastWeek = span(+now - 14 * DAY, +now - 7 * DAY)
  const leak = recurringLeak(games, journal, now)
  return { thisWeek, lastWeek, leak, focus: weeklyFocus(thisWeek, leak, profile.band) }
}

// Calibration knob: keep first-try success between 70% and 85%.
// Easier puzzles come from bigger swings, so success above 85% lowers the
// swing threshold (subtler mistakes become puzzles) and below 70% raises it.
// Needs 20 attempts in the last week, and moves at most once a week.
export function calibrate(profile: Profile, reviews: Review[], now: Date): Profile | undefined {
  const last = profile.thresholdHistory?.at(-1)?.at ?? 0
  if (+now - last < 7 * DAY) return undefined
  const week = reviews.filter(r => r.at >= +now - 7 * DAY)
  if (week.length < 20) return undefined
  const rate = week.filter(cleanSolve).length / week.length
  const base = BAND_DEFAULTS[profile.band].swingThresholdCp
  const step = rate > 0.85 ? -25 : rate < 0.7 ? 25 : 0
  if (!step) return undefined
  const swingThresholdCp = Math.min(base + 150, Math.max(100, profile.swingThresholdCp + step))
  if (swingThresholdCp === profile.swingThresholdCp) return undefined
  return {
    ...profile,
    swingThresholdCp,
    thresholdHistory: [...(profile.thresholdHistory ?? []), { cp: swingThresholdCp, at: +now, solveRate: rate }],
  }
}

// For the weekly bars: games and zero-hang games per week, oldest week first
export function weeklyZeroHang(journal: JournalEntry[], now: Date, weeks = 8): { games: number; clean: number }[] {
  return Array.from({ length: weeks }, (_, i) => {
    const to = +now - (weeks - 1 - i) * 7 * DAY
    const inWeek = journal.filter(j => j.at > to - 7 * DAY && j.at <= to)
    return { games: inWeek.length, clean: inWeek.filter(j => !j.hung).length }
  })
}

