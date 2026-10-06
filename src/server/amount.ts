import type { Band } from '../db'

// How much, in words: piece buckets for beginners, pawns with
// one decimal above, and "mate in N" for mates, never a number of pawns
export function amount(cp: number, band: Band): string {
  const a = Math.abs(cp)
  // "a rook's worth", not "a rook": an eval swing isn't a captured piece
  if (band === 'beginner') return a >= 900 ? "a queen's worth" : a >= 450 ? "a rook's worth" : a >= 250 ? "a piece's worth" : a >= 120 ? "a pawn's worth" : 'a small edge'
  if (a >= 1000) return 'more than ten pawns'
  const p = (a / 100).toFixed(1)
  return `${p} pawn${p === '1.0' ? '' : 's'}`
}

export const mateIn = (n: number) => `mate in ${Math.abs(n)}`

// Material points as a piece: 9 a queen, 5 a rook, 3 a piece, 1 a pawn
export const points = (n: number) => (n >= 9 ? 'a queen' : n >= 5 ? 'a rook' : n >= 3 ? 'a piece' : n >= 1 ? 'a pawn' : 'nothing')
