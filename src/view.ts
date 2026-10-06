import { h, type VNode } from 'snabbdom'
import { el } from './el'
import type { Ctrl } from './ctrl'
import type { Drill } from './drill'

export function view(ctrl: Ctrl): VNode {
  const signedIn = ctrl.screen !== 'welcome'
  return el('div', 'min-h-screen', [
    el('header', 'flex items-center gap-6 border-b border-raised px-6 py-3', [
      el('a', 'font-display text-xl font-bold', { attrs: { href: '#' }, on: { click: () => signedIn && ctrl.go('today') } }, 'lidrill'),
      signedIn ? nav(ctrl, 'today', 'Today') : null,
      signedIn ? nav(ctrl, 'sync', 'Games') : null,
      ctrl.auth
        ? el('div', 'ml-auto flex items-center gap-3 text-sm', [
            el('span', 'text-dim', ctrl.auth.username),
            el('button', 'text-dim underline', { on: { click: () => ctrl.signOut() } }, 'Sign out'),
          ])
        : null,
    ]),
    el('main', 'mx-auto max-w-4xl p-6', [
      !ctrl.loaded
        ? null
        : ctrl.screen === 'welcome'
          ? welcome(ctrl)
          : ctrl.screen === 'today'
            ? today(ctrl)
            : ctrl.screen === 'sync'
              ? sync(ctrl)
              : drill(ctrl),
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
        : el(
            'p',
            'mt-2 text-dim',
            puzzles
              ? 'Nothing due. Come back tomorrow.'
              : ctrl.syncing
                ? 'Going through your games now. The first puzzles show up here within a few minutes.'
                : 'No puzzles yet. Sync your games first.',
          ),
    ]),
    ctrl.error ? el('p', 'text-sm text-bad', ctrl.error) : null,
    el('p', 'text-sm text-dim', `${games} games, ${analyzed} analyzed, ${puzzles} puzzles from your mistakes.`),
  ])
}

const chesscomField = (ctrl: Ctrl, label: string) =>
  el('form', 'flex gap-2', { on: { submit: e => (e.preventDefault(), ctrl.setChesscom(readInput('cc-user'))) } }, [
    el('input', 'min-w-0 flex-1 rounded bg-raised px-3 py-2', {
      attrs: { id: 'cc-user', value: ctrl.profile?.chesscomUser ?? '', placeholder: 'Chess.com username', autocomplete: 'off', spellcheck: false },
    }),
    el('button', 'rounded bg-raised px-4 py-2 font-medium', { attrs: { type: 'submit' } }, label),
  ])

const readInput = (id: string) => (document.getElementById(id) as HTMLInputElement).value

function welcome(ctrl: Ctrl): VNode {
  return el('section', 'max-w-md space-y-5 pt-8', [
    el('h1', 'font-display text-3xl', 'Puzzles from your own mistakes'),
    el(
      'p',
      'text-dim',
      'lidrill goes through your Lichess games with Stockfish, finds the moves that cost you, and gives them back as a few puzzles a day.',
    ),
    button('Sign in with Lichess', () => ctrl.signIn()),
    ctrl.status ? el('p', 'text-sm text-bad', ctrl.status) : null,
    el('p', 'text-sm text-dim', 'Your games and puzzles stay in this browser. lidrill has no server and no account of its own.'),
    el('details', 'text-sm', [
      el('summary', 'cursor-pointer text-dim', 'Only play on Chess.com?'),
      el('div', 'mt-3 space-y-2', [
        el('p', 'text-dim', 'Chess.com games are public, so a username is enough.'),
        chesscomField(ctrl, 'Import'),
      ]),
    ]),
  ])
}

function sync(ctrl: Ctrl): VNode {
  const p = ctrl.profile
  const prog = ctrl.progress
  return el('section', 'max-w-md space-y-8', [
    el('div', 'space-y-4', [
      el('h2', 'font-display text-2xl', 'Your games'),
      ctrl.auth
        ? el('p', 'text-sm text-dim', `Lichess games for ${ctrl.auth.username}. New games come in each time you open lidrill.`)
        : el('div', 'flex items-center gap-3', [
            button('Sign in with Lichess', () => ctrl.signIn()),
            el('span', 'text-sm text-dim', 'to add your Lichess games'),
          ]),
      el('div', 'flex gap-3', [
        button(ctrl.syncing ? 'Syncing…' : 'Sync now', () => ctrl.sync(), true, ctrl.syncing),
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
    ]),
    el('div', 'space-y-3 border-t border-raised pt-6', [
      el('h3', 'font-display text-lg', 'Chess.com'),
      el(
        'p',
        'text-sm text-dim',
        p?.chesscomUser
          ? `Also importing games for ${p.chesscomUser}. Clear the name to stop.`
          : 'Play there too? Add your username and those games get drilled as well.',
      ),
      chesscomField(ctrl, p?.chesscomUser ? 'Save' : 'Add'),
    ]),
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
