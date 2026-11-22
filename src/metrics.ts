import { Chess } from 'chessops/chess'
import { parseUci } from 'chessops/util'
import type { Band, Game, JournalEntry } from './db'
import { povCp } from './puzzles/generate'

export interface Swing {
  ply: number
  san: string
  swingCp: number
  materialLost: number // pawn-points the player was down 3 plies later, vs before the move
}

const VALUE = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 }

function material(pos: Chess, color: 'white' | 'black'): number {
  let sum = 0
  for (const [, piece] of pos.board) sum += (piece.color === color ? 1 : -1) * VALUE[piece.role]
  return sum
}

// The player's moves with how much each one cost, skipping book moves and
// positions that were already decided (the same gates as puzzle candidates).
export function swings(game: Game): Swing[] {
  const pos = Chess.default()
  const materials = [material(pos, game.color)]
  for (const m of game.moves) {
    pos.play(parseUci(m.uci)!)
    materials.push(material(pos, game.color))
  }
  const out: Swing[] = []
  let prev = undefined as Game['moves'][number]['eval']
  game.moves.forEach((m, i) => {
    const ply = i + 1
    const mover = ply % 2 === 1 ? 'white' : 'black'
    if (mover === game.color && prev && m.eval && !m.book) {
      const before = povCp(prev, mover)
      const decided = Math.abs(before) >= 900 && prev.mate === undefined
      const swingCp = before - povCp(m.eval, mover)
      if (!decided && swingCp > 0) {
        const later = materials[Math.min(i + 4, materials.length - 1)]
        out.push({ ply, san: m.san, swingCp, materialLost: Math.max(0, materials[i] - later) })
      }
    }
    prev = m.eval ?? prev
  })
  return out
}

// A move's cost at or above this is in the player's own worst 5% (
// Advanced). Until there are 100 moves to rank, 3 pawns stands in.
export function worst5Cutoff(games: Game[]): number {
  const all = games.flatMap(g => swings(g).map(s => s.swingCp)).sort((a, b) => b - a)
  if (all.length < 100) return 300
  return all[Math.floor(all.length * 0.05)]
}

// The game's worst hang by the band's definition, if it has one
export function hangOf(game: Game, band: Band, cutoff = Infinity): Swing | undefined {
  const hangs = swings(game).filter(s =>
    band === 'beginner'
      ? s.swingCp >= 300
      : band === 'club'
        ? s.swingCp >= 150 && s.materialLost >= 1
        : s.swingCp >= 150 && s.swingCp >= cutoff,
  )
  return hangs.sort((a, b) => b.swingCp - a.swingCp)[0]
}

export interface Streak {
  current: number
  best: number
  lastHang?: { gameId: string; ply: number }
}

// Consecutive zero-hang games, oldest to newest (S8 hero metric)
export function streak(entries: JournalEntry[]): Streak {
  const sorted = [...entries].sort((a, b) => a.at - b.at)
  let current = 0
  let best = 0
  let lastHang: Streak['lastHang']
  for (const e of sorted) {
    if (e.hung) {
      current = 0
      lastHang = { gameId: e.gameId, ply: e.hung.ply }
    } else best = Math.max(best, ++current)
  }
  return { current, best, lastHang }
}

export function journalFor(game: Game, band: Band, cutoff: number, old?: JournalEntry): JournalEntry {
  const h = hangOf(game, band, cutoff)
  return {
    gameId: game.id,
    at: game.playedAt,
    opening: game.opening,
    hung: h && { ply: h.ply, san: h.san, swingCp: h.swingCp },
    note: old?.note,
    confirmed: old?.confirmed ?? false,
  }
}

export const familyOf = (g: Game) => (g.opening || g.eco || 'Unknown').split(':')[0].trim()

export interface OpeningRow {
  family: string
  games: number
  win: number
  draw: number
  loss: number
  analyzed: number // games with a journal entry
  hangs: number // of those, games with a hang
}

// Win/draw/loss and hang count per opening family, e.g.
// "Italian Game: Two Knights Defense" counts as "Italian Game".
export function openingTable(games: Game[], journal = new Map<string, JournalEntry>()): OpeningRow[] {
  const rows = new Map<string, OpeningRow>()
  for (const g of games) {
    const family = familyOf(g)
    const r = rows.get(family) ?? { family, games: 0, win: 0, draw: 0, loss: 0, analyzed: 0, hangs: 0 }
    r.games++
    r[g.result]++
    const j = journal.get(g.id)
    if (j) {
      r.analyzed++
      if (j.hung) r.hangs++
    }
    rows.set(family, r)
  }
  return [...rows.values()].sort((a, b) => b.games - a.games)
}

// Beginner repertoire template: open games with e4 as White, e5 against
// e4 and the Queen's Gambit Declined against d4. Opening names as Lichess
// and Chess.com give them.
export const TEMPLATE_FAMILIES = ['Italian Game', 'Four Knights Game', 'Scotch Game', "King's Pawn Game", "Queen's Gambit Declined", 'Petrov\'s Defense']


// Plan targets: the player's own choice, else their top 3 families
// once they have 100 games at Club level or above, else the template
export function repertoireTargets(games: Game[], band: Band, chosen?: string[]): string[] {
  if (chosen?.length) return chosen
  if (band === 'beginner' || games.length < 100) return TEMPLATE_FAMILIES
  return openingTable(games)
    .filter(r => r.family !== 'Unknown')
    .slice(0, 3)
    .map(r => r.family)
}

// Share of the last 30 games that reached a target family
export function compliance(games: Game[], targets: string[]): number | undefined {
  const recent = [...games].sort((a, b) => b.playedAt - a.playedAt).slice(0, 30)
  if (!recent.length) return undefined
  const set = new Set(targets.map(t => t.toLowerCase()))
  return recent.filter(g => set.has(familyOf(g).toLowerCase())).length / recent.length
}
