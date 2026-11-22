import { Chess, normalizeMove } from 'chessops/chess'
import { makeFen, parseFen } from 'chessops/fen'
import { makeUci, parseUci } from 'chessops/util'
import { db, type Game, type Opening, type RepMove, type RepSource } from '../db'
import { familyOf, openingTable } from '../metrics'

// The player's repertoire: their move in each position they reach on their
// own side. It comes from the openings they pick (a built-in list, or their
// most played openings), their own most played moves in those openings, a
// Lichess study, and moves they add while training. Everything but the
// added moves is rebuilt from those sources when they change.

export const BUILTIN: Opening[] = [
  { name: 'Italian Game', color: 'white', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4'] },
  { name: 'Ruy Lopez', color: 'white', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'] },
  { name: 'Scotch Game', color: 'white', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'd2d4'] },
  { name: 'London System', color: 'white', moves: ['d2d4', 'd7d5', 'c1f4'] },
  { name: "Queen's Gambit", color: 'white', moves: ['d2d4', 'd7d5', 'c2c4'] },
  { name: 'Sicilian Defense', color: 'black', moves: ['e2e4', 'c7c5'] },
  { name: 'French Defense', color: 'black', moves: ['e2e4', 'e7e6'] },
  { name: 'Caro-Kann Defense', color: 'black', moves: ['e2e4', 'c7c6'] },
  { name: "King's Indian Defense", color: 'black', moves: ['d2d4', 'g8f6', 'c2c4', 'g7g6'] },
  { name: "Queen's Gambit Declined", color: 'black', moves: ['d2d4', 'd7d5', 'c2c4', 'e7e6'] },
]

// The trees, the cards and sparring go through the player's 8th move: past
// that a club game has mostly left any line a player could prepare
export const DEPTH = 8

const RANK: Record<RepSource, number> = { games: 0, builtin: 1, own: 2, study: 3 }

// A game repeats a position by a different move order; the counters differ,
// the position doesn't
export const posKey = (fen: string) => fen.split(' ').slice(0, 4).join(' ')

export const keyOf = (pos: Chess) => posKey(makeFen(pos.toSetup()))

// Castling as king-takes-rook, the way chessops reads games, so a move from
// the board, a study or the server compares equal
export function norm(pos: Chess, uci: string): string {
  const move = parseUci(uci)
  if (!move) throw new Error(`not a move: ${uci}`)
  return makeUci(normalizeMove(pos, move))
}

export const startsWith = (line: string[], prefix: string[]) => prefix.every((m, i) => line[i] === m)

// The positions on one side along a line, each with the move played there
function sideMoves(line: string[], color: 'white' | 'black', source: RepSource): RepMove[] {
  const pos = Chess.default()
  const out: RepMove[] = []
  for (const uci of line) {
    const move = parseUci(uci)
    if (!move || !pos.isLegal(normalizeMove(pos, move))) break
    if (pos.turn === color) out.push({ fen: keyOf(pos), uci: norm(pos, uci), source })
    pos.play(normalizeMove(pos, move))
  }
  return out
}

// The move the player made most often in each position of their games in an
// opening, when they made it at least twice and it wasn't judged a mistake
// of any size
function gameMoves(games: Game[], o: Opening): RepMove[] {
  const counts = new Map<string, Map<string, number>>()
  for (const g of games) {
    if (g.color !== o.color || !startsWith(g.moves.map(m => m.uci), o.moves)) continue
    const pos = Chess.default()
    for (const m of g.moves.slice(0, 2 * DEPTH)) {
      if (pos.turn === o.color && !m.judg) {
        const at = counts.get(keyOf(pos)) ?? new Map<string, number>()
        at.set(m.uci, (at.get(m.uci) ?? 0) + 1)
        counts.set(keyOf(pos), at)
      }
      pos.play(parseUci(m.uci)!)
    }
  }
  const out: RepMove[] = []
  for (const [fen, at] of counts) {
    const [uci, n] = [...at].sort((a, b) => b[1] - a[1])[0]
    if (n >= 2) out.push({ fen, uci, source: 'games' })
  }
  return out
}

// Every source's moves, best source per position. A study line counts for
// the trained openings it starts with, on that opening's side.
export function repertoireMoves(openings: Opening[], study: string[][], games: Game[], own: RepMove[]): RepMove[] {
  const all = [
    ...openings.flatMap(o => gameMoves(games, o)),
    ...openings.flatMap(o => sideMoves(o.moves, o.color, 'builtin')),
    ...own,
    ...openings.flatMap(o => study.filter(line => startsWith(line, o.moves)).flatMap(line => sideMoves(line, o.color, 'study'))),
  ]
  const best = new Map<string, RepMove>()
  for (const m of all) {
    const old = best.get(m.fen)
    if (!old || RANK[m.source] >= RANK[old.source]) best.set(m.fen, m)
  }
  return [...best.values()]
}

// Rewrites the stored repertoire from its sources, touching only rows that
// change so the sync queue carries just those
export async function rebuildRepertoire(openings: Opening[], study: string[][], games: Game[]): Promise<Map<string, string>> {
  const stored = await db.repertoire.toArray()
  const next = repertoireMoves(openings, study, games, stored.filter(r => r.source === 'own'))
  const old = new Map(stored.map(r => [r.fen, r]))
  const changed = next.filter(m => old.get(m.fen)?.uci !== m.uci || old.get(m.fen)?.source !== m.source)
  const keep = new Set(next.map(m => m.fen))
  await db.repertoire.bulkPut(changed)
  await db.repertoire.bulkDelete(stored.filter(r => !keep.has(r.fen)).map(r => r.fen))
  return new Map(next.map(m => [m.fen, m.uci]))
}

export const fromFen = (fen: string) => Chess.fromSetup(parseFen(fen).unwrap()).unwrap()

export async function addOwnMove(fen: string, uci: string): Promise<void> {
  const pos = fromFen(fen)
  await db.repertoire.put({ fen: keyOf(pos), uci: norm(pos, uci), source: 'own' })
}

// The openings in the player's own games to offer: the three they play most
// with each colour, each named by its family and defined by the line at
// least half of those games share
export function gamesOpenings(games: Game[]): Opening[] {
  const out: Opening[] = []
  for (const color of ['white', 'black'] as const) {
    const mine = games.filter(g => g.color === color && g.site !== 'maia')
    for (const row of openingTable(mine).filter(r => r.family !== 'Unknown' && r.games >= 3).slice(0, 3)) {
      const family = mine.filter(g => familyOf(g) === row.family)
      out.push({ name: row.family, color, moves: sharedLine(family) })
    }
  }
  return out
}

export function sharedLine(games: Game[]): string[] {
  const line: string[] = []
  let on = games
  while (line.length < 10) {
    const counts = new Map<string, number>()
    for (const g of on) {
      const m = g.moves[line.length]?.uci
      if (m) counts.set(m, (counts.get(m) ?? 0) + 1)
    }
    const top = [...counts].sort((a, b) => b[1] - a[1])[0]
    if (!top || top[1] * 2 < games.length) break
    line.push(top[0])
    on = on.filter(g => g.moves[line.length - 1]?.uci === top[0])
  }
  return line
}
