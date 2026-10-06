import { h, type VNode } from 'snabbdom'
import { el } from './el'
import type { Ctrl } from './ctrl'
import type { Drill } from './drill'

export function view(ctrl: Ctrl): VNode {
  return el('div', 'min-h-screen', [
    el('header', 'flex items-center gap-6 border-b border-raised px-6 py-3', [
      el('a', 'font-display text-xl font-bold', { attrs: { href: '#' }, on: { click: () => ctrl.go('today') } }, 'lidrill'),
      nav(ctrl, 'today', 'Today'),
      nav(ctrl, 'sync', 'Sync'),
    ]),
    el('main', 'mx-auto max-w-4xl p-6', [
      ctrl.screen === 'today' ? today(ctrl) : ctrl.screen === 'sync' ? sync(ctrl) : drill(ctrl),
    ]),
  ])
}

const nav = (ctrl: Ctrl, screen: 'today' | 'sync', label: string) =>
  el(
    'button',
    'text-sm',
    { class: { 'text-accent': ctrl.screen === screen, 'text-dim': ctrl.screen !== screen }, on: { click: () => ctrl.go(screen) } },
    label,
  )

const button = (label: string, onClick: () => void, primary = true, disabled = false) =>
  el(
    'button',
    'rounded px-4 py-2 font-medium',
    {
      class: { 'bg-accent': primary, 'text-bg': primary, 'bg-raised': !primary, 'opacity-50': disabled },
      attrs: { disabled },
      on: { click: onClick },
    },
    label,
  )

function today(ctrl: Ctrl): VNode {
  const { games, analyzed, puzzles, due } = ctrl.counts
  return el('section', 'space-y-6', [
    el('div', 'rounded-lg bg-surface p-6', [
      el('p', 'text-dim text-sm', 'Due today'),
      el('p', 'font-display text-4xl', `${due} puzzle${due === 1 ? '' : 's'}`),
      due
        ? el('div', 'mt-4', [button(`Start today's ${due}`, () => ctrl.startDrill())])
        : el('p', 'mt-2 text-dim', puzzles ? 'Nothing due. Come back tomorrow.' : 'No puzzles yet. Sync some games first.'),
    ]),
    el('p', 'text-sm text-dim', `${games} games, ${analyzed} analyzed, ${puzzles} puzzles from your mistakes.`),
  ])
}

function sync(ctrl: Ctrl): VNode {
  const p = ctrl.profile
  const field = (id: string, label: string, value = '') =>
    el('label', 'block', [
      el('span', 'text-sm text-dim', label),
      el('input', 'mt-1 block w-full rounded bg-raised px-3 py-2', { attrs: { id, value, autocomplete: 'off', spellcheck: false } }),
    ])
  const read = (id: string) => (document.getElementById(id) as HTMLInputElement).value
  const prog = ctrl.progress
  return el('section', 'max-w-md space-y-4', [
    el('h2', 'font-display text-2xl', 'Your games'),
    el('p', 'text-sm text-dim', 'Usernames only. Games stay in this browser.'),
    field('li-user', 'Lichess username', p?.lichessUser),
    field('cc-user', 'Chess.com username', p?.chesscomUser),
    el('div', 'flex gap-3', [
      button(ctrl.syncing ? 'Syncing…' : 'Sync', () => ctrl.sync(read('li-user'), read('cc-user')), true, ctrl.syncing),
      ctrl.syncing ? button('Stop', () => ctrl.stopSync(), false) : null,
    ]),
    ctrl.status ? el('p', 'text-sm', ctrl.status) : null,
    prog && prog.total
      ? h('div', [
          el('div', 'h-2 rounded bg-raised', [el('div', 'h-2 rounded bg-accent', { style: { width: `${(100 * prog.done) / prog.total}%` } })]),
          el('p', 'mt-1 text-xs text-dim', `${prog.done} / ${prog.total} games analyzed`),
        ])
      : null,
    p ? el('p', 'text-sm text-dim', `Band: ${p.band}. Puzzles start at a ${p.swingThresholdCp} cp swing.`) : null,
  ])
}

function drill(ctrl: Ctrl): VNode {
  const d = ctrl.drill
  if (!d) return el('p', 'text-dim', 'Loading…')
  return el('section', 'grid gap-6 md:grid-cols-[minmax(0,1fr)_18rem]', [
    el('div', 'cg-wrap aspect-square w-full', {
      key: d.puzzle.id,
      hook: { insert: v => d.mount(v.elm as HTMLElement) },
    }),
    el('aside', 'space-y-4', [el('p', 'text-sm text-dim', `${ctrl.queueLeft} left after this one`), side(ctrl, d)]),
  ])
}

function context(d: Drill): VNode | null {
  const g = d.game
  if (!g) return null
  const moveNo = Math.ceil(d.puzzle.ply / 2)
  return el('p', 'text-sm text-dim', [
    `${g.opening || 'Your game'}, move ${moveNo}. `,
    el('a', 'underline', { attrs: { href: g.url, target: '_blank', rel: 'noopener' } }, 'Open game'),
  ])
}

function side(ctrl: Ctrl, d: Drill): VNode {
  if (d.state === 'playing')
    return el('div', 'space-y-2', [
      el('p', 'font-display text-xl', `Find the best move for ${d.color}`),
      d.step > 0 ? el('p', 'text-sm text-accent', 'Good. Keep going.') : null,
      context(d),
    ])
  const solved = d.state === 'solved'
  const best = d.sanAt(d.puzzle.solution[0])
  return el('div', 'space-y-3', [
    el('p', 'font-display text-xl', { class: { 'text-accent': solved, 'text-bad': !solved } }, solved ? 'Solved' : `Best was ${best}`),
    context(d),
    el('p', 'text-sm', `In the game you played ${d.sanAt(d.puzzle.played)}, which cost about ${(d.puzzle.swingCp / 100).toFixed(1)} pawns.`),
    solved
      ? null
      : el('label', 'block', [
          el('span', 'text-sm text-dim', 'Why did you miss it?'),
          el('textarea', 'mt-1 block w-full rounded bg-raised px-3 py-2', {
            attrs: { rows: 2, placeholder: 'e.g. didn\'t check his checks' },
            on: { change: e => ctrl.saveWhy((e.target as HTMLTextAreaElement).value) },
          }),
        ]),
    button(ctrl.queueLeft ? 'Next' : 'Done', () => ctrl.next()),
  ])
}
