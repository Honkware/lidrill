import type { VNode } from 'snabbdom'
import type { Ctrl } from '../ctrl'
import { el } from '../el'
import { btnClass, button } from './ui'

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

export function welcomeView(ctrl: Ctrl): VNode {
  return el('section', 'mx-auto max-w-md space-y-5 pt-6 sm:pt-12', [
    el('h1', 'font-display text-3xl', 'Puzzles from your own mistakes'),
    el(
      'p',
      'text-dim',
      'lidrill goes through your Lichess games with Stockfish, finds the moves that cost you, and gives them back as a few puzzles a day.',
    ),
    el('div', 'grid', [button('Sign in with Lichess', () => ctrl.signIn())]),
    ctrl.status ? el('p', 'text-sm text-bad', ctrl.status) : null,
    el('p', 'text-sm text-dim', 'Your games and puzzles stay in this browser. lidrill has no account of its own.'),
    el('details', 'text-sm', [
      el('summary', 'cursor-pointer py-2 text-dim', 'Chess.com only'),
      el('div', 'mt-2 space-y-2', [el('p', 'text-dim', 'Chess.com games are public, so a username is enough.'), chesscomField(ctrl, 'Import')]),
    ]),
  ])
}
