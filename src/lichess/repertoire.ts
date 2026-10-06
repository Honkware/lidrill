import { parsePgn } from 'chessops/pgn'
import { parseSan } from 'chessops/san'
import { Chess } from 'chessops/chess'
import { makeUci } from 'chessops/util'
import type { Game } from '../db'
import { SignInExpired } from '../sync/lichess'

// Repertoire from the player's own Lichess studies.
// Each chapter's mainline, from the standard start, is one line of the
// repertoire; a game "follows" it while its moves match.

export const STUDY_READ_SCOPE = 'study:read'
const LINE_PLIES = 20
const FOLLOW_PLIES = 8 // four moves each

export interface StudyInfo {
  id: string
  name: string
}

async function get(url: string, token: string, accept: string, fetchFn: typeof fetch): Promise<string> {
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}`, Accept: accept } })
  if (res.status === 401) throw new SignInExpired()
  if (!res.ok) throw new Error(`Lichess said HTTP ${res.status} for your studies.`)
  return res.text()
}

export async function listStudies(username: string, token: string, fetchFn: typeof fetch = fetch): Promise<StudyInfo[]> {
  const text = await get(`https://lichess.org/api/study/by/${encodeURIComponent(username)}`, token, 'application/x-ndjson', fetchFn)
  return text
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l) as StudyInfo)
    .map(s => ({ id: s.id, name: s.name }))
}

// Chapters set up from a custom position are skipped: games never reach them
// move by move from the start.
export function studyLines(pgn: string): string[][] {
  const lines: string[][] = []
  for (const game of parsePgn(pgn)) {
    if (game.headers.get('FEN') && game.headers.get('SetUp') === '1') continue
    const pos = Chess.default()
    const line: string[] = []
    for (const node of game.moves.mainline()) {
      const move = parseSan(pos, node.san)
      if (!move || line.length >= LINE_PLIES) break
      line.push(makeUci(move))
      pos.play(move)
    }
    if (line.length) lines.push(line)
  }
  return lines
}

export const fetchStudyLines = async (id: string, token: string, fetchFn: typeof fetch = fetch) =>
  studyLines(await get(`https://lichess.org/api/study/${id}.pgn`, token, 'application/x-chess-pgn', fetchFn))

// The game stays on one of the lines for 4 moves (or the whole line if
// it's shorter)
export function followsLines(game: Game, lines: string[][]): boolean {
  return lines.some(line => {
    let n = 0
    while (n < line.length && n < game.moves.length && game.moves[n].uci === line[n]) n++
    return n >= Math.min(FOLLOW_PLIES, line.length)
  })
}

export function studyCompliance(games: Game[], lines: string[][]): number | undefined {
  const recent = [...games].sort((a, b) => b.playedAt - a.playedAt).slice(0, 30)
  if (!recent.length || !lines.length) return undefined
  return recent.filter(g => followsLines(g, lines)).length / recent.length
}

export interface Deviation {
  ply: number // the first move off the study
  expected: string // UCI the study plays there
  byPlayer: boolean
}

// Where the game left the study line it followed longest, if it left before
// the line ran out
export function deviation(game: Game, lines: string[][]): Deviation | undefined {
  let best: { line: string[]; n: number } | undefined
  for (const line of lines) {
    let n = 0
    while (n < line.length && n < game.moves.length && game.moves[n].uci === line[n]) n++
    if (!best || n > best.n) best = { line, n }
  }
  if (!best || best.n === 0 || best.n >= best.line.length || best.n >= game.moves.length) return undefined
  const mover = best.n % 2 === 0 ? 'white' : 'black'
  return { ply: best.n + 1, expected: best.line[best.n], byPlayer: mover === game.color }
}
