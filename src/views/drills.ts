import { h, type VNode } from 'snabbdom'
import type { Ctrl } from '../ctrl'
import type { MaiaSpeed, Practice, PracticeKind } from '../db'
import { el } from '../el'
import { history, MAX_LEVEL, MIN_LEVEL, startLabel } from '../maia'
import { readGame, TIMES, type SavedGame } from '../play'
import { CLEAR_AFTER } from '../practice'
import { openingsCard } from './openings'
import { timedCard } from './time'
import { board, boardScreen, btnClass, button, card, dateLabel, icon, listRow, loading, moveInput, pawns, rowList, segmented } from './ui'

const TITLE: Record<PracticeKind, string> = { conversion: 'Conversion', defense: 'Defense' }

export function drillsView(ctrl: Ctrl): VNode {
  const list = ctrl.practiceList
  const band = ctrl.profile?.band
  return el('div', 'mx-auto max-w-2xl space-y-4', [
    el('h1', 'font-display text-2xl', 'Drills'),
    openingsCard(ctrl),
    maiaCard(ctrl),
    timedCard(ctrl),
    section('conversion', list),
    band === 'beginner'
      ? card([
          el('h2', 'font-display text-lg', TITLE.defense),
          el('p', 'mt-1 text-sm text-dim', 'Unlocks at club level (rated 1000+).'),
        ])
      : section('defense', list),
  ])
}

// Whole games against Maia-3. Its strength was measured, not guaranteed, so
// the card says "about" and never promises a rating.
function maiaCard(ctrl: Ctrl): VNode {
  const level = ctrl.maiaLevel
  const { time, color, pace } = ctrl.playChoices
  const speed = ctrl.maiaSpeed
  const saved = readGame()
  const step = (by: number) =>
    el(
      'button',
      `${btnClass('plain', 'fill')} tabular-nums`,
      { attrs: { type: 'button', disabled: level === (by < 0 ? MIN_LEVEL : MAX_LEVEL) }, on: { click: () => ctrl.stepMaiaLevel(by) } },
      `${by < 0 ? '−' : '+'}${Math.abs(by)}`,
    )
  return card([
    el('h2', 'font-display text-lg', 'Play Maia'),
    el('p', 'mt-4 text-center font-display text-2xl tabular-nums', { attrs: { title: 'Approximate Lichess blitz rating' } }, `about ${level}`),
    levelLine(ctrl, speed),
    el('div', 'mt-3 grid grid-cols-6 gap-2', [-100, -10, -1, 1, 10, 100].map(step)),
    ctrl.playLevel === undefined
      ? null
      : el('p', 'mt-2 text-center text-xs text-dim', [
          // A link in the line of text, so not a button()
          el('button', 'underline', { attrs: { type: 'button' }, on: { click: () => ctrl.stepMaiaLevel(0) } }, 'Back to the level that follows your results'),
        ]),
    // Seven times fit a phone's card only with the symbol for unlimited
    segments('Time', TIMES.map(t => (t === 'unlimited' ? [t, '∞', 'Unlimited'] : [t, t])), time, t => ctrl.setPlayChoice({ time: t })),
    segments('Colour', [['white', 'White'], ['black', 'Black'], ['random', 'Random']], color, c => ctrl.setPlayChoice({ color: c })),
    segments('Pace', [['human', 'Human'], ['instant', 'Instant']], pace, p => ctrl.setPlayChoice({ pace: p }), 'Human takes about as long as a person; Instant replies at once'),
    el('div', 'mt-4 flex flex-wrap gap-2', [
      saved ? button('Continue game', () => ctrl.go('play')) : null,
      button('New game', () => ctrl.startPlay(false), saved ? 'plain' : 'primary'),
      ctrl.playStarts.length ? button('Start from a game', () => ctrl.togglePlayPicking(), 'plain') : null,
    ]),
    saved ? el('p', 'mt-2 text-xs text-dim', savedText(saved)) : null,
    ctrl.playPicking
      ? rowList(
          ctrl.playStarts.slice(0, 5).map(s => listRow(() => ctrl.startPlay(s), [el('span', 'min-w-0 truncate text-sm', `${startLabel(s)}, ${dateLabel(s.playedAt)}`)])),
          'mt-2 -mx-4 sm:-mx-5',
        )
      : null,
  ])
}

// The estimate going into each of the last games at the card's speed, then
// the estimate now, once there are enough games for a line to mean anything
function levelLine(ctrl: Ctrl, speed: MaiaSpeed): VNode | null {
  const pts = history(ctrl.maiaGames, speed)
  if (pts.length < 5) return null
  const n = pts.length
  if (ctrl.maiaEstimate.from === speed) pts.push(ctrl.maiaRating)
  const lo = Math.min(...pts)
  const hi = Math.max(...pts)
  const w = 100
  const ht = 32
  const xy = pts.map((v, i) => `${(i / (pts.length - 1)) * w},${hi === lo ? ht / 2 : 2 + ((hi - v) / (hi - lo)) * (ht - 4)}`).join(' ')
  return el('div', 'mt-3', [
    el('div', 'flex items-center gap-2 text-xs tabular-nums text-dim', [
      el('span', String(pts[0])),
      // Stretched to the card's width; the stroke stays 2px wide
      h('svg', { attrs: { viewBox: `0 0 ${w} ${ht}`, preserveAspectRatio: 'none', height: ht, class: 'min-w-0 flex-1', 'aria-hidden': 'true' } }, [
        h('polyline', { attrs: { points: xy, fill: 'none', class: 'stroke-accent', 'stroke-width': 2, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' } }),
      ]),
      el('span', String(pts.at(-1))),
    ]),
    el('p', 'text-center text-xs text-dim', `Estimate over the last ${n} ${speed} games`),
  ])
}

function savedText({ opts, moves }: SavedGame): string {
  const c = opts.clock
  return `${c ? `${c.base / 60}+${c.inc}` : 'Untimed game'} against Maia about ${opts.level}, move ${Math.floor(moves.length / 2) + 1}`
}

// [value, text, a spoken name when the text is a symbol]
function segments<T extends string>(name: string, opts: [T, string, string?][], current: T, pick: (v: T) => void, title?: string): VNode {
  return el('div', 'mt-3 space-y-1', [el('p', 'text-xs text-dim', title ? { attrs: { title } } : {}, name), segmented(name, opts, current, pick)])
}

function section(kind: PracticeKind, list?: Practice[]): VNode {
  const items = (list ?? []).filter(p => p.kind === kind).sort((a, b) => Number(a.cleared) - Number(b.cleared) || b.ply - a.ply)
  return card([
    el('h2', 'font-display text-lg', TITLE[kind]),
    items.length
      ? rowList(
          items.slice(0, 20).map(p =>
            listRow(`#/practice/${encodeURIComponent(p.id)}`, [
              el('div', 'min-w-0 flex-1', [
                el('p', 'font-medium', `Move ${Math.ceil(p.ply / 2)}, ${pawns(p.startCp)}`),
                el('p', 'text-xs text-dim', p.attempts ? `${p.attempts} ${p.attempts === 1 ? 'try' : 'tries'}` : 'Not tried yet'),
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
          'mt-3 -mx-4 sm:-mx-5',
        )
      : el('p', 'mt-3 text-sm text-dim', 'None in analyzed games yet.'),
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
  return boardScreen({
    title,
    back: () => ctrl.back('drills'),
    board: board(`${p.id}:${p.attempts}`, e => run.mount(e)),
    side: [
      el('p', 'text-sm', goal),
      el('div', 'flex gap-6 text-sm', [
        el('div', [el('p', 'text-xs text-dim', 'Target'), el('p', 'font-medium tabular-nums', { attrs: { title: targetNote } }, target)]),
        el('div', [el('p', 'text-xs text-dim', 'Eval'), el('p', 'font-medium tabular-nums', pawns(run.cp))]),
        el('div', [el('p', 'text-xs text-dim', 'Your moves'), el('p', 'font-medium tabular-nums', String(run.moves))]),
        run.last ? el('div', [el('p', 'text-xs text-dim', `${run.lastBy} played`), el('p', 'font-medium', run.last)]) : null,
      ]),
      done
        ? el('div', 'space-y-3', [
            el('p', 'font-display text-xl', { class: { 'text-accent': run.state === 'won', 'text-bad': run.state === 'lost' } }, p.kind === 'conversion' ? (run.state === 'won' ? 'Converted' : 'Not converted') : run.state === 'won' ? 'Held' : 'Not held'),
            el('div', 'flex gap-2', [button('Try again', () => ctrl.retryPractice()), button('All drills', () => ctrl.go('drills'), 'plain')]),
          ])
        : el('div', 'space-y-2', [
            el('p', 'text-sm text-dim', run.state === 'thinking' ? `${run.opponent} is thinking…` : 'Your move.'),
            // Same rule as the drill: typing is for keyboards
            el('div', 'hidden md:block', [moveInput(t => run.typeMove(t))]),
          ]),
    ],
  })
}
