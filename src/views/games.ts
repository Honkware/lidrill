import type { VNode } from 'snabbdom'
import type { Ctrl, ReviewRow } from '../ctrl'
import type { OpeningRow } from '../metrics'
import { el } from '../el'
import { button, card, dateLabel, empty, judgColor, judgMark, label, listRow, loadingBlock, plural, resultChip, rowList } from './ui'
import { timeProfileCard } from './time'
import { chesscomField } from './welcome'

// The analyzed games with sync and the accounts above them, and below them
// the stats that describe them
export function gamesView(ctrl: Ctrl): VNode {
  const rows = ctrl.reviewList
  return el('div', 'mx-auto max-w-2xl space-y-3', [
    el('h1', 'font-display text-2xl', 'Games'),
    syncCard(ctrl),
    !rows
      ? loadingBlock('h-96')
      : !rows.length
        ? empty(ctrl.syncing ? 'Analyzing games…' : 'No analyzed games yet.')
        : rowList(rows.map(row), 'overflow-hidden rounded-xl bg-surface'),
    rows?.length ? timeProfileCard(ctrl) : null,
    ctrl.openingRows.length ? openingsCard(ctrl.openingRows) : null,
  ])
}

const fact = (name: string, value: string | VNode) => el('div', [el('p', 'text-xs text-dim', name), el('p', 'font-medium tabular-nums', [value])])

function syncCard(ctrl: Ctrl): VNode {
  const { games, analyzed, puzzles } = ctrl.counts
  const prog = ctrl.progress
  const band = ctrl.profile?.band
  return card(
    [
      el('div', 'flex flex-wrap items-center gap-x-6 gap-y-3', [
        fact('Games', String(games)),
        fact('Analyzed', String(analyzed)),
        fact('Puzzles', String(puzzles)),
        band ? fact('Level', el('a', 'underline decoration-dotted underline-offset-2', { attrs: { href: '#/settings', title: 'What counts' } }, band)) : null,
        el('div', 'ml-auto flex gap-2', [
          ctrl.syncing ? button('Stop', () => ctrl.stopSync(), 'quiet') : null,
          button(ctrl.syncing ? 'Syncing…' : 'Sync', () => ctrl.sync(), 'plain', ctrl.syncing),
        ]),
      ]),
      prog && prog.total
        ? el('div', 'flex items-center gap-3', [
            el('div', 'h-2 flex-1 rounded bg-raised', [el('div', 'h-2 rounded bg-accent', { style: { width: `${(100 * prog.done) / prog.total}%` } })]),
            el('p', 'text-xs tabular-nums text-dim', { attrs: { title: 'Games analyzed this run' } }, `${prog.done}/${prog.total}`),
          ])
        : null,
      ctrl.status ? el('p', 'text-sm', { class: { 'text-bad': !!ctrl.error } }, ctrl.status) : null,
      el('div', 'space-y-3 border-t border-raised pt-3', [
        ctrl.auth ? el('p', 'text-sm', [el('span', 'text-dim', 'Lichess '), ctrl.auth.username]) : el('div', 'grid sm:flex', [button('Sign in with Lichess', () => ctrl.signIn())]),
        chesscomField(ctrl, ctrl.profile?.chesscomUser ? 'Save' : 'Add'),
      ]),
    ],
    'space-y-3',
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

// Per opening: win/draw/loss and how often a game had something given away
function openingsCard(rows: OpeningRow[]): VNode {
  return card([
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
  ])
}
