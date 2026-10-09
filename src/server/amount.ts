import type { Band } from '../db'

// How much, in words: piece buckets for beginners, pawns with
// one decimal above, and "mate in N" for mates, never a number of pawns.
// "value" replaces the old "worth" so a swing is read as eval/material value,
// not a literal captured piece.
export function amount(cp: number, band: Band): string {
  const a = Math.abs(cp)
  if (band === 'beginner') return a >= 900 ? "a queen's value" : a >= 450 ? "a rook's value" : a >= 250 ? "a piece's value" : a >= 120 ? "a pawn's value" : 'a small edge'
  if (a >= 1000) return 'more than ten pawns'
  const p = (a / 100).toFixed(1)
  return `${p} pawn${p === '1.0' ? '' : 's'}`
}

// Same buckets, but for "worth … more" comparisons where the eval nature is
// already clear from "worth".
export function amountMore(cp: number, band: Band): string {
  const a = Math.abs(cp)
  if (band === 'beginner') return a >= 900 ? 'a queen more' : a >= 450 ? 'a rook more' : a >= 250 ? 'a piece more' : a >= 120 ? 'a pawn more' : 'a tiny bit more'
  if (a >= 1000) return 'more than ten pawns more'
  const p = (a / 100).toFixed(1)
  return `${p} pawn${p === '1.0' ? '' : 's'} more`
}

export const mateIn = (n: number) => `mate in ${Math.abs(n)}`

// Material points as a piece: 9 a queen, 5 a rook, 3 a piece, 1 a pawn
export const points = (n: number) => (n >= 9 ? 'a queen' : n >= 5 ? 'a rook' : n >= 3 ? 'a piece' : n >= 1 ? 'a pawn' : 'nothing')
