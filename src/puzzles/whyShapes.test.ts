// The arrows behind "Why?" on real positions: the certification reports the
// gate saved (src/server/fixtures/gate-reports.json) hold the same runs the
// browser keeps in db.certs, and buildPacket makes the packet an explanation
// row carries.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildPacket, type EngineReport, type Packet } from '../server/packet'
import { ORANGE, whyShapes } from './whyShapes'

const reports = JSON.parse(readFileSync('src/server/fixtures/gate-reports.json', 'utf8')) as EngineReport[]
const at = (fen: string) => {
  const r = reports.find(x => x.fen === fen)!
  const built = buildPacket({ ...r, band: 'club' })
  if (!built.ok) throw new Error(built.error)
  return {
    puzzle: { fen: r.fen, played: r.played!.uci, solution: r.solution },
    runs: { best: r.best, threat: r.threat ?? [], played: r.played!.runs },
    packet: built.packet,
  }
}

// ...Rae8 left the queen on a5 to the queen on d2; ...Qxd2+ was the move
const QUEEN_LEFT = 'r4rk1/pp4pp/1np2p1n/q1bpp2b/7P/P2PP3/1PPQNP1N/R1B1KBR1 b Q - 3 13'
// ...c6 walked into Na7#; ...Bxa6 took the knight that would give it
const MATE_ALLOWED = '2kr1bnr/1bpqp2p/Np3pp1/1N1p4/3P1P2/4P3/PPP1Q1PP/R1B2RK1 b - - 2 14'
// ...Kg7 lost nothing at once: the reply Be4 takes nothing, and the threat is only certified in the packet
const QUIET_REPLY = '6k1/8/2n5/p4B1p/2Pp1p1q/8/P2RP2P/3R2K1 b - - 2 32'
// Nd5 let the queen in; Rh6+ and Rxb6 won it instead
const SKEWER = '8/8/1q2k3/pp5R/1N4p1/6K1/8/8 w - - 0 51'
// The answer is to castle long
const CASTLES = 'r3k2r/pp1n1ppp/2pQP3/8/8/8/P3bPPP/b1B3KR b kq - 0 17'

describe('whyShapes', () => {
  it('draws the game move in red and the best move in green from the puzzle row alone', () => {
    const { puzzle } = at(QUEEN_LEFT)
    expect(whyShapes(puzzle)).toEqual([
      { orig: 'a8', dest: 'e8', brush: 'red' },
      { orig: 'a5', dest: 'd2', brush: 'green' },
    ])
  })

  it('adds the capture the game move allowed in orange, from the stored runs or the packet', () => {
    const { puzzle, runs, packet } = at(QUEEN_LEFT)
    const orange = { orig: 'd2', dest: 'a5', brush: ORANGE }
    expect(whyShapes(puzzle, { runs })[1]).toEqual(orange)
    expect(whyShapes(puzzle, { packet })[1]).toEqual(orange)
  })

  it('draws a reply that mates even though it takes nothing', () => {
    const { puzzle, runs } = at(MATE_ALLOWED)
    expect(whyShapes(puzzle, { runs })).toContainEqual({ orig: 'b5', dest: 'a7', brush: ORANGE })
  })

  it('leaves out a reply and an uncertified threat that win nothing at once', () => {
    const { puzzle, runs, packet } = at(QUIET_REPLY)
    expect(whyShapes(puzzle, { runs }).map(s => s.brush)).toEqual(['red', 'green', 'green'])
    // The packet certified the same move as a threat, so there it is drawn
    expect(whyShapes(puzzle, { packet })).toContainEqual({ orig: 'f5', dest: 'e4', brush: ORANGE })
  })

  it('shows the threat, not the reply to the game move, for a different wrong try', () => {
    const { puzzle, packet } = at(QUEEN_LEFT)
    const shapes = whyShapes(puzzle, { packet }, 'g8h8')
    expect(shapes[0]).toEqual({ orig: 'g8', dest: 'h8', brush: 'red' })
    // The certified threat is the same capture, drawn from the puzzle position
    expect(shapes[1]).toEqual({ orig: 'd2', dest: 'a5', brush: ORANGE })
    expect(whyShapes(puzzle, {}, 'g8h8').map(s => s.brush)).toEqual(['red', 'green'])
  })

  it('circles the square the player lands on next in a longer solution', () => {
    // Qg5+ Kf2 Qxf5: the queen takes on f5
    const { puzzle } = at(QUIET_REPLY)
    expect(whyShapes(puzzle).at(-1)).toEqual({ orig: 'f5', brush: 'green' })
  })

  it('circles the capture in the stored line when the solution is a single move', () => {
    const { puzzle, runs } = at(SKEWER)
    expect(puzzle.solution).toEqual(['h5h6'])
    expect(whyShapes(puzzle).map(s => s.brush)).toEqual(['red', 'green'])
    expect(whyShapes(puzzle, { runs }).at(-1)).toEqual({ orig: 'b6', brush: 'green' })
  })

  it('points a castling arrow at the square the king lands on, in either notation', () => {
    const { puzzle } = at(CASTLES)
    expect(whyShapes(puzzle)).toContainEqual({ orig: 'e8', dest: 'c8', brush: 'green' })
    expect(whyShapes(puzzle, {}, 'e8a8')[0]).toEqual({ orig: 'e8', dest: 'c8', brush: 'red' })
  })

  it('circles the piece the packet certified as hanging when no arrow shows it', () => {
    const { puzzle, packet } = at(QUEEN_LEFT)
    const bare: Packet = { ...packet, threat: undefined, played: { ...packet.played!, reply: [] } }
    expect(whyShapes(puzzle, { packet: bare })[1]).toEqual({ orig: 'a5', brush: ORANGE })
  })

  it('returns nothing for a position it cannot read', () => {
    expect(whyShapes({ fen: 'not a fen', played: 'e2e4', solution: ['d2d4'] })).toEqual([])
  })
})
