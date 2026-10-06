import { describe, expect, it } from 'vitest'
import { replay } from './facts'
import { motifs } from './motifs'

const names = (fen: string, sans: string[], start = 0) => motifs(replay(fen, sans)!, start).map(m => m.name)

describe('motifs', () => {
  it('finds a knight fork that wins the rook', () => {
    const m = motifs(replay('r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1', ['Nc7+', 'Kd7', 'Nxa8'])!)
    expect(m[0].name).toBe('fork')
    expect(m[0].text).toBe('Nc7+ attacks the rook on a8 and the king on e8 at once')
  })

  it('finds a pin when the pinned piece is won', () => {
    const m = motifs(replay('4k3/8/4n3/8/3P4/8/8/4R1K1 w - - 0 1', ['d5', 'Ke7', 'dxe6'])!)
    expect(m.map(x => x.name)).toContain('pin')
    expect(m.find(x => x.name === 'pin')!.text).toBe('the knight on e6 is pinned to the king on e8 by the rook on e1')
  })

  it('finds a skewer through the king', () => {
    expect(names('7q/8/8/4k3/8/8/8/2B1K3 w - - 0 1', ['Bb2+', 'Kd5', 'Bxh8'])[0]).toBe('skewer')
  })

  it('names back-rank and smothered mates', () => {
    expect(names('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', ['Ra8#'])[0]).toBe('back-rank mate')
    expect(names('6rk/6pp/7N/8/8/8/8/6K1 w - - 0 1', ['Nf7#'])[0]).toBe('smothered mate')
  })

  it('finds a discovered attack on the queen', () => {
    const m = motifs(replay('4k3/7q/8/8/8/3N4/8/1B2K3 w - - 0 1', ['Nc5', 'Kd8', 'Bxh7'])!)
    expect(m[0].name).toBe('discovered attack')
    expect(m[0].text).toBe('moving the knight from d3 uncovers the bishop on b1, which attacks the queen on h7')
  })

  it('prefers removing the defender over a plain hanging piece', () => {
    expect(names('4k3/8/5n2/3r4/8/8/1B6/3RK3 w - - 0 1', ['Bxf6', 'Kf7', 'Rxd5'])).toEqual(['removing the defender', 'hanging piece'])
  })

  it('names nothing when the line wins nothing', () => {
    expect(names('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', ['Ra7', 'Kf8'])).toEqual([])
  })

  it("reads the opponent's punishment of a wrong move from its second move", () => {
    // Kf2?? walks into a knight fork of king and queen
    const m = motifs(replay('4k3/8/8/8/1n6/8/8/2Q1K3 w - - 0 1', ['Kf2', 'Nd3+', 'Kg3', 'Nxc1'])!, 1)
    expect(m[0].text).toBe('Nd3+ attacks the queen on c1 and the king on f2 at once')
  })

  // Real puzzles from the Lichess puzzle database (CC0), from the position
  // after the opponent's move
  it.each([
    ['007eS', '6k1/p4p2/1p5p/4r3/P3B3/1P2KP2/2P3PP/8 b - - 1 29', ['f5', 'g4', 'fxe4'], 'pin'],
    ['0018P', '5R2/1p6/p1p1k3/2P1r3/2K3p1/2P1p1P1/1P5P/8 w - - 2 45', ['Re8+', 'Kf5', 'Rxe5+'], 'skewer'],
    ['00BJm', 'r4rk1/1Q2bppp/p1N1p3/1p1q4/2pP1n2/2P5/PP3PPP/R4RK1 w - - 2 19', ['Nxe7+', 'Kh8', 'Nxd5'], 'fork'],
    ['001pC', 'r4rk1/pp3ppp/3b4/2p1pPB1/7N/2PP3n/PP4PP/R2Q2RK b - - 0 18', ['Nf2#'], 'smothered mate'],
    ['00Htd', 'rnbqk2r/1p3ppp/p4b2/2PQ4/8/2N2N2/PP2PPPP/R3KB1R b KQkq - 0 9', ['Bxc3+', 'bxc3', 'Qxd5'], 'removing the defender'],
    ['004sg', '6k1/p3b2p/1p1pP3/2P3P1/2np3B/P6P/3Q3K/8 b - - 0 38', ['Nxd2', 'c6', 'd5'], 'hanging piece'],
  ])('puzzle %s: %s', (_, fen, sans, want) => {
    expect(names(fen as string, sans as string[])[0]).toBe(want)
  })

  it('never calls a mating move a fork', () => {
    expect(names('N6r/1p1k1ppp/2np4/b3p3/4P1b1/N1Q5/P4PPP/R3KB1R b KQ - 0 18', ['Bxc3#'])).not.toContain('fork')
  })
})
