import { createEmptyCard } from 'ts-fsrs'
import { describe, expect, it } from 'vitest'
import { pickReply, weakness } from './spar'

// Sparring leans towards what the player knows least but only ever plays a
// reply Maia gives at least the tree's 5%

// A seeded generator, so a thousand picks are the same every run
function seeded(seed: number) {
  let s = seed
  return () => ((s = (s * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32)
}

describe('pickReply', () => {
  const replies = [
    { uci: 'e7e5', p: 0.85 },
    { uci: 'c7c5', p: 0.1 },
    { uci: 'a7a6', p: 0.04 },
    { uci: 'h7h5', p: 0.01 },
  ]

  it('never picks a reply under the cut, even one the player has never seen', () => {
    const rng = seeded(1)
    const picks = Array.from({ length: 1000 }, () => pickReply(replies, uci => (uci === 'e7e5' ? 0 : 1), rng))
    expect(picks.filter(u => u === 'a7a6' || u === 'h7h5')).toEqual([])
  })

  it('plays an unknown reply more often than Maia would', () => {
    const rng = seeded(2)
    const picks = Array.from({ length: 1000 }, () => pickReply(replies, uci => (uci === 'c7c5' ? 1 : 0), rng))
    // 0.1 × 4 against 0.85: about 32% instead of 10%
    const share = picks.filter(u => u === 'c7c5').length / 1000
    expect(share).toBeGreaterThan(0.25)
    expect(share).toBeLessThan(0.4)
  })

  it('keeps the likeliest reply when every reply is under the cut', () => {
    const flat = Array.from({ length: 25 }, (_, i) => ({ uci: `m${i}`, p: 0.04 }))
    expect(pickReply(flat, () => 1, seeded(3))).toBe('m0')
  })
})

describe('weakness', () => {
  it('is 1 for an unseen position and falls as the card grows stable', () => {
    const seen = { ...createEmptyCard(), reps: 3, stability: 9 }
    expect([weakness(undefined), weakness(createEmptyCard()), weakness(seen)]).toEqual([1, 1, 0.1])
  })
})
