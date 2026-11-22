import type { VNode } from 'snabbdom'
import type { Ctrl } from '../ctrl'
import type { Practice, PracticeKind } from '../db'
import { el } from '../el'
import { MAX_LEVEL, MIN_LEVEL } from '../maia'
import { TIMES } from '../play'
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
    maiaCard(ctrl),
    section('conversion', list),
    band === 'beginner'
      ? card([
          el('h2', 'font-display text-lg', ABOUT.defense.title),
          el('p', 'mt-1 text-sm text-dim', 'Unlocks at club level (rated 1000+). Until then, conversion is the one that wins games.'),
        ])
      : section('defense', list),
  ])
}

// Whole games against Maia-3. Its strength was measured, not guaranteed, so
// the card says "about" and never promises a rating.
function maiaCard(ctrl: Ctrl): VNode {
  const level = ctrl.maiaLevel
  const { time, color, pace } = ctrl.playChoices
  const games = ctrl.profile?.maia?.games ?? 0
  const step = (by: number) =>
    el(
      'button',
      'grid h-11 place-items-center rounded-lg bg-raised text-sm font-medium tabular-nums disabled:opacity-40',
      { attrs: { type: 'button', disabled: level === (by < 0 ? MIN_LEVEL : MAX_LEVEL) }, on: { click: () => ctrl.stepMaiaLevel(by) } },
      `${by < 0 ? '−' : '+'}${Math.abs(by)}`,
    )
  return card([
    el('h2', 'font-display text-lg', 'Play Maia'),
    el(
      'p',
      'mt-1 text-sm text-dim',
      'A whole game against Maia-3, a model that plays like a person of a given rating. The level follows your results and stays a little above you. Afterwards your mistakes become puzzles.',
    ),
    el('div', 'mt-4 text-center', [
      el('p', 'font-display text-2xl tabular-nums', `about ${level}`),
      el('p', 'text-xs text-dim', 'approximate Lichess blitz rating'),
    ]),
    el('div', 'mt-3 grid grid-cols-6 gap-2', [-100, -10, -1, 1, 10, 100].map(step)),
    el('p', 'mt-2 text-center text-xs text-dim', [
      ctrl.playLevel === undefined
        ? games
          ? `Set from your ${games === 1 ? 'game' : `${games} games`} against Maia.`
          : 'Set from your rating until you have played a game.'
        : el('button', 'underline', { attrs: { type: 'button' }, on: { click: () => ctrl.stepMaiaLevel(0) } }, 'Back to the level that follows your results'),
    ]),
    // Seven times fit a phone's card only with the symbol for unlimited
    segments('Time', TIMES.map(t => (t === 'unlimited' ? [t, '∞', 'Unlimited'] : [t, t])), time, t => ctrl.setPlayChoice({ time: t })),
    segments('Colour', [['white', 'White'], ['black', 'Black'], ['random', 'Random']], color, c => ctrl.setPlayChoice({ color: c })),
    segments('Pace', [['human', 'Human'], ['instant', 'Instant']], pace, p => ctrl.setPlayChoice({ pace: p })),
    el('p', 'mt-1 text-xs text-dim', 'Maia takes about as long over a move as a person would.'),
    el('div', 'mt-4 flex flex-wrap gap-2', [
      button('New game', () => ctrl.startPlay(false)),
      ctrl.playStarts.length ? button('From one of your games', () => ctrl.startPlay(true), 'plain') : null,
    ]),
  ])
}

// [value, text, a spoken name when the text is a symbol]
function segments<T extends string>(name: string, opts: [T, string, string?][], current: T, pick: (v: T) => void): VNode {
  return el('div', 'mt-3', [
    el('p', 'text-xs text-dim', name),
    el(
      'div',
      'mt-1 grid auto-cols-fr grid-flow-col gap-1',
      opts.map(([v, text, spoken]) => {
        const on = v === current
        return el(
          'button',
          'h-9 rounded-md text-xs font-medium tabular-nums',
          {
            attrs: { type: 'button', 'aria-pressed': String(on), ...(spoken && { 'aria-label': spoken, title: spoken }) },
            class: { 'bg-accent': on, 'text-bg': on, 'bg-raised': !on },
            on: { click: () => pick(v) },
          },
          text,
        )
      }),
    ),
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
  // The rule is stated once, on the list page (ABOUT). Here: one line, and
  // the numbers live in the side stats, not in sentences.
  const goal = p.kind === 'conversion' ? 'Win from here.' : 'Hold.'
  const target = p.kind === 'conversion' ? '+10' : '12 moves'
  const targetNote = p.kind === 'conversion' ? 'Reach +10 or mate; dropping below +2 ends it.' : 'Slip at most a pawn from where you started.'
  const done = run.state === 'won' || run.state === 'lost'
  return el('div', 'md:grid md:grid-cols-[auto_minmax(0,1fr)] md:gap-6 md:pt-4', [
    el('div', [el('div', 'md:hidden', [topBar(title, () => ctrl.back('drills'))]), board(`${p.id}:${p.attempts}`, e => run.mount(e))]),
    el('aside', 'space-y-4 px-4 pb-8 pt-3 md:px-0 md:pt-0', [
      el('div', 'hidden md:block', [topBar(title, () => ctrl.back('drills'))]),
      el('p', 'text-sm', goal),
      el('div', 'flex gap-6 text-sm', [
        el('div', [el('p', 'text-xs text-dim', 'Target'), el('p', 'font-medium tabular-nums', { attrs: { title: targetNote } }, target)]),
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
            // Same rule as the drill: typing is for keyboards
            el('div', 'hidden md:block', [moveInput(t => run.typeMove(t))]),
          ]),
    ]),
  ])
}
