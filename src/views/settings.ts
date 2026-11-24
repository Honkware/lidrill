import type { VNode } from 'snabbdom'
import { SCOPES } from '../auth'
import type { Ctrl } from '../ctrl'
import { el } from '../el'
import { PREFERENCE_SCOPE } from '../lichess/api'
import { STUDY_READ_SCOPE } from '../lichess/repertoire'
import { STUDY_SCOPE } from '../lichess/study'
import { BOARDS, DEFAULT_BOARD, DEFAULT_PIECES, PIECE_SETS } from '../look'
import { setSound, soundOn } from '../sound'
import { btnClass, button, card, HANG_RULE, label, segmented } from './ui'
import { chesscomField, syncCodeField } from './welcome'

const LEVEL_NAME = { beginner: 'Beginner', club: 'Club', advanced: 'Advanced' } as const

// What each Lichess permission is used for
const SCOPE_WHY: Record<string, string> = {
  'puzzle:read': 'Read your puzzle dashboard and history, to find weak themes and puzzles you missed.',
  [STUDY_SCOPE]: 'Create private studies when you press "Send to Lichess study".',
  [PREFERENCE_SCOPE]: 'Read your board and piece set, once, when you press "Use my Lichess look".',
  [STUDY_READ_SCOPE]: 'Read your studies, when you pick one as your repertoire.',
}

// Tiles rather than buttons, since each shows a preview and the border
// marks the one in use
const choice = (selected: boolean, onClick: () => void, children: (VNode | string)[]) =>
  el(
    'button',
    'flex min-h-11 flex-col items-center gap-1 rounded-lg border-2 p-2 text-xs',
    { attrs: { type: 'button', 'aria-pressed': selected }, class: { 'border-accent': selected, 'border-transparent': !selected, 'bg-raised': true }, on: { click: onClick } },
    children,
  )

// Sync for a player with no Lichess account: this device's code, or the
// field for another device's
function devices(ctrl: Ctrl): (VNode | null)[] {
  const code = ctrl.syncCode
  if (code)
    return [
      el('p', 'text-sm text-dim', 'Enter this code on your other device to keep puzzles and opening progress in step.'),
      el('p', 'select-all break-all rounded-lg bg-raised px-3 py-2 font-mono text-sm', code),
      el('p', 'text-sm text-dim', 'Anyone with the code can read and change this data, so keep it to yourself.'),
      button('Stop syncing on this device', () => ctrl.stopSyncCode(), 'plain'),
    ]
  return [
    el('p', 'text-sm text-dim', 'Without a Lichess account, a sync code keeps your puzzles and opening progress in step across devices.'),
    el('div', 'grid', [button('Get a sync code', () => ctrl.startSyncCode(), 'plain')]),
    syncCodeField(ctrl),
  ]
}

export function settingsView(ctrl: Ctrl): VNode {
  const p = ctrl.profile
  const pieces = p?.pieces ?? DEFAULT_PIECES
  const boardKey = p?.board ?? DEFAULT_BOARD
  const theme = p?.theme ?? 'dark'
  const perf = ctrl.today?.puzzlePerf
  const weak = p?.weakThemes ?? []
  return el('div', 'mx-auto max-w-xl space-y-4', [
    el('h1', 'font-display text-2xl', 'Settings'),
    card(
      [
        label('What counts'),
        el('p', 'text-sm text-dim', 'A streak game is one with nothing given away. At each level:'),
        ...(['beginner', 'club', 'advanced'] as const).map(b =>
          el('p', 'text-sm', { class: { 'text-dim': p?.band !== b } }, [el('strong', '', `${LEVEL_NAME[b]}${p?.band === b ? ', your level' : ''}: `), HANG_RULE[b]]),
        ),
      ],
      'space-y-2',
    ),
    card(
      [
        label('Look'),
        segmented('Theme', [['dark', 'Dark'], ['light', 'Light']], theme, t => ctrl.setLook({ theme: t })),
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
        el('p', 'text-sm text-dim', 'Sounds'),
        segmented('Sounds', [['on', 'On'], ['off', 'Off']], soundOn() ? 'on' : 'off', v => { setSound(v === 'on'); ctrl.redraw() }),
      ],
      'space-y-3',
    ),
    ctrl.auth
      ? card(
          [
            label('Lichess'),
            el('p', 'text-sm', `Signed in as ${ctrl.auth.username}.`),
            perf
              ? el('p', 'text-sm', [
                  `Puzzle performance ${perf.now}`,
                  perf.delta ? el('span', 'text-dim', ` (${perf.delta > 0 ? '+' : ''}${perf.delta} since last week)`) : '',
                  ', last 90 days.',
                ])
              : null,
            weak.length
              ? el('div', [
                  el('p', 'text-sm text-dim', 'Weakest themes'),
                  el('div', 'mt-2 flex flex-wrap gap-2', weak.slice(0, 6).map(w => el('span', 'rounded-full bg-raised px-3 py-1 text-sm', `${w.name} ${w.performance}`))),
                ])
              : null,
            el(
              'ul',
              'space-y-2 text-sm',
              [...new Set([...SCOPES, ...ctrl.auth.scopes])].map(s =>
                el('li', [el('span', 'font-mono text-xs text-dim', s), el('p', '', SCOPE_WHY[s] ?? '')]),
              ),
            ),
            button('Sign out', () => ctrl.signOut(), 'plain'),
          ],
          'space-y-3',
        )
      : card([label('Lichess'), el('p', 'text-sm text-dim', 'Sign in to add your Lichess games.'), button('Sign in with Lichess', () => ctrl.signIn())], 'space-y-3'),
    card([label('Chess.com'), chesscomField(ctrl, p?.chesscomUser ? 'Save' : 'Add')], 'space-y-3'),
    ctrl.auth ? null : card([label('Your devices'), ...devices(ctrl)], 'space-y-3'),
    card(
      [
        label('Your data'),
        el('p', 'text-sm text-dim', "Your games, puzzles and progress are stored in this browser. Signed in with Lichess, or with a sync code, they are also kept on lidrill's server, which is how a second device catches up. Two things are sent either way, without your name: \"Why?\" sends the puzzle's position and Stockfish's lines through the server to an AI model (via OpenRouter), and an analyzed game's moves and evals are kept there so the same game is not analyzed twice. Visits are counted with a hash of your address that changes every day; the address itself is not kept."),
        el('div', 'flex flex-wrap gap-2', [
          button('Export', () => ctrl.exportFile(), 'plain'),
          el('label', `${btnClass('plain')} cursor-pointer`, [
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
    el('p', 'px-1 text-xs text-dim', 'lidrill is open source under the AGPL. Stockfish 19 runs in your browser.'),
  ])
}

