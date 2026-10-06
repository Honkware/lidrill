import { Chessground } from '@lichess-org/chessground'
import type { Api } from '@lichess-org/chessground/api'
import type { VNode } from 'snabbdom'
import { Chess } from 'chessops/chess'
import { parseFen } from 'chessops/fen'
import type { Ctrl } from '../ctrl'
import { el } from '../el'
import { corpus, summarize, type Mark, type PrecisionClaim } from '../precision'
import { checkColor } from '../checkColor'
import { button, card, label, pct } from './ui'

// The human precision pass: the reviewer reads each claim from
// the gate corpus over its position and marks it right, wrong, or "cannot
// determine". Progress lives in localStorage; the summary and the export
// are what the release gate ingests. Entry is a quiet link in Settings -
// this is a release-gate tool, not a player tab.

const boards = new WeakMap<Element, Api>()

// A read-only snapshot of the position the claim is about, side to move at
// the bottom (chessground #243: check as a colour on every fen set)
function snapshot(claim: PrecisionClaim): VNode {
  const pos = Chess.fromSetup(parseFen(claim.fen).unwrap()).unwrap()
  return el(
    'div',
    'board',
    { style: { width: '11rem', maxWidth: '11rem' }, key: claim.id },
    [
      el('div', 'cg-wrap', {
        hook: {
          insert: vnode => {
            const elm = vnode.elm as HTMLElement
            boards.set(elm, Chessground(elm, { fen: claim.fen, orientation: pos.turn, coordinates: false, viewOnly: true, check: checkColor(pos), movable: { color: undefined }, premovable: { enabled: false } }))
          },
          destroy: vnode => {
            const elm = vnode.elm as Element
            boards.get(elm)?.destroy()
            boards.delete(elm)
          },
        },
      }),
    ],
  )
}

const MARKS: { mark: Mark; label: string; title: string }[] = [
  { mark: 'right', label: 'Right', title: 'The claim is true in this position' },
  { mark: 'wrong', label: 'Wrong', title: 'The claim is false in this position' },
  { mark: 'unknown', label: 'Can’t tell', title: 'Not enough context to judge' },
]

const SLOT_LABEL: Record<string, string> = {
  whatHappened: 'What happened',
  why: 'Why',
  pattern: 'The pattern',
  nextTime: 'Next time',
}

function summaryCard(ctrl: Ctrl): VNode {
  const marks = ctrl.precisionMarks ?? {}
  const s = summarize(corpus.claims, marks)
  const done = s.marked === s.total
  return card([
    label('Release gate - explanation precision'),
    el('p', 'mt-1 text-sm text-dim', [
      `${s.marked} of ${s.total} claims marked`,
      done ? '' : ' - mark every claim, then export for the gate',
      ` · source: ${corpus.source === 'model' ? 'narrated (gate run)' : 'floor text - rerun after a narrated gate for model claims'}`,
    ]),
    el('div', 'mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm', [
      el('span', '', [el('span', 'font-medium text-accent', `${s.right}`), ' right']),
      el('span', '', [el('span', 'font-medium text-bad', `${s.wrong}`), ' wrong']),
      el('span', 'text-dim', `${s.unknown} can’t tell`),
      el('span', '', ['claim precision: ', el('span', { class: { 'font-medium': true, 'text-accent': s.precision !== null && s.precision >= 0.99, 'text-bad': s.precision !== null && s.precision < 0.99 } }, pct(s.precision ?? undefined))]),
    ]),
    el('div', 'mt-3 flex flex-wrap gap-2', [
      button('Export for the gate', () => ctrl.precisionExport(), 'plain'),
      button('Start over', () => ctrl.precisionReset(), 'quiet'),
    ]),
  ])
}

function claimCard(ctrl: Ctrl): VNode {
  const marks = ctrl.precisionMarks ?? {}
  const i = Math.min(ctrl.precisionIndex, corpus.claims.length - 1)
  const claim = corpus.claims[i]
  const mark = marks[claim.id]
  const go = (d: number) => {
    ctrl.precisionIndex = Math.max(0, Math.min(corpus.claims.length - 1, i + d))
    ctrl.redraw()
  }
  return card([
    el('div', 'flex items-start gap-4', [
      snapshot(claim),
      el('div', 'min-w-0 flex-1', [
        el('p', 'text-xs text-dim', `${SLOT_LABEL[claim.slot] ?? claim.slot} · ${claim.band} band · claim ${i + 1} of ${corpus.claims.length}`),
        el('p', 'mt-2 text-base leading-relaxed', claim.text),
        el('div', 'mt-3 flex flex-wrap gap-2', [
          ...MARKS.map(m =>
            el(
              'button',
              'min-h-11 rounded-lg border-2 px-4 text-sm font-medium',
              {
                attrs: { type: 'button', 'aria-pressed': mark === m.mark, title: m.title },
                class: {
                  'border-accent': mark === m.mark,
                  'border-transparent': mark !== m.mark,
                  'bg-raised': true,
                },
                on: { click: () => ctrl.precisionMark(claim.id, m.mark) },
              },
              m.label,
            ),
          ),
        ]),
      ]),
    ]),
    el('div', 'mt-4 flex items-center justify-between border-t border-raised pt-3', [
      button('← Previous', () => go(-1), 'quiet', i === 0),
      el('div', 'flex gap-1', corpus.claims.map((c, j) => el('span', 'size-2 rounded-sm', { class: { 'bg-accent': marks[c.id] === 'right', 'bg-bad': marks[c.id] === 'wrong', 'bg-warn': marks[c.id] === 'unknown', 'bg-raised': !marks[c.id], 'ring-1': j === i, 'ring-fg': j === i } }))),
      button('Next →', () => go(1), 'quiet', i === corpus.claims.length - 1),
    ]),
  ])
}

export function precisionView(ctrl: Ctrl): VNode {
  return el('div', 'mx-auto max-w-xl space-y-4', [el('h1', 'font-display text-2xl', 'Claim review'), summaryCard(ctrl), claimCard(ctrl)])
}
