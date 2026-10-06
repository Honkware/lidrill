import type { VNode } from 'snabbdom'
import type { Ctrl } from '../ctrl'
import type { Drill } from '../drill'
import { el } from '../el'
import { board, button, icon, moveInput, pawnsWorth, plural, topBar } from './ui'

export function drillView(ctrl: Ctrl): VNode {
  const d = ctrl.drill
  if (!d) return el('p', 'p-4 text-dim', 'Loading…')
  const title = ctrl.queueLeft ? `${plural(ctrl.queueLeft, 'puzzle')} left after this` : 'Last one today'
  return el('div', 'md:grid md:grid-cols-[auto_minmax(0,1fr)] md:gap-6 md:pt-4', [
    el('div', [el('div', 'md:hidden', [topBar(title, () => ctrl.go('today'))]), board(d.puzzle.id, e => d.mount(e))]),
    el('aside', 'space-y-4 px-4 pb-8 pt-3 md:px-0 md:pt-0', [el('div', 'hidden md:block', [topBar(title, () => ctrl.go('today'))]), side(ctrl, d)]),
  ])
}

export function drillContext(d: Drill): VNode | null {
  const p = d.puzzle
  if (p.source === 'lichess')
    return el('p', 'text-sm text-dim', [
      `Lichess puzzle${p.rating ? `, rated ${p.rating}` : ''}. `,
      el('a', 'underline', { attrs: { href: `https://lichess.org/training/${p.id.replace('lichess:', '')}`, target: '_blank', rel: 'noopener' } }, 'Open on Lichess'),
    ])
  const g = d.game
  if (!g) return null
  return el('p', 'text-sm text-dim', [
    `${g.opponent ? `vs ${g.opponent}, ` : ''}${g.opening || 'your game'}, move ${Math.ceil(p.ply / 2)}. `,
    el('a', 'underline', { attrs: { href: `#/game/${encodeURIComponent(g.id)}` } }, 'See the game'),
  ])
}

// The prompt and feedback under the board, shared with Turning Points
export function puzzleSide(d: Drill, after: VNode[]): VNode {
  if (d.state === 'playing')
    return el('div', 'space-y-3', [
      el('p', 'font-display text-xl', d.puzzle.alternatives ? `Find a move that holds for ${d.color}` : `Find the best move for ${d.color}`),
      d.puzzle.alternatives && d.step === 0 ? el('p', 'text-sm text-dim', `In the game your move lost material. ${d.puzzle.alternatives.length} moves would have kept the position.`) : null,
      d.step > 0 ? el('p', 'text-sm text-accent', 'Good. Keep going.') : null,
      drillContext(d),
      moveInput(t => d.typeMove(t)),
      d.hinted
        ? el('p', 'text-sm text-warn', 'The highlighted piece moves. A solve now counts as a hard one.')
        : el('button', 'inline-flex min-h-11 items-center gap-2 rounded-lg px-1 text-dim', { attrs: { type: 'button' }, on: { click: () => d.hint() } }, [icon('hint', 18), 'Hint']),
    ])
  const solved = d.state === 'solved'
  const p = d.puzzle
  return el('div', 'space-y-3', [
    el(
      'p',
      'font-display text-xl',
      { class: { 'text-accent': solved, 'text-bad': !solved } },
      solved ? (d.hinted ? 'Solved with the hint' : 'Solved') : p.alternatives ? `${d.holdingSans.join(' or ')} held` : `Best was ${d.sanAt(p.solution[0])}`,
    ),
    solved && p.alternatives ? el('p', 'text-sm text-dim', `Any of ${d.holdingSans.join(', ')} would do.`) : null,
    drillContext(d),
    p.played ? el('p', 'text-sm', `In the game you played ${d.sanAt(p.played)}, which gave away about ${pawnsWorth(p.swingCp)}.`) : null,
    ...after,
  ])
}

function side(ctrl: Ctrl, d: Drill): VNode {
  return puzzleSide(d, [
    d.state === 'failed' && d.puzzle.source !== 'lichess'
      ? el('label', 'block', [
          el('span', 'text-sm text-dim', 'Why did you miss it?'),
          el('textarea', 'mt-1 block w-full rounded-lg bg-raised px-3 py-2', {
            attrs: { rows: 2, placeholder: "e.g. didn't check his checks" },
            on: { change: e => ctrl.saveWhy((e.target as HTMLTextAreaElement).value) },
          }),
        ])
      : null,
    el('div', 'grid', [button(ctrl.queueLeft ? 'Next' : 'Done', () => ctrl.next())]),
  ] as VNode[])
}
