import type { VNode, VNodeChildren } from 'snabbdom'
import { accuracy } from '../analysis/accuracy'
import type { Ctrl, ReviewRow } from '../ctrl'
import type { Game } from '../db'
import { el } from '../el'
import type { GameView } from '../gameview'
import { deviation } from '../lichess/repertoire'
import { board, boardScreen, btnClass, button, card, dateLabel, empty, icon, judgColor, judgMark, label, listRow, loading, loadingBlock, plural, resultChip, rowList } from './ui'
import { journalHangParts } from '../server/surface'
import { moveTable, score } from './moves'

export function reviewView(ctrl: Ctrl): VNode {
  const rows = ctrl.reviewList
  const openings = ctrl.today?.openings ?? []
  return el('div', 'mx-auto max-w-2xl space-y-3', [
    el('h1', 'font-display text-2xl', 'Review'),
    !rows
      ? loadingBlock('h-96')
      : !rows.length
        ? empty(ctrl.syncing ? 'Analyzing games. Each one appears here when done.' : 'No analyzed games yet.')
        : rowList(rows.map(r => row(r)), 'overflow-hidden rounded-xl bg-surface'),
    openings.length ? openingsCard(openings) : null,
  ])
}

// Per-opening record, moved off the home screen: win/draw/loss and how
// often a game had something given away
function openingsCard(rows: NonNullable<Ctrl['today']>['openings']): VNode {
  return card(
    [
      label('Openings'),
      el('div', 'mt-2 -mx-1 overflow-x-auto', [
        el('table', 'w-full min-w-[20rem] text-sm', [
          el('thead', [
            el('tr', 'text-left text-xs text-dim', [
              el('th', 'px-1 py-1 font-normal', 'Opening'),
              el('th', 'px-1 py-1 text-right font-normal', 'Games'),
              el('th', 'px-1 py-1 text-right font-normal', 'W / D / L'),
              el('th', 'px-1 py-1 text-right font-normal', 'With a hang'),
            ]),
          ]),
          el(
            'tbody',
            rows.map(r =>
              el('tr', 'border-t border-raised', [
                el('td', 'max-w-[12rem] truncate px-1 py-2', r.family),
                el('td', 'px-1 py-2 text-right tabular-nums', String(r.games)),
                el('td', 'px-1 py-2 text-right tabular-nums', `${r.win} / ${r.draw} / ${r.loss}`),
                el('td', 'px-1 py-2 text-right tabular-nums', { class: { 'text-dim': !r.analyzed } }, r.analyzed ? `${r.hangs} of ${r.analyzed}` : 'not analyzed'),
              ]),
            ),
          ),
        ]),
      ]),
    ],
  )
}

function row(r: ReviewRow): VNode {
  const g = r.game
  const marks = (['blunder', 'mistake', 'inaccuracy'] as const).filter(j => r[j])
  return listRow(`#/game/${encodeURIComponent(g.id)}`, [
    resultChip(g.result),
    el('div', 'min-w-0 flex-1', [
      el('p', 'truncate font-medium', [g.opponent ? `vs ${g.opponent}` : g.opening || 'Game', g.opponentRating ? el('span', 'font-normal text-dim', ` ${g.opponentRating}`) : '']),
      el('p', 'truncate text-sm text-dim', `${g.opening ? `${g.opening.split(':')[0]} · ` : ''}${g.speed} · ${dateLabel(g.playedAt)}`),
    ]),
    el('div', 'flex shrink-0 flex-col items-end gap-1 text-sm', [
      el(
        'p',
        'flex gap-2 tabular-nums',
        marks.length ? marks.map(j => el('span', judgColor[j], `${r[j]}${judgMark[j]}`)) : [el('span', 'text-accent', 'clean')],
      ),
      r.journal && !r.journal.hung ? (marks.length ? el('p', 'text-xs text-accent', 'clean game') : null) : r.puzzles ? el('p', 'text-xs text-dim', plural(r.puzzles, 'puzzle')) : null,
    ]),
  ])
}

export function gameView(ctrl: Ctrl): VNode {
  const v = ctrl.gameView
  if (!v) return loading()
  const g = v.game
  return boardScreen({
    title: g.opponent ? `vs ${g.opponent}` : 'Game',
    back: () => ctrl.back('review'),
    board: board(g.id, e => v.mount(e)),
    controls: controls(v),
    side: [
      el('p', 'text-sm text-dim', `${g.result === 'win' ? 'Won' : g.result === 'loss' ? 'Lost' : 'Drew'} as ${g.color} · ${g.opening || g.eco || 'unknown opening'} · ${dateLabel(g.playedAt)}`),
      advice(v),
      studyNote(ctrl, v),
      moveList(v),
      journalCard(ctrl, v),
      el('div', 'flex flex-wrap gap-2', [
        v.puzzles.length ? button(`Replay ${plural(v.puzzles.length, 'turning point')}`, () => ctrl.go('replay', g.id)) : null,
        v.puzzles.length && ctrl.auth && g.site === 'lichess' ? button('Send to Lichess study', () => ctrl.sendStudy(g.id), 'plain') : null,
        g.url
          ? el('a', btnClass('quiet'), { attrs: { href: g.url, target: '_blank', rel: 'noopener' } }, [
              `Open on ${g.site === 'lichess' ? 'Lichess' : 'Chess.com'}`,
              icon('external', 16),
            ])
          : null,
      ]),
    ],
  })
}

// Disabled when it would not move, as Lichess's are at either end
const navButton = (name: string, labelText: string, to: number, v: GameView) =>
  el(
    'button',
    `${btnClass('plain', 'fill')} flex-1`,
    { attrs: { type: 'button', 'aria-label': labelText, disabled: to === v.ply }, on: { click: () => v.go(to) } },
    [icon(name)],
  )

function controls(v: GameView): VNode {
  const end = v.game.moves.length
  return el('div', 'flex gap-2', [
    navButton('first', 'Start position', 0, v),
    navButton('prev', 'Previous move', Math.max(0, v.ply - 1), v),
    navButton('next', 'Next move', Math.min(end, v.ply + 1), v),
    navButton('last', 'Last move', end, v),
  ])
}

const ADVICE = [
  ['inaccuracy', 'inaccuracies'],
  ['mistake', 'mistakes'],
  ['blunder', 'blunders'],
] as const

// The player's side of Lichess's advice summary (lila
// ui/analyse/src/view/roundTraining.ts): a count per judgment, and a click
// steps through those moves
function advice(v: GameView): VNode | null {
  if (!v.game.analyzedAt) return null
  return el('div', [
    label('Your moves'),
    el('div', 'mt-2 flex flex-wrap gap-x-1 rounded-xl bg-surface p-1 text-sm', [
      accuracyItem(v.game),
      ...ADVICE.map(([j, many]) => {
        const n = v.judged(j).length
        const text = [el('strong', 'tabular-nums', String(n)), ` ${n === 1 ? j : many}`]
        // Coloured by judgment, as Lichess draws its advice summary
        return n
          ? el('button', `rounded-lg px-3 py-2 hover:bg-raised ${judgColor[j]}`, { attrs: { type: 'button' }, on: { click: () => v.nextJudged(j) } }, text)
          : el('span', 'px-3 py-2 text-dim opacity-60', text)
      }),
    ]),
  ])
}

// The player's then the opponent's, with Lichess's own figure for the
// player when the game was analysed there
function accuracyItem(g: Game): VNode | null {
  const a = accuracy(g.moves)
  const mine = g.accuracy ?? (a && Math.round(a[g.color]))
  if (mine === undefined) return null
  const theirs = a && Math.round(a[g.color === 'white' ? 'black' : 'white'])
  const title =
    g.accuracy === undefined
      ? "Yours, then your opponent's, worked out as Lichess does over the moves with an eval before and after. Book moves have no eval and are left out."
      : "Yours is Lichess's own figure. Your opponent's is worked out as Lichess does over the moves with an eval before and after."
  return el('span', 'px-3 py-2', { attrs: { title } }, [
    'Accuracy ',
    el('strong', 'tabular-nums', `${mine}%`),
    theirs === undefined ? null : el('span', 'tabular-nums text-dim', ` vs ${theirs}%`),
  ])
}

const moveList = (v: GameView) => moveTable(v.game.moves, v.ply, ply => v.go(ply), score(v.game.result, v.game.color))

function journalCard(ctrl: Ctrl, v: GameView): VNode | null {
  const j = v.journal
  if (!j) return null
  // The hang line's words come from the shared validated surface;
  // only the stored SAN renders as a link, and it is never composed here
  const hang = j.hung ? journalHangParts(j.hung) : undefined
  // The move is part of the sentence, so its button is drawn as a link
  const hangRow: VNodeChildren = hang
    ? [hang[0], el('button', 'underline', { attrs: { type: 'button' }, on: { click: () => v.go(j.hung!.ply) } }, hang[1]), hang[2]]
    : 'Nothing given away. Counts toward your streak.'
  return card(
    [
      label('Journal'),
      el('p', '', hangRow),
      el('label', 'flex items-center gap-2 text-sm', [
        el('input', 'size-5 accent-accent', { attrs: { type: 'checkbox' }, props: { checked: j.confirmed }, on: { change: e => ctrl.saveJournal({ confirmed: (e.target as HTMLInputElement).checked }) } }),
        'Correct',
      ]),
      el('textarea', 'block w-full rounded-lg bg-raised px-3 py-2 text-sm', {
        attrs: { rows: 2, placeholder: 'Note: what happened, what to watch for' },
        props: { value: j.note ?? '' },
        on: { change: e => ctrl.saveJournal({ note: (e.target as HTMLTextAreaElement).value }) },
      }),
    ],
    'space-y-3',
  )
}

// Where the game left the player's study repertoire, if they use one
function studyNote(ctrl: Ctrl, v: GameView): VNode | null {
  const study = ctrl.profile?.repertoireStudy
  if (!study) return null
  const d = deviation(v.game, study.lines)
  if (!d) return null
  const moveNo = `${Math.ceil(d.ply / 2)}${d.ply % 2 ? '.' : '...'}`
  const played = v.sanBefore(d.ply, v.game.moves[d.ply - 1].uci)
  const expected = v.sanBefore(d.ply, d.expected)
  // A card that puts the board at the move, so it keeps the card's shape
  return el('button', 'block w-full rounded-xl bg-surface p-3 text-left text-sm', { attrs: { type: 'button' }, on: { click: () => v.go(d.ply - 1) } }, [
    el('span', 'text-dim', `Study "${study.name}": `),
    `left by ${d.byPlayer ? 'you' : 'your opponent'} at ${moveNo}${played}; the study has ${expected}.`,
  ])
}
