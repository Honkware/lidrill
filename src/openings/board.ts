import { Chessground } from '@lichess-org/chessground'
import type { Api } from '@lichess-org/chessground/api'
import type { DrawShape } from '@lichess-org/chessground/draw'
import type { Key } from '@lichess-org/chessground/types'
import type { Chess } from 'chessops/chess'
import { chessgroundDests } from 'chessops/compat'
import { makeFen } from 'chessops/fen'
import type { NormalMove } from 'chessops/types'
import { makeSquare, parseSquare, parseUci } from 'chessops/util'
import { checkColor } from '../checkColor'
import { landSound, sound } from '../sound'

// The board the opening screens share: it shows a position and, when
// asked, lets the side to move play. Promotions are to a queen; inside the
// first eight moves a promotion hardly ever comes up.
export class OpeningBoard {
  private cg?: Api
  private pos?: Chess
  private readonly onUci: (uci: string) => void

  constructor(onUci: (uci: string) => void) {
    this.onUci = onUci
  }

  mount(el: HTMLElement) {
    this.cg = Chessground(el, { coordinates: true, premovable: { enabled: false }, events: { move: (o, d) => this.onMove(o, d) } })
  }

  destroy() {
    this.cg?.destroy()
  }

  // arrows are [uci, brush] pairs, in pos; hint is a square to mark, the
  // way a puzzle's hint marks the piece to move
  show(pos: Chess, orientation: 'white' | 'black', lastMove: string | undefined, movable: boolean, arrows: [string, string][] = [], hint?: string) {
    this.pos = pos
    this.cg?.set({
      fen: makeFen(pos.toSetup()),
      orientation,
      turnColor: pos.turn,
      check: checkColor(pos),
      lastMove: lastMove ? ([lastMove.slice(0, 2), lastMove.slice(2, 4)] as Key[]) : undefined,
      movable: movable ? { free: false, color: pos.turn, dests: chessgroundDests(pos), showDests: true } : { color: undefined, dests: new Map() },
      highlight: { custom: hint ? new Map([[hint as Key, 'hint']]) : new Map() },
    })
    this.cg?.setAutoShapes(arrows.map(([uci, brush]) => arrow(pos, uci, brush)))
    if (hint) this.cg?.selectSquare(hint as Key)
  }

  private onMove(orig: Key, dest: Key) {
    const promotes = this.pos?.board.get(parseSquare(orig)!)?.role === 'pawn' && /[18]$/.test(dest)
    this.onUci(orig + dest + (promotes ? 'q' : ''))
  }
}

// Plays a move on pos with its sound. Castling is king takes rook, so a
// piece of the mover's own colour on the target square is no capture.
export function playMove(pos: Chess, uci: string) {
  const move = parseUci(uci) as NormalMove
  const target = pos.board.get(move.to)
  const capture = (target !== undefined && target.color !== pos.turn) || (move.to === pos.epSquare && pos.board.get(move.from)?.role === 'pawn')
  pos.play(move)
  sound[landSound(capture, pos.isCheck())]()
}

// Castling is stored as king takes rook; the arrow goes where the king lands
function arrow(pos: Chess, uci: string, brush: string): DrawShape {
  const m = parseUci(uci) as NormalMove
  const target = pos.board.get(m.to)
  const castles = pos.board.get(m.from)?.role === 'king' && target?.role === 'rook' && target.color === pos.turn
  const to = castles ? m.from + (m.to > m.from ? 2 : -2) : m.to
  return { orig: makeSquare(m.from) as Key, dest: makeSquare(to) as Key, brush }
}
