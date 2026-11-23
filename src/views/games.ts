import { h, type VNode } from 'snabbdom'
import type { Ctrl } from '../ctrl'
import { el } from '../el'
import { button, card, label } from './ui'
import { whatCountsLink } from './today'
import { chesscomField } from './welcome'

export function gamesView(ctrl: Ctrl): VNode {
  const p = ctrl.profile
  const prog = ctrl.progress
  const { games, analyzed, puzzles } = ctrl.counts
  return el('div', 'mx-auto max-w-xl space-y-4', [
    el('h1', 'font-display text-2xl', 'Your games'),
    card(
      [
        label('Lichess'),
        ctrl.auth
          ? el('p', 'text-sm', `Signed in as ${ctrl.auth.username}.`)
          : el('div', 'space-y-2', [el('p', 'text-sm text-dim', 'Sign in to add your Lichess games.'), button('Sign in with Lichess', () => ctrl.signIn())]),
        el('div', 'flex gap-3', [
          button(ctrl.syncing ? 'Syncing…' : 'Sync now', () => ctrl.sync(), 'primary', ctrl.syncing),
          ctrl.syncing ? button('Stop', () => ctrl.stopSync(), 'plain') : null,
        ]),
        ctrl.status ? el('p', 'text-sm', { class: { 'text-bad': !!ctrl.error } }, ctrl.status) : null,
        prog && prog.total
          ? h('div', [
              el('div', 'h-2 rounded bg-raised', [el('div', 'h-2 rounded bg-accent', { style: { width: `${(100 * prog.done) / prog.total}%` } })]),
              el('p', 'mt-1 text-xs text-dim', `${prog.done} of ${prog.total} games analyzed this run`),
            ])
          : null,
        el('p', 'text-sm text-dim', `${games} games, ${analyzed} analyzed, ${puzzles} puzzles.`),
        p ? el('p', 'text-sm text-dim', [`Level: ${p.band}. `, whatCountsLink()]) : null,
      ],
      'space-y-3',
    ),
    card(
      [
        label('Chess.com'),
        p?.chesscomUser ? el('p', 'text-sm text-dim', `Importing games for ${p.chesscomUser}.`) : null,
        chesscomField(ctrl, p?.chesscomUser ? 'Save' : 'Add'),
      ],
      'space-y-3',
    ),
  ])
}
