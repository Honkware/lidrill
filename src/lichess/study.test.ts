import { parsePgn, startingPosition } from 'chessops/pgn'
import { parseSan } from 'chessops/san'
import { createEmptyCard } from 'ts-fsrs'
import { describe, expect, it } from 'vitest'
import type { Game, Puzzle } from '../db'
import { chapterPgn, sendToStudy } from './study'

const game = { id: 'lichess:abc', url: 'https://lichess.org/abc', opening: 'Italian Game', opponent: 'someone', playedAt: Date.UTC(2026, 9, 5), color: 'black' } as Game
// Legal's mate position after 5...Bxd1? with white to move: 6. Bxf7+ Ke7 7. Nd5#
const stop: Puzzle = {
  id: 'lichess:abc:11', gameId: game.id, ply: 11, fen: 'rn1qkbnr/ppp2pp1/3p3p/4N3/2B1P3/2N5/PPPP1PPP/R1BbK2R w KQkq - 0 6',
  played: 'e1d1', solution: ['c4f7', 'e8e7', 'c3d5'], solutionLen: 2, type: 'missed-win', tag: 'mate', swingCp: 900, card: createEmptyCard(),
}

describe('study export', () => {
  it('writes a chapter Lichess can replay from the FEN', () => {
    const pgn = chapterPgn(game, stop, 0)
    const [g] = parsePgn(pgn)
    expect(g.headers.get('Event')).toBe('Turning point 1: Italian Game, move 6')
    const pos = startingPosition(g.headers).unwrap()
    const sans = [...g.moves.mainline()].map(n => n.san)
    expect(sans).toEqual(['Bxf7+', 'Ke7', 'Nd5#'])
    for (const san of sans) pos.play(parseSan(pos, san)!)
    expect(pos.isCheckmate()).toBe(true)
    expect(pgn).toContain('In the game you played Kxd1')
  })

  it('creates a private study and imports the chapters in hide-moves mode', async () => {
    const calls: { url: string; body: URLSearchParams }[] = []
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as URLSearchParams })
      return Response.json(url.endsWith('/api/study') ? { id: 'S1' } : { chapters: [] })
    }) as typeof fetch
    expect(await sendToStudy(game, [stop], 'lio_x', fetchFn)).toBe('https://lichess.org/study/S1')
    expect(calls[0].body.get('visibility')).toBe('private')
    expect(calls[0].body.get('name')).toBe('lidrill: vs someone 2026-10-05')
    expect(calls[1].url).toBe('https://lichess.org/api/study/S1/import-pgn')
    expect(calls[1].body.get('mode')).toBe('conceal')
    expect(calls[1].body.get('orientation')).toBe('black')
  })
})
