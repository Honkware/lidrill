import type { VNode } from 'snabbdom'
import { SCOPES } from '../auth'
import type { Ctrl } from '../ctrl'
import { el } from '../el'
import { PREFERENCE_SCOPE } from '../lichess/api'
import { STUDY_READ_SCOPE } from '../lichess/repertoire'
import { STUDY_SCOPE } from '../lichess/study'
import { BOARDS, DEFAULT_BOARD, DEFAULT_PIECES, PIECE_SETS } from '../look'
import { button, card, label } from './ui'
import { chesscomField } from './welcome'

// What each Lichess permission is used for
const SCOPE_WHY: Record<string, string> = {
  'puzzle:read': 'Read your puzzle dashboard and history, to find weak themes and puzzles you missed.',
  [STUDY_SCOPE]: 'Create private studies when you press "Send to Lichess study".',
  [PREFERENCE_SCOPE]: 'Read your board and piece set, once, when you press "Use my Lichess look".',
  [STUDY_READ_SCOPE]: 'Read your studies, when you pick one as your repertoire.',
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
        label('Openings plan'),
        el('p', 'text-sm text-dim', 'Today shows how often your games reach these. Pick up to four of the openings you play, or leave them all off and lidrill picks for you.'),
        ctrl.playedFamilies.length
          ? el(
              'div',
              'flex flex-wrap gap-2',
              ctrl.playedFamilies.map(f => {
                const on = !!p?.repertoire?.includes(f)
                return el(
                  'button',
                  'min-h-9 rounded-full border px-3 text-sm',
                  { attrs: { type: 'button', 'aria-pressed': on }, class: { 'border-accent': on, 'text-accent': on, 'border-raised': !on }, on: { click: () => ctrl.toggleRepertoire(f) } },
                  f,
                )
              }),
            )
          : el('p', 'text-sm text-dim', 'Your openings show up here once games are imported.'),
        ctrl.auth ? studyPicker(ctrl) : null,
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


// A Lichess study as the repertoire (study:read, asked for on first use)
function studyPicker(ctrl: Ctrl): VNode {
  const current = ctrl.profile?.repertoireStudy
  return el('div', 'space-y-2 border-t border-raised pt-3', [
    el('p', 'text-sm', current ? `Repertoire from your study "${current.name}" (${current.lines.length} lines).` : 'Or use one of your Lichess studies as your repertoire.'),
    ctrl.studies
      ? el(
          'ul',
          'max-h-60 space-y-1 overflow-y-auto',
          ctrl.studies.map(st =>
            el('li', [el('button', 'min-h-11 w-full rounded-lg bg-raised px-3 text-left text-sm', { attrs: { type: 'button' }, on: { click: () => ctrl.useStudy(st) } }, st.name)]),
          ),
        )
      : el('div', 'flex flex-wrap gap-2', [
          button(current ? 'Pick another study' : 'Pick a study', () => ctrl.loadStudies(), 'plain'),
          current ? button('Stop using it', () => ctrl.useStudy(undefined), 'quiet') : null,
        ]),
  ])
}
