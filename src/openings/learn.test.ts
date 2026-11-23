import { describe, expect, it } from 'vitest'
import type { Opening } from '../db'
import { learnLine } from './learn'
import type { Reply } from './policy'
import { keyOf } from './repertoire'
import { replay } from './session'
import { buildTree } from './tree'

// The order a line is learned in, on a small tree: the opening runs to
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
