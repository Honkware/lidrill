import type { VNode } from 'snabbdom'
import type { Ctrl } from '../ctrl'
import { el } from '../el'
import { btnClass, button, card, errorLine } from './ui'

export const chesscomField = (ctrl: Ctrl, label: string) =>
  el(
    'form',
    'flex gap-2',
    { on: { submit: e => (e.preventDefault(), ctrl.setChesscom((document.getElementById('cc-user') as HTMLInputElement).value)) } },
    [
      el('input', 'min-h-11 min-w-0 flex-1 rounded-lg bg-raised px-3', {
        attrs: { id: 'cc-user', value: ctrl.profile?.chesscomUser ?? '', placeholder: 'Chess.com username', autocomplete: 'off', autocapitalize: 'none', spellcheck: false },
      }),
      el('button', btnClass('plain'), { attrs: { type: 'submit' } }, label),
    ],
  )

// The two ways in: Lichess sign-in, or a Chess.com username alone
const signIn = (ctrl: Ctrl): (VNode | null)[] => [
  el('div', 'grid', [button('Sign in with Lichess', () => ctrl.signIn())]),
  ctrl.status ? errorLine(ctrl.status) : null,
  el('p', 'text-sm text-dim', 'Your games and puzzles stay in this browser.'),
  el('details', 'text-sm', [
    el('summary', 'cursor-pointer py-2 text-dim', 'Chess.com only'),
    el('div', 'mt-2', [chesscomField(ctrl, 'Import')]),
  ]),
]

export function welcomeView(ctrl: Ctrl): VNode {
  return el('section', 'mx-auto max-w-md space-y-5 pt-6 sm:pt-12', [el('h1', 'font-display text-3xl', 'Puzzles from your own mistakes'), ...signIn(ctrl)])
}

// The same sign-in beside the sample puzzles
export const ownGamesCard = (ctrl: Ctrl): VNode => card([el('h2', 'font-display text-xl', 'Train on your own games'), ...signIn(ctrl)], 'space-y-3')
