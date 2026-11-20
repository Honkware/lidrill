import type { Eval, Judgment } from '../db'

// Ported from lila: ui/lib/src/ceval/winningChances.ts and
// modules/tree/src/main/Advice.scala, so badges agree with Lichess's own
// analysis. lila is copyright its authors (github.com/lichess-org/lila) and
// licensed AGPL-3.0-or-later.

const raw = (cp: number) => 2 / (1 + Math.exp(-0.00368208 * cp)) - 1

export function winningChances(e: Eval): number {
  if (e.mate !== undefined) {
    const cp = (21 - Math.min(10, Math.abs(e.mate))) * 100
    return raw(e.mate > 0 ? cp : -cp)
  }
  return raw(Math.min(Math.max(-1000, e.cp ?? 0), 1000))
}

// prev and next are white's point of view; mover is who played the move
export function judge(prev: Eval, next: Eval, mover: 'white' | 'black'): Judgment | undefined {
  const pov = (e: Eval): Eval =>
    mover === 'white' ? e : { cp: e.cp === undefined ? undefined : -e.cp, mate: e.mate === undefined ? undefined : -e.mate }
  const p = pov(prev)
  const n = pov(next)

  if (p.mate !== undefined || n.mate !== undefined) {
    const prevCp = p.cp ?? 0
    const nextCp = n.cp ?? 0
    const created = p.mate === undefined && n.mate !== undefined && n.mate < 0
    const lost = p.mate !== undefined && p.mate > 0 && (n.mate === undefined || n.mate < 0)
    if (created) return prevCp < -999 ? 'inaccuracy' : prevCp < -700 ? 'mistake' : 'blunder'
    if (lost) return nextCp > 999 ? 'inaccuracy' : nextCp > 700 ? 'mistake' : 'blunder'
    if (p.mate !== undefined && n.mate !== undefined) return undefined // delayed mate isn't judged
  }
  if (p.cp === undefined || n.cp === undefined) return undefined
  const drop = winningChances(p) - winningChances(n)
  return drop >= 0.3 ? 'blunder' : drop >= 0.2 ? 'mistake' : drop >= 0.1 ? 'inaccuracy' : undefined
}
