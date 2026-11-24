import type { VNode } from 'snabbdom'
import type { Ctrl } from '../ctrl'
import { el } from '../el'
import { button, dots, icon, label, listRow, rowList, type Mark } from './ui'

export interface Missed {
  text: string
  move?: string
  open: string | (() => void)
}

export interface Summary {
  score: string
  tone?: 'good' | 'bad'
  marks: Mark[]
  counts: [string, string | number][]
  missed?: Missed[]
  more?: VNode[] // buttons for this kind of session, before Next
}

// The end of every session, in the side panel of its board screen: the
// score, a square per item, the counts, rows that open what was missed, and
// the next thing to do
export function summary(ctrl: Ctrl, s: Summary): VNode {
  return el('div', 'space-y-4', [
    el('p', 'font-display text-4xl tabular-nums', { class: { 'text-accent': s.tone === 'good', 'text-bad': s.tone === 'bad' } }, s.score),
    dots(s.marks, -1, s.score),
    el(
      'div',
      'flex flex-wrap gap-x-6 gap-y-2',
      s.counts.map(([name, v]) => el('div', [el('p', 'text-xs text-dim', name), el('p', 'font-medium tabular-nums', String(v))])),
    ),
    s.missed?.length
      ? el('div', 'space-y-2', [
          label('Missed'),
          rowList(
            s.missed.map(m =>
              listRow(m.open, [el('span', 'min-w-0 flex-1 truncate text-sm', m.text), m.move ? el('span', 'text-sm font-medium', m.move) : null, icon('next', 16)]),
            ),
            'overflow-hidden rounded-xl bg-surface',
          ),
        ])
      : null,
    s.more?.length ? el('div', 'flex flex-wrap gap-2', s.more) : null,
    // The sample run ends on the sign-in beside it, not on a next thing
    ctrl.sample ? null : el('div', 'primary-action bg-bg py-2', [nextButtons(ctrl)]),
  ])
}

// Next from nextAction, and the day's overview on Train. The game against Maia keeps its own panel
// and puts these under it, plain while solving its puzzles comes first.
export function nextButtons(ctrl: Ctrl, primary = true): VNode {
  const n = ctrl.nextUp
  return el('div', 'grid gap-2 sm:grid-cols-[1fr_auto]', [
    button(n ? `Next: ${n.label}${n.count ? ` ${n.count}` : ''}` : 'Next', () => void ctrl.goNext(), primary ? 'primary' : 'plain', !n),
    button('Today', () => ctrl.go('train', 'day'), 'quiet'),
  ])
}
