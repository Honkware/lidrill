import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, type Opening } from '../db'
import { isLearned, saveTreeCards } from './cards'
import { clearLearn, LearnRun, learnLine, learnSet, readLearn } from './learn'
import type { Reply } from './policy'
import { keyOf } from './repertoire'
import { replay } from './session'
import { buildTree } from './tree'

// The order a line is learned in, and the practice that follows it, on a
// small tree: the opening runs to
// 6. O-O in the Giuoco Pianissimo and Black's 6th move is 6...a6 (60%) or
// 6...O-O (40%), each with one reply after White's 7th.

const opening: Opening = {
  name: 'Italian Game',
  color: 'white',
  moves: 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6 d2d3 d7d6 e1h1'.split(' '),
}
const o = opening.moves.join(' ')

const replies: Record<string, Reply[]> = {
  [o]: [
    { uci: 'a7a6', p: 0.6 },
    { uci: 'e8h8', p: 0.4 },
  ],
  [`${o} a7a6 a2a4`]: [{ uci: 'e8h8', p: 1 }],
  [`${o} e8h8 f1e1`]: [{ uci: 'a7a6', p: 1 }],
}
const policy = async (moves: string[]) => replies[moves.join(' ')]

const key = (ucis: string) => keyOf(replay(ucis.split(' ')))
const rep = new Map([
  [key(`${o} a7a6`), 'a2a4'],
  [key(`${o} a7a6 a2a4 e8h8`), 'f1e1'],
  [key(`${o} e8h8`), 'f1e1'],
  [key(`${o} e8h8 f1e1 a7a6`), 'a2a4'],
])

// The line past the opening's moves, with the given positions learned
const lineFor = async (learned: string[]) => {
  const { nodes } = await buildTree(opening, rep, policy)
  return learnLine(opening, nodes, new Set(learned.map(key))).slice(opening.moves.length).join(' ')
}

describe('learnLine', () => {
  it("starts from move 1 and follows the likeliest reply down to the line's last new position", async () => {
    const { nodes } = await buildTree(opening, rep, policy)
    expect(learnLine(opening, nodes, new Set())).toEqual([...opening.moves, 'a7a6', 'a2a4', 'e8h8', 'f1e1'])
  })

  it('takes a less likely reply once the likeliest has nothing new below it', async () => {
    expect(await lineFor([`${o} a7a6`, `${o} a7a6 a2a4 e8h8`])).toBe('e8h8 f1e1 a7a6 a2a4')
  })

  it('goes through a learned position to reach a new one, and stops after the last new one', async () => {
    expect(await lineFor([`${o} a7a6`, `${o} e8h8 f1e1 a7a6`])).toBe('a7a6 a2a4 e8h8 f1e1')
    expect(await lineFor([`${o} a7a6`, `${o} a7a6 a2a4 e8h8`, `${o} e8h8 f1e1 a7a6`])).toBe('e8h8 f1e1')
  })

  it('is empty once every position is learned', async () => {
    expect(await lineFor([`${o} a7a6`, `${o} a7a6 a2a4 e8h8`, `${o} e8h8`, `${o} e8h8 f1e1 a7a6`])).toBe('')
  })
})

describe('learnSet', () => {
  // Each of the two lines has two new positions
  const setFor = async (room: number) => {
    const { nodes } = await buildTree(opening, rep, policy)
    const set = learnSet(opening, nodes, new Set(), room)
    return { lines: set.lines.map(l => l.slice(opening.moves.length).join(' ')), fresh: set.fresh }
  }

  it('takes whole lines in learning order while their new positions fit', async () => {
    const set = await setFor(10)
    expect(set.lines).toEqual(['a7a6 a2a4 e8h8 f1e1', 'e8h8 f1e1 a7a6 a2a4'])
    expect(set.fresh).toEqual([`${o} a7a6`, `${o} a7a6 a2a4 e8h8`, `${o} e8h8`, `${o} e8h8 f1e1 a7a6`].map(key))
  })

  it('leaves a line for another day rather than split it', async () => {
    expect((await setFor(3)).lines).toEqual(['a7a6 a2a4 e8h8 f1e1'])
  })

  it('cuts the first line short when it alone has more new positions than the room', async () => {
    expect(await setFor(1)).toEqual({ lines: ['a7a6 a2a4'], fresh: [key(`${o} a7a6`)] })
    expect(await setFor(0)).toEqual({ lines: [], fresh: [] })
  })
})

describe('LearnRun', () => {
  beforeEach(async () => {
    await db.openingCards.clear()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => vi.useRealTimers())

  // The first line cut after its first new position, 6...a6 7. a4
  const run = async () => {
    const { nodes } = await buildTree(opening, rep, policy)
    await saveTreeCards(nodes, opening.name)
    const r = new LearnRun(opening, learnSet(opening, nodes, new Set(), 1), new Set(), () => {})
    r.begin()
    return r
  }
  // White's moves from move 1, with a wrong try first at ply wrongAt
  const playLine = async (r: LearnRun, wrongAt?: number) => {
    for (const [i, m] of r.line.entries()) {
      if (i % 2) {
        await vi.advanceTimersByTimeAsync(500)
        continue
      }
      if (i === wrongAt) await r.play.move('h2h3')
      await r.play.move(m)
    }
  }
  const fresh = async () => (await db.openingCards.get(key(`${o} a7a6`)))!

  it('shows the line, then practises it from move 1, and only the practice grades the new position', async () => {
    const r = await run()
    expect(r.play.turn).toBe('show')
    await playLine(r, 12)
    expect([r.state, r.marks, isLearned(await fresh())]).toEqual(['shown', [undefined], false])
    r.practise()
    expect([r.pass, r.play.ply, r.play.turn]).toEqual(['practice', 0, 'ask'])
    await playLine(r)
    expect([r.state, r.marks, isLearned(await fresh())]).toEqual(['line-done', ['good'], true])
    r.nextLine()
    expect(r.state).toBe('done')
  })

  it('keeps a set that was left, and goes on at the practice of a line already shown', async () => {
    clearLearn()
    const { nodes } = await buildTree(opening, rep, policy)
    await saveTreeCards(nodes, opening.name)
    // both lines, two new positions each
    const set = learnSet(opening, nodes, new Set(), 4)
    expect(set.lines).toHaveLength(2)
    const r = new LearnRun(opening, set, new Set(), () => {})
    r.begin()
    expect(readLearn('white:Italian Game')).toBeUndefined()
    await playLine(r)
    const shown = readLearn('white:Italian Game')!
    expect([shown.index, shown.shown]).toEqual([0, true])

    const again = new LearnRun(opening, shown, new Set(), () => {}, shown)
    again.begin()
    expect([again.pass, again.play.turn]).toEqual(['practice', 'ask'])
    await playLine(again)
    // the first line is done, so what is kept is the second, not yet shown
    const next = readLearn('white:Italian Game')!
    expect([next.index, next.shown, next.marks[0]]).toEqual([1, false, 'good'])
    // another opening, or another day, starts a new set
    expect(readLearn('black:Sicilian Defense')).toBeUndefined()
    expect(readLearn('white:Italian Game', 'Thu Jan 01 2026')).toBeUndefined()

    const last = new LearnRun(opening, next, new Set(), () => {}, next)
    last.begin()
    await playLine(last)
    last.practise()
    await playLine(last)
    expect(readLearn('white:Italian Game')).toBeUndefined()
  })

  it('takes the first grade from how the move was found in practice', async () => {
    const r = await run()
    await playLine(r)
    r.practise()
    await playLine(r, 12)
    const c = await fresh()
    expect([r.marks, c.card.reps, r.misses]).toEqual([['warn'], 1, []])
    expect(c.learnedAt).toBeDefined()
  })
})
