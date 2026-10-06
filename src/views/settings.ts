import type { VNode } from 'snabbdom'
import { SCOPES } from '../auth'
import type { Ctrl } from '../ctrl'
import { el } from '../el'
import { PREFERENCE_SCOPE } from '../lichess/api'
import { STUDY_SCOPE } from '../lichess/study'
import { BOARDS, DEFAULT_BOARD, DEFAULT_PIECES, PIECE_SETS } from '../look'
import { button, card, label } from './ui'
import { chesscomField } from './welcome'

// What each Lichess permission is used for
const SCOPE_WHY: Record<string, string> = {
  'puzzle:read': 'Read your puzzle dashboard and history, to find weak themes and puzzles you missed.',
  [STUDY_SCOPE]: 'Create private studies when you press "Send to Lichess study".',
  [PREFERENCE_SCOPE]: 'Read your board and piece set, once, when you press "Use my Lichess look".',
}

const choice = (selected: boolean, onClick: () => void, children: (VNode | string)[]) =>
  el(
    'button',
    'flex min-h-11 flex-col items-center gap-1 rounded-lg border-2 p-2 text-xs',
    { attrs: { type: 'button', 'aria-pressed': selected }, class: { 'border-accent': selected, 'border-transparent': !selected, 'bg-raised': true }, on: { click: onClick } },
    children,
  )

export function settingsView(ctrl: Ctrl): VNode {
  const p = ctrl.profile
  const pieces = p?.pieces ?? DEFAULT_PIECES
  const boardKey = p?.board ?? DEFAULT_BOARD
  const theme = p?.theme ?? 'dark'
  return el('div', 'mx-auto max-w-xl space-y-4', [
    el('h1', 'font-display text-2xl', 'Settings'),
    card(
      [
        label('Look'),
        el('div', 'grid grid-cols-2 gap-2', [
          choice(theme === 'dark', () => ctrl.setLook({ theme: 'dark' }), ['Dark']),
          choice(theme === 'light', () => ctrl.setLook({ theme: 'light' }), ['Light']),
        ]),
        el('p', 'text-sm text-dim', 'Pieces'),
        el(
          'div',
          'grid grid-cols-3 gap-2 sm:grid-cols-5',
          PIECE_SETS.map(s =>
            choice(pieces === s.key, () => ctrl.setLook({ pieces: s.key }), [
              el('span', 'flex', [
                el('span', 'piece-preview', { style: { backgroundImage: `url('/pieces/${s.key}/wN.svg')` } }),
                el('span', 'piece-preview', { style: { backgroundImage: `url('/pieces/${s.key}/bQ.svg')` } }),
              ]),
              s.name,
            ]),
          ),
        ),
        el('p', 'text-sm text-dim', 'Board'),
        el(
          'div',
          'grid grid-cols-4 gap-2',
          BOARDS.map(b =>
            choice(boardKey === b.key, () => ctrl.setLook({ board: b.key }), [el('span', `board-swatch board-${b.key}`), b.name]),
          ),
        ),
        ctrl.auth ? button('Use my Lichess look', () => ctrl.useLichessLook(), 'plain') : null,
      ],
      'space-y-3',
    ),
    card(
      [
        label('Plan'),
        el('form', 'space-y-2', { on: { submit: e => (e.preventDefault(), savePlan(ctrl)) } }, [
          el('label', 'block text-sm', { attrs: { for: 'when' } }, 'When you do your daily puzzles'),
          el('input', 'min-h-11 w-full rounded-lg bg-raised px-3', { attrs: { id: 'when', value: p?.trainingTime ?? '', placeholder: 'e.g. after dinner', autocomplete: 'off' } }),
          el('label', 'block text-sm', { attrs: { for: 'rep' } }, 'Openings to aim for (comma separated; empty picks them for you)'),
          el('input', 'min-h-11 w-full rounded-lg bg-raised px-3', {
            attrs: { id: 'rep', value: p?.repertoire?.join(', ') ?? '', placeholder: 'e.g. Italian Game, Caro-Kann Defense', autocomplete: 'off' },
          }),
          el('button', 'min-h-11 rounded-lg bg-raised px-4 font-medium', { attrs: { type: 'submit' } }, 'Save'),
        ]),
      ],
      'space-y-3',
    ),
    ctrl.auth
      ? card(
          [
            label('Lichess'),
            el('p', 'text-sm', `Signed in as ${ctrl.auth.username}. Games, ratings and the opening book need no extra permission.`),
            el(
              'ul',
              'space-y-2 text-sm',
              [...new Set([...SCOPES, ...ctrl.auth.scopes])].map(s =>
                el('li', [el('span', 'font-mono text-xs text-dim', s), el('p', '', SCOPE_WHY[s] ?? '')]),
              ),
            ),
            el('p', 'text-xs text-dim', 'Other permissions are asked for only when you use the feature that needs them.'),
            button('Sign out', () => ctrl.signOut(), 'plain'),
          ],
          'space-y-3',
        )
      : card([label('Lichess'), el('p', 'text-sm text-dim', 'Sign in to add your Lichess games.'), button('Sign in with Lichess', () => ctrl.signIn())], 'space-y-3'),
    card([label('Chess.com'), chesscomField(ctrl, p?.chesscomUser ? 'Save' : 'Add')], 'space-y-3'),
    card(
      [
        label('Your data'),
        el('p', 'text-sm text-dim', 'Everything lives in this browser. Export it to keep a copy or move to another device. The Lichess sign-in is never in the file.'),
        el('div', 'flex flex-wrap gap-2', [
          button('Export', () => ctrl.exportFile(), 'plain'),
          el('label', 'inline-flex min-h-11 cursor-pointer items-center rounded-lg bg-raised px-4 font-medium', [
            'Import',
            el('input', 'hidden', {
              attrs: { type: 'file', accept: 'application/json,.json' },
              on: { change: e => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) ctrl.importFile(f) } },
            }),
          ]),
          button('Delete everything', () => ctrl.deleteEverything(), 'quiet'),
        ]),
      ],
      'space-y-3',
    ),
    el('p', 'px-1 text-xs text-dim', 'lidrill is open source under the GPL. Stockfish 19 runs in your browser.'),
  ])
}

function savePlan(ctrl: Ctrl) {
  const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value.trim()
  const rep = val('rep').split(',').map(s => s.trim()).filter(Boolean)
  ctrl.setPlan({ trainingTime: val('when') || undefined, repertoire: rep.length ? rep : undefined })
  ctrl.notice = { text: 'Saved.' }
}
