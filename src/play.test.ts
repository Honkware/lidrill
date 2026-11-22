import { describe, expect, it } from 'vitest'
import { PlayRun } from './play'

// A game against a scripted opponent: the fetch stands in for the Maia
// endpoint and answers from a list, so no board and no server are needed.

function scripted(replies: string[]) {
  const asked: string[][] = []
  const fetchFn = (async (_url: string, init: RequestInit) => {
    asked.push((JSON.parse(String(init.body)) as { moves: string[] }).moves)
    const move = replies.shift()
    return move ? new Response(JSON.stringify({ move })) : new Response(JSON.stringify({ error: 'Maia isn’t available right now.' }), { status: 502 })
  }) as typeof fetch
  return { asked, fetchFn }
}

async function play(run: PlayRun, moves: string[]) {
  for (const m of moves) {
    await expect.poll(() => run.state).toBe('your-move')
    void run.move(m)
  }
  await expect.poll(() => run.state).not.toBe('thinking')
}

const opts = { level: 1500, color: 'white' as const, rating: 1450 }

describe('PlayRun', () => {
  it('sends the whole game so far and plays the reply', async () => {
    const { asked, fetchFn } = scripted(['e7e5', 'b8c6'])
    const run = new PlayRun(opts, () => {}, () => {}, fetchFn)
    await play(run, ['e2e4', 'g1f3'])
    expect(asked).toEqual([['e2e4'], ['e2e4', 'e7e5', 'g1f3']])
    expect(run.moves.map(m => m.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6'])
    expect(run.last).toBe('Nc6')
  })

  it('lets Maia move first when the player is black', async () => {
    const { asked, fetchFn } = scripted(['d2d4'])
    const run = new PlayRun({ ...opts, color: 'black' }, () => {}, () => {}, fetchFn)
    await expect.poll(() => run.state).toBe('your-move')
    expect(asked).toEqual([[]])
  })

  it('ends on checkmate and stores the game like an imported one', async () => {
    const { fetchFn } = scripted(['e7e5', 'b8c6', 'g8f6'])
    let ended: PlayRun | undefined
    const run = new PlayRun(opts, () => {}, r => (ended = r), fetchFn)
    await play(run, ['e2e4', 'd1h5', 'f1c4', 'h5f7'])
    expect(ended).toBe(run)
    expect([run.state, run.result, run.ending]).toEqual(['over', 'win', 'Checkmate'])
    const game = run.toGame(1700000000000)
    expect(game).toMatchObject({ id: 'maia:1700000000000', site: 'maia', result: 'win', color: 'white', rating: 1450, opponent: 'Maia', opponentRating: 1500 })
    expect(game.pgn).toBe('1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0')
  })

  it('stores castling as king takes rook whichever way Maia writes it', async () => {
    const { fetchFn } = scripted(['e7e5', 'b8c6', 'f8c5', 'g8f6', 'e8g8'])
    const run = new PlayRun(opts, () => {}, () => {}, fetchFn)
    await play(run, ['e2e4', 'g1f3', 'f1c4', 'e1g1', 'd2d3'])
    expect(run.moves.filter(m => m.san === 'O-O').map(m => m.uci)).toEqual(['e1h1', 'e8h8'])
  })

  it('calls a draw when a position comes up for the third time', async () => {
    const { fetchFn } = scripted(['g8f6', 'f6g8', 'g8f6', 'f6g8'])
    const run = new PlayRun(opts, () => {}, () => {}, fetchFn)
    await play(run, ['g1f3', 'f3g1', 'g1f3', 'f3g1'])
    expect([run.result, run.ending]).toEqual(['draw', 'Draw'])
  })

  it('keeps the game when Maia cannot be reached and carries on after a retry', async () => {
    const { asked, fetchFn } = scripted([])
    const run = new PlayRun(opts, () => {}, () => {}, fetchFn)
    await play(run, ['e2e4'])
    expect([run.state, run.error]).toEqual(['failed', 'Maia isn’t available right now.'])
    await run.move('d2d4')
    expect(run.moves).toHaveLength(1)
    run.retry()
    await expect.poll(() => run.state).toBe('failed')
    expect(asked).toEqual([['e2e4'], ['e2e4']])
  })

  it('refuses a reply that is not legal instead of playing it', async () => {
    const { fetchFn } = scripted(['e7e4'])
    const run = new PlayRun(opts, () => {}, () => {}, fetchFn)
    await play(run, ['e2e4'])
    expect(run.state).toBe('failed')
    expect(run.moves).toHaveLength(1)
  })

  it('continues from a position out of an own game and counts only the new moves', async () => {
    const start = { gameId: 'lichess:g', color: 'black' as const, opening: 'Sicilian Defense', moves: [{ san: 'e4', uci: 'e2e4' }] }
    const { asked, fetchFn } = scripted(['g1f3'])
    const run = new PlayRun({ ...opts, color: 'black', start }, () => {}, () => {}, fetchFn)
    await play(run, ['c7c5'])
    expect(asked).toEqual([['e2e4', 'c7c5']])
    expect(run.playerMoves).toBe(1)
    run.resign()
    expect([run.result, run.ending, run.toGame(1).opening]).toEqual(['loss', 'Resigned', 'Sicilian Defense'])
  })
})
