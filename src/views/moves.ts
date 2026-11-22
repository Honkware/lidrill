import type { VNode } from 'snabbdom'
import type { Eval, Move, Result } from '../db'
import { el } from '../el'
import { judgMark } from './ui'

// Move list in the style of Lichess's analysis column view, mainline only.
// Ported from lila: ui/analyse/src/treeView/columnView.ts,
// ui/analyse/src/view/components.ts, ui/lib/css/tree/_tree.scss and
// ui/botPlay/src/play/view/autoScroll.ts. lila is copyright its authors
// (github.com/lichess-org/lila) and licensed AGPL-3.0-or-later.

// As lila's renderEval: pawns to one decimal, clamped to 99, mate as #n.
// A checkmated position (cp ±10000) has no eval on Lichess, so none here.
export function evalText(e: Eval): string {
  if (e.mate !== undefined) return `#${e.mate}`.replace('-', '−')
  if (e.cp === undefined || Math.abs(e.cp) >= 10000) return ''
  const p = Math.max(-99, Math.min(99, Math.round(e.cp / 10) / 10))
  return (p > 0 ? '+' : '') + p.toFixed(1).replace('-', '−')
}

export const score = (result: Result, color: 'white' | 'black') => (result === 'draw' ? '½-½' : (result === 'win') === (color === 'white') ? '1-0' : '0-1')

// A click already has the move in view, so only keys and buttons scroll the
// list, as in lila
let clicked = false

function scroll(box: HTMLElement, ply: number, last: number) {
  if (ply < 3) box.scrollTop = 0
  else if (ply === last) box.scrollTop = box.scrollHeight
  else {
    const m = box.querySelector<HTMLElement>('.active')
    if (m) box.scrollTop = m.offsetTop - box.offsetHeight / 2 + m.offsetHeight / 2
  }
}

// `result` is the score line under the last move, once the game is over
export function moveTable(moves: Move[], ply: number, onJump: (ply: number) => void, result?: string): VNode {
  const cells: VNode[] = []
  moves.forEach((m, i) => {
    if (i % 2 === 0) cells.push(el('span', 'idx', String(i / 2 + 1)))
    const ev = m.eval ? evalText(m.eval) : ''
    cells.push(
      el(
        'button',
        `mv ${m.judg ?? ''}`,
        {
          attrs: { type: 'button' },
          class: { active: ply === i + 1, book: !!m.book },
          on: {
            click: () => {
              clicked = true
              onJump(i + 1)
            },
          },
        },
        [m.san, m.judg ? el('span', 'glyph', judgMark[m.judg]) : null, ev ? el('span', 'ev', ev) : null],
      ),
    )
  })
  if (result) cells.push(el('p', 'result', result))
  // The phone layout has the list under the board, so it gets its own scroll
  return el('div', 'moves max-h-64 md:max-h-80', {
    attrs: { 'data-ply': ply },
    hook: {
      insert: v => scroll(v.elm as HTMLElement, ply, moves.length),
      // Scrolls on a jump, a new move or the result line, not on every redraw
      postpatch: (old, v) => {
        const moved = old.data?.attrs?.['data-ply'] !== ply || old.children?.length !== v.children?.length
        if (clicked) clicked = false
        else if (moved) scroll(v.elm as HTMLElement, ply, moves.length)
      },
    },
  }, cells)
}
