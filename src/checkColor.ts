import type { Chess } from 'chessops/chess'
import type { Color } from 'chessops/types'

// Chessground turns `check: true` into "the king of turnColor", so a new fen
// with a stale turnColor lights up the wrong king (chessground #243). Always
// pass the colour in check, worked out from the position itself.
export const checkColor = (pos: Chess): Color | false => (pos.isCheck() ? pos.turn : false)
