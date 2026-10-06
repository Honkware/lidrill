import type { Chess } from 'chessops/chess'
import { parseSan } from 'chessops/san'
import { makeUci, parseUci } from 'chessops/util'

// Keyboard move entry: SAN as people write it
// ("Nf3", "exd5", "O-O", "e8=Q+") or UCI ("g1f3"). Returns UCI if legal.
export function parseTyped(pos: Chess, text: string): string | undefined {
  const clean = text.trim().replace(/[+#!?]+$/, '').replace(/0/g, 'O')
  if (!clean) return undefined
  const san = parseSan(pos, clean) ?? parseSan(pos, clean.charAt(0).toUpperCase() + clean.slice(1))
  if (san) return makeUci(san)
  const uci = parseUci(text.trim().toLowerCase())
  return uci && pos.isLegal(uci) ? makeUci(uci) : undefined
}
