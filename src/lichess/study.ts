import { Chess } from 'chessops/chess'
import { parseFen } from 'chessops/fen'
import { makeSan } from 'chessops/san'
import { parseUci } from 'chessops/util'
import type { Game, Puzzle } from '../db'
import { SignInExpired } from '../sync/lichess'

// "Send to Lichess study": a game's turning points as
// a private study, one chapter per stop, in "hide next moves" mode so the
// Lichess app quizzes the player too.

export const STUDY_SCOPE = 'study:write'

function line(fen: string, ucis: string[]): string {
  const pos = Chess.fromSetup(parseFen(fen).unwrap()).unwrap()
  const parts: string[] = []
  for (const [i, uci] of ucis.entries()) {
    const move = parseUci(uci)
    if (!move || !pos.isLegal(move)) break
    const no = pos.fullmoves
    if (pos.turn === 'white') parts.push(`${no}.`)
    else if (i === 0) parts.push(`${no}...`)
    parts.push(makeSan(pos, move))
    pos.play(move)
  }
  return parts.join(' ')
}

export function chapterPgn(game: Game, p: Puzzle, index: number): string {
  const moveNo = Math.ceil(p.ply / 2)
  const played = line(p.fen, [p.played])
  const tags = [
    ['Event', `Turning point ${index + 1}: ${game.opening || 'your game'}, move ${moveNo}`],
    ['Site', game.url],
    ['FEN', p.fen],
    ['SetUp', '1'],
  ]
  const comment = `{ In the game you played ${played.replace(/^\d+\.+ /, '')}, about ${(p.swingCp / 100).toFixed(1)} pawns worse. }`
  return `${tags.map(([k, v]) => `[${k} "${v.replace(/"/g, "'")}"]`).join('\n')}\n\n${comment} ${line(p.fen, p.solution)} *`
}

async function post(url: string, token: string, body: Record<string, string>, fetchFn: typeof fetch) {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })
  if (res.status === 401) throw new SignInExpired()
  if (res.status === 403) throw new Error('Lichess refused to create the study: no study:write permission.')
  if (!res.ok) throw new Error(`Lichess returned HTTP ${res.status} when creating the study.`)
  return res.json() as Promise<{ id?: string }>
}

// Returns the new study's URL
export async function sendToStudy(game: Game, stops: Puzzle[], token: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const date = new Date(game.playedAt).toISOString().slice(0, 10)
  const name = `lidrill: ${game.opponent ? `vs ${game.opponent}` : 'game'} ${date}`.slice(0, 100)
  const study = await post(
    'https://lichess.org/api/study',
    token,
    { name, visibility: 'private', computer: 'owner', explorer: 'owner', cloneable: 'owner', shareable: 'owner', chat: 'nobody' },
    fetchFn,
  )
  if (!study.id) throw new Error('Lichess returned no id for the new study.')
  const pgn = stops.slice(0, 63).map((p, i) => chapterPgn(game, p, i)).join('\n\n\n')
  await post(`https://lichess.org/api/study/${study.id}/import-pgn`, token, { pgn, mode: 'conceal', orientation: game.color }, fetchFn)
  return `https://lichess.org/study/${study.id}`
}
