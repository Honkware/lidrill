import type { Eval } from '../db'
import { winningChances } from './judge'

// Ported from lila: modules/analyse/src/main/AccuracyPercent.scala, with
// WinPercent from scalachess (core/src/main/scala/eval.scala) and the means
// from scalalib (Maths.scala), so the figures agree with Lichess's. lila is
// copyright its authors (github.com/lichess-org/lila) and licensed
// AGPL-3.0-or-later.

export type Accuracy = { white: number; black: number }

// [0, 100] for white. lila turns a mate into the 1000 cp ceiling, where
// winningChances would give it more.
export function winPercent(e: Eval): number {
  const cp = e.mate === undefined ? e.cp : e.mate > 0 ? 1000 : -1000
  return 50 + 50 * winningChances({ cp })
}

// before and after are the mover's win percents. The curve is lila's
// exponential fit to hand-picked points (a drop of 10 gives 60, of 40 gives
// 20, of 80 gives 0), plus one point for imperfect analysis.
export function moveAccuracy(before: number, after: number): number {
  if (after >= before) return 100
  const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * (before - after)) - 3.166924740191411
  return Math.min(100, Math.max(0, raw + 1))
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

function stdev(xs: number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length)
}

// evals[0] is the position before the first move, white's point of view; a
// missing eval drops the moves next to it. Each move is weighted by how
// much the win percent swings in a window around it, so a slip in a sharp
// position costs less than one in a quiet one, and the result is the mean
// of that weighted mean and the harmonic mean, which a few bad moves pull
// down hard.
export function gameAccuracy(start: 'white' | 'black', evals: (Eval | undefined)[]): Accuracy | undefined {
  const wps = evals.map(e => (e ? winPercent(e) : undefined))
  const size = clamp(Math.floor((evals.length - 1) / 10), 2, 8)
  const windows: (number | undefined)[][] = []
  // the first moves share the opening window, so every move gets one
  for (let i = 0; i < Math.min(size, wps.length) - 2; i++) windows.push(wps.slice(0, size))
  const slides = wps.length ? Math.max(1, wps.length - size + 1) : 0
  for (let i = 0; i < slides; i++) windows.push(wps.slice(i, i + size))

  const moves: Record<'white' | 'black', { acc: number; w: number }[]> = { white: [], black: [] }
  for (let i = 0; i + 1 < wps.length; i++) {
    const [p, n] = [wps[i], wps[i + 1]]
    const win = windows[i]
    if (p === undefined || n === undefined || win.some(x => x === undefined)) continue
    const white = (i % 2 === 0) === (start === 'white')
    const acc = white ? moveAccuracy(p, n) : moveAccuracy(n, p)
    moves[white ? 'white' : 'black'].push({ acc, w: clamp(stdev(win as number[]), 0.5, 12) })
  }

  const side = (ms: { acc: number; w: number }[]) => {
    const weighted = ms.reduce((a, m) => a + m.acc * m.w, 0) / ms.reduce((a, m) => a + m.w, 0)
    const harmonic = ms.length / ms.reduce((a, m) => a + 1 / Math.max(1, m.acc), 0)
    return (weighted + harmonic) / 2
  }
  if (!moves.white.length || !moves.black.length) return
  return { white: side(moves.white), black: side(moves.black) }
}
