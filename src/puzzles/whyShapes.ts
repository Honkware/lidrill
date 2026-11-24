import type { DrawShape } from '@lichess-org/chessground/draw'
import type { Key } from '@lichess-org/chessground/types'
import { Chess } from 'chessops/chess'
import { parseFen } from 'chessops/fen'
import { makeSquare, parseUci } from 'chessops/util'
import type { Puzzle } from '../db'
import { nullMoveFen, type EngineRun, type Packet } from '../server/packet'

// The picture behind "Why?", drawn before any explanation is fetched: the
// move played in red, what it allowed in orange, the best move in green and
// a green circle where the best line lands next. Everything comes from the
// puzzle row and what the browser stored for it (the certification runs in
// db.certs, or the packet on an explanation row), so there is no engine call
// and no request. With nothing stored the picture is the red and green arrows.

// Chessground has no brush called orange; its yellow is #e68f00
export const ORANGE = 'yellow'

export interface WhyStored {
  runs?: Record<string, EngineRun[]>
  packet?: Packet
}

const at = (fen: string, ucis: string[] = []): Chess | undefined => {
  const setup = parseFen(fen)
  if (setup.isErr) return undefined
  const made = Chess.fromSetup(setup.value)
  if (made.isErr) return undefined
  const pos = made.value
  for (const u of ucis) {
    const m = parseUci(u)
    if (!m || !pos.isLegal(m)) return undefined
    pos.play(m)
  }
  return pos
}

// From and to as the board shows them: castling is king-to-rook in the
// game's moves and king-two-squares from Stockfish, and the arrow follows
// the king
function ends(pos: Chess, uci: string): { orig: Key; dest: Key } | undefined {
  const m = parseUci(uci)
  if (!m || !('from' in m) || !pos.isLegal(m)) return undefined
  const mover = pos.board.get(m.from)
  const castle = mover?.role === 'king' && pos.board.get(m.to)?.color === mover.color
  const to = castle ? m.from + (m.to > m.from ? 2 : -2) : m.to
  return { orig: makeSquare(m.from) as Key, dest: makeSquare(to) as Key }
}

function captures(pos: Chess, uci: string): boolean {
  const m = parseUci(uci)
  if (!m || !('from' in m)) return false
  const target = pos.board.get(m.to)
  return !!target && target.color !== pos.turn
}

// A move that takes something or mates on the spot: the two things an arrow
// can show without words
function bites(pos: Chess, uci: string): boolean {
  const m = parseUci(uci)
  if (!m || !pos.isLegal(m)) return false
  if (captures(pos, uci)) return true
  const next = pos.clone()
  next.play(m)
  return next.isCheckmate()
}

// What the move allowed. First the opponent's stored answer to the game
// move, when it takes something or mates; then the threat that was already
// in the position (a packet holds one only when it was certified); then the
// piece the packet certified as left hanging by the game move. An answer or
// an uncertified threat that only improves the position is not drawn.
function allowed(p: Pick<Puzzle, 'fen' | 'played'>, tried: string, stored: WhyStored): DrawShape | undefined {
  const { runs, packet } = stored
  const game = tried === p.played
  const reply = packet?.played?.reply[0]?.uci ?? runs?.played?.[0]?.lines[0]?.pv[0]
  const after = game && reply ? at(p.fen, [p.played]) : undefined
  if (after && bites(after, reply!)) return { ...ends(after, reply!)!, brush: ORANGE }

  // The threat was searched with the move passed to the opponent, so it is
  // drawn on the puzzle position with the other side to move
  const threat = packet ? packet.threat?.line[0]?.uci : runs?.threat?.[0]?.lines[0]?.pv[0]
  const nullFen = threat ? nullMoveFen(p.fen) : undefined
  const passed = nullFen ? at(nullFen) : undefined
  const arrow = passed && (packet || bites(passed, threat!)) ? ends(passed, threat!) : undefined
  if (arrow) return { ...arrow, brush: ORANGE }

  const hang = game ? packet?.certificates.find(c => c.motif === 'hanging piece' && c.subject === 'played') : undefined
  const square = (hang?.payload as { square?: string } | undefined)?.square
  return square ? { orig: square as Key, brush: ORANGE } : undefined
}

// `tried` is the wrong move just made in the drill; without it the game move
// is the one shown
export function whyShapes(p: Pick<Puzzle, 'fen' | 'played' | 'solution'>, stored: WhyStored = {}, tried: string = p.played): DrawShape[] {
  const pos = at(p.fen)
  if (!pos) return []
  const out: DrawShape[] = []
  const red = tried ? ends(pos, tried) : undefined
  if (red) out.push({ ...red, brush: 'red' })
  const orange = tried ? allowed(p, tried, stored) : undefined
  if (orange) out.push(orange)
  const green = p.solution[0] ? ends(pos, p.solution[0]) : undefined
  if (!green) return out
  out.push({ ...green, brush: 'green' })

  // The follow-up square: the player's next move in the stored solution, or
  // the capture the engine's line makes there when the solution is one move
  const line = p.solution.length > 2 ? p.solution : (stored.packet?.best.pv.map(m => m.uci) ?? stored.runs?.best?.[0]?.lines[0]?.pv ?? [])
  const before = line[0] === p.solution[0] && line.length > 2 ? at(p.fen, line.slice(0, 2)) : undefined
  const next = before && (p.solution.length > 2 || captures(before, line[2])) ? ends(before, line[2]) : undefined
  if (next && next.dest !== green.dest) out.push({ orig: next.dest, brush: 'green' })
  return out
}
