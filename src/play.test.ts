import { Chess } from 'chessops/chess'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlayRun, readChoices, readGame, writeChoices } from './play'
import { computeBand } from './profile'

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

const opts = { level: 1500, color: 'white' as const, rating: 1450, pace: 'instant' as const }

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
    const start = { gameId: 'lichess:g', color: 'black' as const, opening: 'Sicilian Defense', playedAt: 1, moves: [{ san: 'e4', uci: 'e2e4' }] }
    const { asked, fetchFn } = scripted(['g1f3'])
    const run = new PlayRun({ ...opts, color: 'black', start }, () => {}, () => {}, fetchFn)
    await play(run, ['c7c5'])
    expect(asked).toEqual([['e2e4', 'c7c5']])
    expect(run.playerMoves).toBe(1)
    run.resign()
    run.resign()
    expect([run.result, run.ending, run.toGame(1).opening]).toEqual(['loss', 'Resigned', 'Sicilian Defense'])
  })

  it('resigns on the second tap and not the first', async () => {
    const { fetchFn } = scripted(['e7e5', 'b8c6'])
    const run = new PlayRun(opts, () => {}, () => {}, fetchFn)
    run.resign()
    expect([run.state, run.resigning]).toEqual(['your-move', true])
    run.cancelResign()
    run.resign()
    await play(run, ['e2e4'])
    expect(run.resigning).toBe(false)
    run.resign()
    run.resign()
    expect([run.state, run.result, run.ending]).toEqual(['over', 'loss', 'Resigned'])
  })

  it('waits for the promotion piece and plays the one chosen', async () => {
    const line = ['a2a4', 'h7h5', 'a4a5', 'h5h4', 'a5a6', 'h4h3', 'a6b7', 'h3g2'].map(uci => ({ san: '', uci }))
    const { asked, fetchFn } = scripted(['g2h1q'])
    const run = new PlayRun({ ...opts, start: { gameId: 'lichess:g', color: 'white', opening: '', playedAt: 1, moves: line } }, () => {}, () => {}, fetchFn)
    await run.move('b7a8')
    expect([run.promoting, run.moves.length, asked.length]).toEqual(['b7a8', 8, 0])
    await run.promote('n')
    expect(run.moves.slice(8)).toEqual([
      { san: 'bxa8=N', uci: 'b7a8n' },
      { san: 'gxh1=Q', uci: 'g2h1q' },
    ])
    expect(run.promoting).toBeUndefined()
  })

  it('steps back through the game read-only and refuses a move until it is back at the end', async () => {
    const { asked, fetchFn } = scripted(['e7e5', 'b8c6'])
    const run = new PlayRun(opts, () => {}, () => {}, fetchFn)
    await play(run, ['e2e4'])
    expect([run.viewPly, run.live]).toEqual([2, true])
    run.go(1)
    run.go(-3)
    expect([run.viewPly, run.live]).toEqual([0, false])
    await run.move('g1f3')
    expect(run.moves).toHaveLength(2)
    run.go(99)
    await play(run, ['g1f3'])
    expect(asked).toEqual([['e2e4'], ['e2e4', 'e7e5', 'g1f3']])
  })

  it('returns to the latest position when Maia moves', async () => {
    let answer: (r: Response) => void = () => {}
    const fetchFn = (() => new Promise<Response>(r => (answer = r))) as typeof fetch
    const run = new PlayRun(opts, () => {}, () => {}, fetchFn)
    void run.move('e2e4')
    run.go(0)
    answer(new Response(JSON.stringify({ move: 'e7e5' })))
    await expect.poll(() => run.state).toBe('your-move')
    expect([run.viewPly, run.live]).toEqual([2, true])
  })
})

// The clocks read an injected time, moved together with the fake timers
// that drive the redraw interval and the wait for a human-paced move
describe('PlayRun clocks', () => {
  let t = 0
  const now = () => t
  const pass = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(0) // whatever was waiting on a reply reads the time first
    t += ms
    await vi.advanceTimersByTimeAsync(ms)
  }
  const ok = (body: object) => ({ ok: true, json: async () => body }) as Response
  const timed = { ...opts, clock: { base: 300, inc: 3 } }
  const start = { gameId: 'lichess:g', color: 'black' as const, opening: '', playedAt: 1, moves: [{ san: 'e4', uci: 'e2e4' }] }

  // Answers from a list after `took` ms, failing on a null or an empty list
  function maia(replies: (object | null)[], took = 0) {
    const sent: { clock?: unknown }[] = []
    const fetchFn = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)))
      t += took
      const r = replies.shift()
      return r ? ok(r) : ({ ok: false, json: async () => ({ error: 'Maia isn’t available right now.' }) } as Response)
    }) as typeof fetch
    return { sent, fetchFn }
  }

  beforeEach(() => {
    t = 0
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('starts no clock until both sides have made their first move', async () => {
    const { fetchFn } = maia([{ move: 'e7e5' }])
    const run = new PlayRun(timed, () => {}, () => {}, fetchFn, now)
    await pass(5000)
    expect(run.running).toBeUndefined()
    await play(run, ['e2e4'])
    expect(run.running).toBe('white')
    await pass(4000)
    expect([run.clock('white'), run.clock('black')]).toEqual([296000, 300000])
  })

  it('adds the increment after each move once the clocks run and stores the clocks with the game', async () => {
    const { fetchFn } = maia([{ move: 'e7e5' }, { move: 'g8f6' }], 1000)
    const run = new PlayRun(timed, () => {}, () => {}, fetchFn, now)
    await play(run, ['e2e4'])
    await pass(4000)
    await play(run, ['g1f3'])
    expect([run.clock('white'), run.clock('black')]).toEqual([299000, 302000])
    run.resign()
    run.resign()
    expect(run.toGame(1)).toMatchObject({ speed: '5+3', termination: 'resigned', clocks: [30000, 30000, 29900, 30200] })
  })

  it('loses on time, and draws instead when Maia has nothing left to mate with', async () => {
    const run = new PlayRun({ ...timed, color: 'black', start }, () => {}, () => {}, maia([]).fetchFn, now)
    expect(run.running).toBe('black')
    await pass(300000)
    expect([run.state, run.result, run.ending]).toEqual(['over', 'loss', 'Time out'])
    expect(run.toGame(1)).toMatchObject({ termination: 'time out', clocks: undefined })

    const bare = new PlayRun({ ...timed, color: 'black', start }, () => {}, () => {}, maia([]).fetchFn, now)
    vi.spyOn(Chess.prototype, 'hasInsufficientMaterial').mockImplementation(color => color === 'white')
    await pass(300000)
    expect([bare.result, bare.ending]).toEqual(['draw', 'Time out'])
  })

  it('wins when Maia runs out of time', async () => {
    const fetchFn = (() => new Promise<Response>(() => {})) as typeof fetch
    const run = new PlayRun({ ...timed, color: 'black', start }, () => {}, () => {}, fetchFn, now)
    void run.move('c7c5')
    await pass(300000)
    expect([run.state, run.result, run.ending]).toEqual(['over', 'win', 'Time out'])
  })

  it('shows a human-paced move once the think time has passed, counting the request', async () => {
    const { fetchFn } = maia([{ move: 'e7e5', think: 5 }], 2000)
    const run = new PlayRun({ ...opts, pace: 'human' }, () => {}, () => {}, fetchFn, now)
    void run.move('e2e4')
    await pass(2900)
    expect(run.state).toBe('thinking')
    await pass(100)
    expect([run.state, run.moves.length]).toEqual(['your-move', 2])
  })

  it('shows an instant move as soon as it arrives', async () => {
    const { fetchFn } = maia([{ move: 'e7e5', think: 5 }])
    const run = new PlayRun(opts, () => {}, () => {}, fetchFn, now)
    await play(run, ['e2e4'])
    expect(run.moves).toHaveLength(2)
  })

  it('leaves the move unplayed when the player resigns while it waits', async () => {
    const { fetchFn } = maia([{ move: 'e7e5', think: 5 }])
    const run = new PlayRun({ ...opts, pace: 'human' }, () => {}, () => {}, fetchFn, now)
    void run.move('e2e4')
    await pass(1000)
    run.resign()
    run.resign()
    await pass(5000)
    expect([run.result, run.moves.length]).toEqual(['loss', 1])
  })

  it('pauses both clocks while a failed request waits for a retry', async () => {
    const { fetchFn } = maia([null, { move: 'g1f3' }])
    const run = new PlayRun({ ...timed, color: 'black', start }, () => {}, () => {}, fetchFn, now)
    await play(run, ['c7c5'])
    await pass(400000)
    expect([run.state, run.running, run.clock('white'), run.clock('black')]).toEqual(['failed', undefined, 300000, 303000])
    run.retry()
    expect(run.running).toBe('white')
    await expect.poll(() => run.state).toBe('your-move')
  })

  it('sends Maia\'s own time left with each request, and no clock in an untimed game', async () => {
    const { sent, fetchFn } = maia([{ move: 'e7e5' }, { move: 'b8c6' }, { move: 'g8f6' }], 2000)
    const run = new PlayRun(timed, () => {}, () => {}, fetchFn, now)
    await play(run, ['e2e4', 'g1f3', 'd2d4'])
    expect(sent.map(b => b.clock)).toEqual([
      { base: 300, inc: 3, left: 300 },
      { base: 300, inc: 3, left: 300 },
      { base: 300, inc: 3, left: 301 },
    ])
    const untimed = maia([{ move: 'e7e5' }])
    await play(new PlayRun(opts, () => {}, () => {}, untimed.fetchFn, now), ['e2e4'])
    expect(untimed.sent[0]).not.toHaveProperty('clock')
  })

  it('keeps a timed game out of the band worked out from rated games', () => {
    const run = new PlayRun({ ...timed, rating: 2000 }, () => {}, () => {}, maia([]).fetchFn, now)
    run.resign()
    run.resign()
    const game = run.toGame(1)
    expect(computeBand([{ ...game, speed: 'blitz', rating: 1200 }, game])).toBe('club')
  })
})

// A reload is a destroyed run and a new one built from what was saved
describe('PlayRun after a reload', () => {
  let t = 0
  const now = () => t
  const ok = (body: object) => ({ ok: true, json: async () => body }) as Response
  const timed = { ...opts, clock: { base: 300, inc: 3 } }
  const maia = (replies: string[]) => {
    const asked: string[][] = []
    const fetchFn = (async (_url: string, init: RequestInit) => {
      asked.push((JSON.parse(String(init.body)) as { moves: string[] }).moves)
      const move = replies.shift()
      return move ? ok({ move }) : new Promise<Response>(() => {})
    }) as typeof fetch
    return { asked, fetchFn }
  }
  const reload = (run: PlayRun, fetchFn: typeof fetch, onEnd: (r: PlayRun) => void = () => {}) => {
    run.destroy()
    const saved = readGame()!
    return new PlayRun(saved.opts, () => {}, onEnd, fetchFn, now, saved)
  }

  beforeEach(() => {
    t = 0
    localStorage.clear()
  })

  it('carries on with the same moves, colour, level and clocks', async () => {
    const run = new PlayRun({ ...timed, color: 'black', level: 1700 }, () => {}, () => {}, maia(['e2e4', 'g1f3', 'f1c4']).fetchFn, now)
    await play(run, ['e7e5'])
    t += 2000
    await play(run, ['b8c6'])
    const after = reload(run, maia([]).fetchFn)
    expect(after.moves.map(m => m.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'])
    expect([after.opts.color, after.opts.level]).toEqual(['black', 1700])
    expect([after.clock('white'), after.clock('black')]).toEqual([306000, 301000])
    expect(after.running).toBe('black')
    after.destroy()
  })

  it('charges the time away to the side to move', async () => {
    const run = new PlayRun(timed, () => {}, () => {}, maia(['e7e5']).fetchFn, now)
    await play(run, ['e2e4'])
    t += 60000
    const after = reload(run, maia([]).fetchFn)
    expect([after.clock('white'), after.clock('black')]).toEqual([240000, 300000])
    after.destroy()
  })

  it('ends on time straight away when the flag fell while the page was away', async () => {
    const run = new PlayRun(timed, () => {}, () => {}, maia(['e7e5']).fetchFn, now)
    await play(run, ['e2e4'])
    t += 400000
    let ended: PlayRun | undefined
    const after = reload(run, maia([]).fetchFn, r => (ended = r))
    expect(ended).toBe(after)
    expect([after.state, after.result, after.ending]).toEqual(['over', 'loss', 'Time out'])
    expect(readGame()).toBeUndefined()
  })

  it('asks Maia for its move again when the page went away while it thought', async () => {
    const run = new PlayRun(opts, () => {}, () => {}, maia([]).fetchFn, now)
    void run.move('e2e4')
    await expect.poll(() => run.state).toBe('thinking')
    const { asked, fetchFn } = maia(['e7e5'])
    const after = reload(run, fetchFn)
    await expect.poll(() => after.state).toBe('your-move')
    expect(asked).toEqual([['e2e4']])
    expect(after.moves.map(m => m.san)).toEqual(['e4', 'e5'])
  })

  it('leaves nothing saved once the game is over', async () => {
    const run = new PlayRun(opts, () => {}, () => {}, maia(['e7e5', 'b8c6', 'g8f6']).fetchFn, now)
    await play(run, ['e2e4', 'd1h5', 'f1c4'])
    expect(readGame()?.moves).toHaveLength(6)
    await play(run, ['h5f7'])
    expect(run.ending).toBe('Checkmate')
    expect(readGame()).toBeUndefined()
  })

  it('drops a saved game that no longer parses', () => {
    localStorage.setItem('lidrill.maiaGame', JSON.stringify({ moves: [{ san: 'e4', uci: 'e2e4' }], at: 1 }))
    expect(readGame()).toBeUndefined()
    localStorage.setItem('lidrill.maiaGame', '{"opts":')
    expect(readGame()).toBeUndefined()
    expect(localStorage.getItem('lidrill.maiaGame')).toBeNull()
  })
})

describe('readChoices', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reads back the last choices, as after a reload', () => {
    writeChoices({ time: '3+2', color: 'black', pace: 'instant' })
    expect(readChoices()).toEqual({ time: '3+2', color: 'black', pace: 'instant' })
  })

  it('falls back to 10+0, a random colour and human pace when storage is off', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    writeChoices({ time: '3+2', color: 'black', pace: 'instant' })
    expect(readChoices()).toEqual({ time: '10+0', color: 'random', pace: 'human' })
  })
})
