import type { VNode, VNodeChildren } from 'snabbdom'
import { accuracy } from '../analysis/accuracy'
import type { Ctrl } from '../ctrl'
import type { Game } from '../db'
import { el } from '../el'
import type { GameView } from '../gameview'
import { deviation } from '../lichess/repertoire'
import { board, boardScreen, btnClass, button, card, dateLabel, icon, jumps, judgColor, label, loading, plural } from './ui'
import { journalHangParts } from '../server/surface'
import { moveTable, score } from './moves'
import { timeCard } from './time'

export function gameView(ctrl: Ctrl): VNode {
  const v = ctrl.gameView
  if (!v) return loading()
  const g = v.game
  return boardScreen({
    title: g.opponent ? `vs ${g.opponent}` : 'Game',
    back: () => ctrl.back('games'),
    board: board(g.id, e => v.mount(e)),
    controls: jumps(v.ply, 0, v.game.moves.length, ply => v.go(ply)),
    side: [
      el('p', 'text-sm text-dim', `${g.result === 'win' ? 'Won' : g.result === 'loss' ? 'Lost' : 'Drew'} as ${g.color} · ${g.opening || g.eco || 'unknown opening'} · ${dateLabel(g.playedAt)}`),
      advice(v),
      timeCard(g),
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
    : 'Nothing given away.'
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
