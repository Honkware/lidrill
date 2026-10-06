import { Chess } from 'chessops/chess'
import { makeFen } from 'chessops/fen'
import { parseSan } from 'chessops/san'
import { makeUci } from 'chessops/util'
import { createEmptyCard } from 'ts-fsrs'
import type { Puzzle, PuzzleDashboardSnapshot, PuzzleTag } from '../db'
import { SignInExpired } from '../sync/lichess'
import { lichessJson } from './api'

// Lichess puzzle data behind the puzzle:read scope

interface Results {
  nb: number
  firstWins: number
  performance: number
}

export interface Dashboard {
  days: number
  global: Results
  themes: Record<string, { theme: string; results: Results }>
}

export interface WeakTheme {
  theme: string
  name: string
  nb: number
  performance: number
}

// Phase, length and eval themes say nothing about what to practise
const META_THEMES = new Set([
  'opening', 'middlegame', 'endgame', 'short', 'long', 'veryLong', 'oneMove',
  'advantage', 'crushing', 'equality', 'master', 'masterVsMaster', 'superGM', 'mix', 'playerGames',
])

// Themes at least 100 below the player's own puzzle performance, from at
// least 5 attempts, weakest first
export function weakThemes(d: Pick<Dashboard, 'global' | 'themes'>): WeakTheme[] {
  return Object.entries(d.themes)
    .map(([key, t]) => ({ theme: key, name: t.theme, nb: t.results.nb, performance: t.results.performance }))
    .filter(t => !META_THEMES.has(t.theme) && t.nb >= 5 && t.performance <= d.global.performance - 100)
    .sort((a, b) => a.performance - b.performance)
}

export function snapshot(d: Dashboard, now: Date): PuzzleDashboardSnapshot {
  const monday = new Date(now)
  monday.setUTCHours(0, 0, 0, 0)
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7))
  const pick = (r: Results) => ({ nb: r.nb, firstWins: r.firstWins, performance: r.performance })
  return {
    week: monday.toISOString().slice(0, 10),
    global: pick(d.global),
    themes: Object.fromEntries(Object.entries(d.themes).map(([k, t]) => [k, pick(t.results)])),
  }
}

export const fetchDashboard = (token: string, fetchFn: typeof fetch = fetch, days = 90) =>
  lichessJson<Dashboard>(`https://lichess.org/api/puzzle/dashboard/${days}`, token, fetchFn)

function tagFor(themes: string[]): PuzzleTag {
  if (themes.some(t => t.startsWith('mate') || t.endsWith('Mate'))) return 'mate'
  if (themes.includes('defensiveMove') || themes.includes('equality')) return 'defensive'
  return 'hang'
}

function lichessPuzzle(id: string, fen: string, solution: string[], themes: string[], rating: number, now: Date, intro: Pick<Puzzle, 'before' | 'lastMove'> = {}): Puzzle {
  return {
    ...intro,
    id: `lichess:${id}`,
    gameId: '',
    source: 'lichess',
    themes,
    rating,
    ply: 0,
    fen,
    played: '',
    solution,
    solutionLen: Math.ceil(solution.length / 2),
    type: 'external',
    tag: tagFor(themes),
    swingCp: 0,
    card: createEmptyCard(now),
  }
}

interface Activity {
  date: number
  win: boolean
  puzzle: { id: string; fen: string; solution: string[]; themes: string[]; rating: number; lastMove?: string }
}

// Puzzles the player failed on Lichess and hasn't solved since, newest first.
// The activity FEN is the position the player faces, so solution[0] is theirs.
export function failedPuzzles(activity: Activity[], now: Date, max = 60): Puzzle[] {
  const solved = new Set<string>()
  const out = new Map<string, Puzzle>()
  for (const a of [...activity].sort((x, y) => y.date - x.date)) {
    if (a.win) solved.add(a.puzzle.id)
    else if (!solved.has(a.puzzle.id) && !out.has(a.puzzle.id))
      out.set(a.puzzle.id, lichessPuzzle(a.puzzle.id, a.puzzle.fen, a.puzzle.solution, a.puzzle.themes, a.puzzle.rating, now, { lastMove: a.puzzle.lastMove }))
  }
  return [...out.values()].slice(0, max)
}

export async function fetchActivity(token: string, since: number, fetchFn: typeof fetch = fetch): Promise<Activity[]> {
  const res = await fetchFn(`https://lichess.org/api/puzzle/activity?since=${since}&max=500`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/x-ndjson' },
  })
  if (res.status === 401) throw new SignInExpired()
  if (!res.ok) throw new Error(`puzzle activity HTTP ${res.status}`)
  return (await res.text())
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l) as Activity)
}

interface BatchPuzzle {
  game: { pgn: string }
  puzzle: { id: string; rating: number; solution: string[]; themes: string[] }
}

// Batch puzzles come with the game's moves up to the puzzle instead of a FEN
export function fromBatch(b: BatchPuzzle, now: Date): Puzzle | undefined {
  const pos = Chess.default()
  let before = ''
  let lastMove = ''
  for (const san of b.game.pgn.split(' ').filter(Boolean)) {
    const move = parseSan(pos, san)
    if (!move) return undefined
    before = makeFen(pos.toSetup())
    lastMove = makeUci(move)
    pos.play(move)
  }
  return lichessPuzzle(b.puzzle.id, makeFen(pos.toSetup()), b.puzzle.solution, b.puzzle.themes, b.puzzle.rating, now, { before, lastMove })
}

// New puzzles in one theme the player hasn't seen on Lichess (needs a token)
export async function fetchThemePuzzles(token: string, theme: string, nb: number, fetchFn: typeof fetch = fetch, now = new Date()) {
  const data = await lichessJson<{ puzzles: BatchPuzzle[] }>(
    `https://lichess.org/api/puzzle/batch/${encodeURIComponent(theme)}?nb=${nb}`,
    token,
    fetchFn,
  )
  return data.puzzles.map(b => fromBatch(b, now)).filter((p): p is Puzzle => !!p)
}
