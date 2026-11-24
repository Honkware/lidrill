import type { VNode } from 'snabbdom'
import type { Ctrl } from '../ctrl'
import type { Game, Practice, PracticeKind } from '../db'
import { el } from '../el'
import { CLEAR_AFTER, nextOpen } from '../practice'
import { summary } from './summary'
import { board, boardScreen, button, empty, icon, listRow, loading, loadingBlock, pawns, rowList } from './ui'

const TITLE: Record<PracticeKind, string> = { conversion: 'Conversion', defense: 'Defense' }

// Conversion or defense: every position found in the analyzed games, the
// open ones first
export function practiceListView(ctrl: Ctrl, kind: PracticeKind): VNode {
  const items = (ctrl.practiceList ?? []).filter(p => p.kind === kind).sort((a, b) => Number(a.cleared) - Number(b.cleared) || b.ply - a.ply)
  return el('div', 'mx-auto max-w-2xl space-y-4', [
    el('h1', 'font-display text-2xl', TITLE[kind]),
    kind === 'defense' && ctrl.profile?.band === 'beginner'
      ? empty('Unlocks at club level (rated 1000+).')
      : !ctrl.practiceList
        ? loadingBlock('h-60')
        : items.length
          ? rowList(
              items.slice(0, 20).map(p =>
                listRow(`#/practice/${encodeURIComponent(p.id)}`, [
                  el('div', 'min-w-0 flex-1', [
                    el('p', 'font-medium', positionName(p)),
                    el('p', 'truncate text-xs text-dim', [p.attempts ? `${p.attempts} ${p.attempts === 1 ? 'try' : 'tries'}` : 'Not tried yet', gameName(ctrl.practiceGames.get(p.gameId))].filter(Boolean).join(' · ')),
                  ]),
                  p.cleared
                    ? el('span', 'flex items-center gap-1 text-sm text-accent', [icon('check', 16), 'Cleared'])
                    : el(
                        'span',
                        'flex gap-1',
                        Array.from({ length: CLEAR_AFTER }, (_, i) => el('span', 'size-2 rounded-full', { class: { 'bg-accent': i < p.streak, 'bg-raised': i >= p.streak } })),
                      ),
                ]),
              ),
              'overflow-hidden rounded-xl bg-surface',
            )
          : empty('None in analyzed games yet.'),
  ])
}

export function practiceView(ctrl: Ctrl): VNode {
  const run = ctrl.run
  if (!run) return loading()
  const p = run.practice
  const title = TITLE[p.kind]
  // One line, and the numbers live in the side stats, not in sentences
  const goal = p.kind === 'conversion' ? 'Win from here.' : 'Hold.'
  const target = p.kind === 'conversion' ? '+10' : '12 moves'
  const targetNote = p.kind === 'conversion' ? 'Reach +10 or mate; dropping below +2 ends it.' : 'Slip at most a pawn from where you started.'
  const done = run.state === 'won' || run.state === 'lost'
  if (done) return boardScreen({ title, back: () => ctrl.back(p.kind), board: board(`${p.id}:${p.attempts}`, e => run.mount(e)), side: [practiceSummary(ctrl)] })
  return boardScreen({
    title,
    back: () => ctrl.back(p.kind),
    board: board(`${p.id}:${p.attempts}`, e => run.mount(e)),
    side: [
      el('p', 'text-sm', goal),
      el('div', 'flex gap-6 text-sm', [
        el('div', [el('p', 'text-xs text-dim', 'Target'), el('p', 'font-medium tabular-nums', { attrs: { title: targetNote } }, target)]),
        el('div', [el('p', 'text-xs text-dim', 'Eval'), el('p', 'font-medium tabular-nums', pawns(run.cp))]),
        el('div', [el('p', 'text-xs text-dim', 'Your moves'), el('p', 'font-medium tabular-nums', String(run.moves))]),
        run.last ? el('div', [el('p', 'text-xs text-dim', `${run.lastBy} played`), el('p', 'font-medium', run.last)]) : null,
      ]),
      el('p', 'text-sm text-dim', run.state === 'thinking' ? `${run.opponent} is thinking…` : 'Your move.'),
    ],
  })
}

const RESULT = { conversion: ['Converted', 'Not converted'], defense: ['Held', 'Not held'] }
// 'vs name, Italian Game', with whichever of the two the game has
const gameName = (g?: Game) => (g ? [g.opponent && `vs ${g.opponent}`, g.opening.split(':')[0].trim()].filter(Boolean).join(', ') : '')

const positionName = (p: Practice) => `Move ${Math.ceil(p.ply / 2)}, ${pawns(p.startCp)}`

// The positions played one after another, this one last
function practiceSummary(ctrl: Ctrl): VNode {
  const run = ctrl.run!
  const p = run.practice
  const won = run.state === 'won'
  const all = [...ctrl.practiceRun, { practice: p, won }]
  const next = nextOpen(ctrl.practiceList ?? [], p.kind, p.id)
  return summary(ctrl, {
    score: RESULT[p.kind][won ? 0 : 1],
    tone: won ? 'good' : 'bad',
    marks: all.map(r => (r.won ? 'good' : 'bad')),
    counts: [['Eval', pawns(run.cp)], ['Your moves', run.moves]],
    missed: ctrl.practiceRun.filter(r => !r.won).map(r => ({ text: positionName(r.practice), open: `#/practice/${encodeURIComponent(r.practice.id)}` })),
    more: [button('Try again', () => ctrl.retryPractice(), 'plain'), next ? button('Next position', () => void ctrl.nextPosition(p.kind), 'plain') : null].filter(b => b !== null),
  })
}
