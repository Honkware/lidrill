import type { VNode } from 'snabbdom'
import type { Ctrl } from '../ctrl'
import type { Practice, PracticeKind } from '../db'
import { el } from '../el'
import { CLEAR_AFTER } from '../practice'
import { board, button, card, icon, moveInput, pawns, topBar } from './ui'

const ABOUT: Record<PracticeKind, { title: string; text: string }> = {
  conversion: {
    title: 'Conversion',
    text: "Positions where you were winning on material and didn't win. Play them out against Stockfish until you convert three times in a row.",
  },
  defense: {
    title: 'Defense',
    text: "Positions where you were worse and saved the game. Hold them against Stockfish for 12 moves, three times in a row.",
  },
}

export function drillsView(ctrl: Ctrl): VNode {
  const list = ctrl.practiceList
  const band = ctrl.profile?.band
  return el('div', 'mx-auto max-w-2xl space-y-4', [
    el('h1', 'font-display text-2xl', 'Drills'),
    section('conversion', list),
    band === 'beginner'
      ? card([
          el('h2', 'font-display text-lg', ABOUT.defense.title),
          el('p', 'mt-1 text-sm text-dim', 'Unlocks at club level (rated 1000+). Until then, conversion is the one that wins games.'),
        ])
      : section('defense', list),
  ])
}

function section(kind: PracticeKind, list?: Practice[]): VNode {
  const items = (list ?? []).filter(p => p.kind === kind).sort((a, b) => Number(a.cleared) - Number(b.cleared) || b.ply - a.ply)
  return card([
    el('h2', 'font-display text-lg', ABOUT[kind].title),
    el('p', 'mt-1 text-sm text-dim', ABOUT[kind].text),
    items.length
      ? el(
          'ul',
          'mt-3 divide-y divide-raised',
          items.slice(0, 20).map(p =>
            el('li', [
              el('a', 'flex items-center gap-3 py-3', { attrs: { href: `#/practice/${encodeURIComponent(p.id)}` } }, [
                el('div', 'min-w-0 flex-1', [
                  el('p', 'font-medium', `Move ${Math.ceil(p.ply / 2)}, ${pawns(p.startCp)}`),
                  el('p', 'text-xs text-dim', p.attempts ? `${p.attempts} tries` : 'Not tried yet'),
                ]),
                p.cleared
                  ? el('span', 'flex items-center gap-1 text-sm text-accent', [icon('check', 16), 'Cleared'])
                  : el(
                      'span',
                      'flex gap-1',
                      Array.from({ length: CLEAR_AFTER }, (_, i) => el('span', 'size-2 rounded-full', { class: { 'bg-accent': i < p.streak, 'bg-raised': i >= p.streak } })),
                    ),
              ]),
            ]),
          ),
        )
      : el('p', 'mt-3 text-sm text-dim', 'None in your analyzed games yet.'),
  ])
}

export function practiceView(ctrl: Ctrl): VNode {
  const run = ctrl.run
  if (!run) return el('p', 'p-4 text-dim', 'Loading…')
  const p = run.practice
  const title = ABOUT[p.kind].title
  const goal =
    p.kind === 'conversion'
      ? 'Win from here: reach a decisive advantage (+10) or mate. Dropping below +2 ends it.'
      : 'Hold for 12 moves without slipping more than a pawn from where you started.'
  const done = run.state === 'won' || run.state === 'lost'
  return el('div', 'md:grid md:grid-cols-[auto_minmax(0,1fr)] md:gap-6 md:pt-4', [
    el('div', [el('div', 'md:hidden', [topBar(title, () => ctrl.back('drills'))]), board(`${p.id}:${p.attempts}`, e => run.mount(e))]),
    el('aside', 'space-y-4 px-4 pb-8 pt-3 md:px-0 md:pt-0', [
      el('div', 'hidden md:block', [topBar(title, () => ctrl.back('drills'))]),
      el('p', 'text-sm', goal),
      el('div', 'flex gap-6 text-sm', [
        el('div', [el('p', 'text-xs text-dim', 'Eval'), el('p', 'font-medium tabular-nums', pawns(run.cp))]),
        el('div', [el('p', 'text-xs text-dim', 'Your moves'), el('p', 'font-medium tabular-nums', String(run.moves))]),
        run.last ? el('div', [el('p', 'text-xs text-dim', 'Stockfish played'), el('p', 'font-medium', run.last)]) : null,
      ]),
      done
        ? el('div', 'space-y-3', [
            el('p', 'font-display text-xl', { class: { 'text-accent': run.state === 'won', 'text-bad': run.state === 'lost' } }, run.state === 'won' ? (p.kind === 'conversion' ? 'Converted' : 'Held') : 'Not this time'),
            el('div', 'flex gap-2', [button('Try again', () => ctrl.retryPractice()), button('All drills', () => ctrl.go('drills'), 'plain')]),
          ])
        : el('div', 'space-y-2', [
            el('p', 'text-sm text-dim', run.state === 'thinking' ? 'Stockfish is thinking…' : 'Your move.'),
            moveInput(t => run.typeMove(t)),
          ]),
    ]),
  ])
}
