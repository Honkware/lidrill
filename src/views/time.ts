import { h, type VNode } from 'snabbdom'
import type { Ctrl } from '../ctrl'
import type { Game } from '../db'
import { el } from '../el'
import { AFTER_MOVE, gameTime, MIN_GAMES, RECENT, slowest, TROUBLE, type GameTime, type Pace, type TimeProfile } from '../time'
import { CEILING, FLOOR, limitFor } from '../timed'
import { button, card, label, pct } from './ui'

const secs = (s: number) => `${s < 10 ? s.toFixed(1) : Math.round(s)} s`
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

const FILL = { inaccuracy: 'fill-inaccuracy', mistake: 'fill-mistake', blunder: 'fill-blunder' } as const

const fact = (name: string, value: string, bad = false) =>
  el('div', 'min-w-0', [el('p', 'text-xs text-dim', name), el('p', 'font-medium tabular-nums', { class: { 'text-bad': bad } }, value)])

// One bar per timed move, stretched to the card's width, with the game's
// median as a dashed line
function bars(t: GameTime): VNode {
  const w = t.moves.length * 4
  const ht = 48
  const max = Math.max(1, ...t.moves.map(m => m.secs))
  const y = (s: number) => ht - Math.max(1, (s / max) * ht)
  return h('svg', { attrs: { viewBox: `0 0 ${w} ${ht}`, preserveAspectRatio: 'none', height: ht, class: 'block w-full', role: 'img', 'aria-label': 'Seconds per move' } }, [
    ...t.moves.map((m, i) =>
      h('rect', { attrs: { x: i * 4, y: y(m.secs), width: 3, height: ht - y(m.secs), class: m.judg ? FILL[m.judg] : 'fill-dim opacity-40' } }, [h('title', `Move ${m.move}: ${secs(m.secs)}`)]),
    ),
    h('line', { attrs: { x1: 0, x2: w, y1: y(t.median), y2: y(t.median), class: 'stroke-fg', 'stroke-width': 1, 'stroke-dasharray': '3 3', 'vector-effect': 'non-scaling-stroke' } }),
  ])
}

// In the game review panel, for a game with clocks
export function timeCard(g: Game): VNode | null {
  const t = gameTime(g)
  if (!t) return null
  const slow = slowest(t)
  const low = t.moves.reduce((a, b) => (b.left < a.left ? b : a))
  return card(
    [
      label('Time'),
      bars(t),
      el('p', 'text-xs text-dim', `Seconds per move from move 2. Inaccuracies, mistakes and blunders in their colours; the dashed line is your median, ${secs(t.median)}.`),
      el('div', 'grid grid-cols-3 gap-3 text-sm', [
        fact('Used by move 15', t.usedBy15 === undefined ? '–' : pct(t.usedBy15)),
        fact('Slowest move', `${secs(slow.secs)}, move ${slow.move}`),
        t.lostOnTime ? fact('Clock', 'Lost on time', true) : fact('Lowest clock', `${clock(low.left)}, move ${low.move}`, low.left < TROUBLE * t.tc.base),
      ]),
    ],
    'space-y-3',
  )
}

// The words for FAST and SLOW in time.ts
const PACE: [Pace, string][] = [
  ['fast', 'Fast, under half the game median'],
  ['normal', 'Normal'],
  ['slow', 'Slow, over twice the game median'],
]

// On the Review list, under the games: where the clock goes across the
// player's recent games, and the timed puzzles built on it
export function timeProfileCard(ctrl: Ctrl): VNode | null {
  const p = ctrl.timeProfiles[0]
  if (!p) return card([label('Time'), el('p', 'mt-1 text-sm text-dim', `Needs ${MIN_GAMES} analyzed blitz or rapid games with clocks.`)])
  return card(
    [
      label('Time'),
      el('p', 'text-sm text-dim', `${p.speed === 'blitz' ? 'Blitz' : 'Rapid'}, your last ${p.games} analyzed games with clocks${p.games === RECENT ? '' : ` (up to ${RECENT})`}.`),
      el('div', 'grid grid-cols-2 gap-3 text-sm', [
        fact('Used by move 15, on average', p.usedBy15 === undefined ? '–' : pct(p.usedBy15)),
        fact(`Median time per move after move ${AFTER_MOVE}`, secs(p.think)),
        fact(`Time trouble, under ${pct(TROUBLE)} of the base`, `${p.trouble} of ${p.games} games`, p.trouble > 0),
        fact('Lost on time', `${p.lostOnTime} of ${p.games} games`, p.lostOnTime > 0),
      ]),
      paceTable(p),
      el('div', 'flex flex-wrap items-center gap-3', [
        button('Move under a clock', () => void ctrl.startTimed('review'), 'plain'),
        el('p', 'text-xs text-dim', `Your own puzzles, ${limitFor(p.think, 1)} s a move.`),
      ]),
    ],
    'space-y-3',
  )
}

// Mistakes and blunders by how long the move took, against the median of
// its own game
function paceTable(p: TimeProfile): VNode {
  return el('table', 'w-full text-sm', [
    el('thead', [
      el('tr', 'text-left text-xs text-dim', [
        el('th', 'py-1 pr-2 font-normal', 'Pace'),
        el('th', 'py-1 pr-2 text-right font-normal', 'Moves'),
        el('th', 'py-1 text-right font-normal', 'Mistakes and blunders'),
      ]),
    ]),
    el(
      'tbody',
      PACE.map(([k, name]) => {
        const { moves, errors } = p.pace[k]
        return el('tr', 'border-t border-raised', [
          el('td', 'py-2 pr-2', name),
          el('td', 'py-2 pr-2 text-right tabular-nums', String(moves)),
          el('td', 'py-2 text-right tabular-nums', moves ? `${errors} (${pct(errors / moves)})` : '–'),
        ])
      }),
    ),
  ])
}

// Above the panel of a timed puzzle on the drill screen
export function countdownBar(ctrl: Ctrl): VNode | null {
  const c = ctrl.countdown
  if (!ctrl.timed || !c || ctrl.review.viewing !== undefined) return null
  return el('div', 'space-y-1', [
    el('div', 'flex items-baseline justify-between gap-3', [
      el('p', 'font-display text-2xl tabular-nums', { class: { 'text-bad': c.out } }, c.out ? 'Out of time' : `${Math.ceil(c.left / 1000)} s`),
      el('p', 'text-xs text-dim', `${c.limit} s for this puzzle`),
    ]),
    el('p', 'text-xs text-dim', "Running out of time is a miss in this session only. The puzzle's schedule does not change."),
  ])
}

// The entry on the Drills screen
export function timedCard(ctrl: Ctrl): VNode {
  const p = ctrl.timeProfiles[0]
  return card([
    el('h2', 'font-display text-lg', 'Move under a clock'),
    el('p', 'mt-1 text-sm text-dim', 'Your own puzzles against a countdown set from how long you take over a move in your games.'),
    el(
      'p',
      'mt-2 text-sm',
      p
        ? `${limitFor(p.think, 1)} s a move: your ${p.speed} median after move ${AFTER_MOVE} is ${secs(p.think)}, kept between ${FLOOR} and ${CEILING} s.`
        : `Needs ${MIN_GAMES} analyzed blitz or rapid games with clocks.`,
    ),
    p ? el('div', 'mt-4 flex', [button('Start', () => void ctrl.startTimed('drills'), 'plain')]) : null,
  ])
}

// After a timed game against Maia: the clock after the player's last move
// and their slowest move
export function playTimeLine(g: Game): VNode | null {
  const t = gameTime(g)
  if (!t) return null
  const slow = slowest(t)
  const last = t.moves[t.moves.length - 1]
  return el('p', 'text-sm', [
    'Clock after your last move: ',
    el('span', 'font-medium tabular-nums', clock(last.left)),
    '. Slowest move: ',
    el('span', 'font-medium tabular-nums', `${secs(slow.secs)}, move ${slow.move}`),
    '.',
  ])
}
