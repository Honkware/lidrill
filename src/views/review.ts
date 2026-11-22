import type { VNode, VNodeChildren } from 'snabbdom'
import type { Ctrl, ReviewRow } from '../ctrl'
import { el } from '../el'
import type { GameView } from '../gameview'
import { deviation } from '../lichess/repertoire'
import { board, button, card, dateLabel, icon, judgColor, judgMark, label, plural, resultChip, topBar } from './ui'
import { journalHangParts } from '../server/surface'

export function reviewView(ctrl: Ctrl): VNode {
  const rows = ctrl.reviewList
  const openings = ctrl.today?.openings ?? []
  return el('div', 'mx-auto max-w-2xl space-y-3', [
    el('h1', 'font-display text-2xl', 'Review'),
    !rows
      ? el('div', 'h-96 animate-pulse rounded-xl bg-surface')
      : !rows.length
        ? card([el('p', 'text-dim', ctrl.syncing ? 'Your games are being analyzed. They show up here one by one.' : 'No analyzed games yet.')])
        : el('ul', 'divide-y divide-raised overflow-hidden rounded-xl bg-surface', rows.map(r => row(r))),
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
  return el('li', [
    el('a', 'flex items-center gap-3 px-4 py-3 active:bg-raised', { attrs: { href: `#/game/${encodeURIComponent(g.id)}` } }, [
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
        r.journal && !r.journal.hung ? (marks.length ? el('p', 'text-xs text-accent', 'clean game') : null) : r.puzzles ? el('p', 'text-xs text-dim', plural(r.puzzles, 'stop')) : null,
      ]),
    ]),
  ])
}

export function gameView(ctrl: Ctrl): VNode {
  const v = ctrl.gameView
  if (!v) return el('p', 'p-4 text-dim', 'Loading…')
  const g = v.game
  return el('div', 'md:grid md:grid-cols-[auto_minmax(0,1fr)] md:gap-6 md:pt-4', [
    el('div', [
      el('div', 'md:hidden', [topBar(g.opponent ? `vs ${g.opponent}` : 'Game', () => ctrl.back('review'))]),
      board(g.id, e => v.mount(e)),
      controls(v),
    ]),
    el('aside', 'space-y-4 px-4 pb-8 pt-2 md:px-0 md:pt-0', [
      el('div', 'hidden md:block', [topBar(g.opponent ? `vs ${g.opponent}` : 'Game', () => ctrl.back('review'))]),
      el('p', 'text-sm text-dim', [
        `${g.result === 'win' ? 'Won' : g.result === 'loss' ? 'Lost' : 'Drew'} as ${g.color} · ${g.opening || g.eco || 'unknown opening'} · ${dateLabel(g.playedAt)}`,
        g.accuracy ? ` · accuracy ${g.accuracy}%` : '',
      ]),
      lowPoints(v),
      studyNote(ctrl, v),
      moveList(v),
      journalCard(ctrl, v),
      el('div', 'flex flex-wrap gap-2', [
        v.puzzles.length ? button(`Replay ${plural(v.puzzles.length, 'turning point')}`, () => ctrl.go('replay', g.id)) : null,
        v.puzzles.length && ctrl.auth && g.site === 'lichess' ? button('Send to Lichess study', () => ctrl.sendStudy(g.id), 'plain') : null,
        g.url
          ? el('a', 'inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-dim', { attrs: { href: g.url, target: '_blank', rel: 'noopener' } }, [
              `Open on ${g.site === 'lichess' ? 'Lichess' : 'Chess.com'}`,
              icon('external', 16),
            ])
          : null,
      ]),
    ]),
  ])
}

const navButton = (name: string, labelText: string, onClick: () => void) =>
  el('button', 'grid h-12 flex-1 place-items-center rounded-lg bg-surface active:bg-raised', { attrs: { type: 'button', 'aria-label': labelText }, on: { click: onClick } }, [icon(name)])

function controls(v: GameView): VNode {
  return el('div', 'flex gap-2 px-4 pt-3 md:px-0', [
    navButton('first', 'Start', () => v.go(0)),
    navButton('prev', 'Previous move', () => v.go(v.ply - 1)),
    navButton('next', 'Next move', () => v.go(v.ply + 1)),
    navButton('last', 'End', () => v.go(v.game.moves.length)),
  ])
}

function lowPoints(v: GameView): VNode | null {
  const pts = v.lowPoints
  if (!pts.length) return null
  return el('div', [
    label('Jump to your mistakes'),
    el(
      'div',
      'mt-2 flex flex-wrap gap-2',
      pts.map(ply => {
        const m = v.game.moves[ply - 1]
        return el(
          'button',
          'min-h-9 rounded-full bg-raised px-3 text-sm',
          { attrs: { type: 'button' }, class: { [judgColor[m.judg!]]: true, 'ring-2': v.ply === ply }, on: { click: () => v.go(ply) } },
          `${Math.ceil(ply / 2)}${ply % 2 ? '.' : '…'} ${m.san}${judgMark[m.judg!]}`,
        )
      }),
    ),
  ])
}

function moveList(v: GameView): VNode {
  const moves = v.game.moves
  const cells: VNode[] = []
  for (let i = 0; i < moves.length; i += 2) {
    cells.push(el('span', 'py-1 pr-1 text-right text-dim tabular-nums', `${i / 2 + 1}.`))
    for (const j of [i, i + 1]) {
      const m = moves[j]
      if (!m) {
        cells.push(el('span', ''))
        continue
      }
      cells.push(
        el(
          'button',
          'rounded px-2 py-1 text-left',
          {
            attrs: { type: 'button' },
            class: { 'bg-raised': v.ply === j + 1, [m.judg ? judgColor[m.judg] : 'text-fg']: true, 'opacity-60': !!m.book },
            on: { click: () => v.go(j + 1) },
          },
          `${m.san}${m.judg ? judgMark[m.judg] : ''}`,
        ),
      )
    }
  }
  return el('div', 'max-h-64 overflow-y-auto rounded-xl bg-surface p-2 md:max-h-80', [el('div', 'grid grid-cols-[40px_1fr_1fr] text-sm', cells)])
}

function journalCard(ctrl: Ctrl, v: GameView): VNode | null {
  const j = v.journal
  if (!j) return null
  // The hang line's words come from the shared validated surface;
  // only the stored SAN renders as a link, and it is never composed here
  const hang = j.hung ? journalHangParts(j.hung) : undefined
  const hangRow: VNodeChildren = hang
    ? [hang[0], el('button', 'underline', { attrs: { type: 'button' }, on: { click: () => v.go(j.hung!.ply) } }, hang[1]), hang[2]]
    : 'Nothing given away. Counts toward your streak.'
  return card(
    [
      label('Journal'),
      el('p', '', hangRow),
      el('label', 'flex items-center gap-2 text-sm', [
        el('input', 'size-5 accent-accent', { attrs: { type: 'checkbox' }, props: { checked: j.confirmed }, on: { change: e => ctrl.saveJournal({ confirmed: (e.target as HTMLInputElement).checked }) } }),
        "That's right",
      ]),
      el('textarea', 'block w-full rounded-lg bg-raised px-3 py-2 text-sm', {
        attrs: { rows: 2, placeholder: 'A note for yourself: what happened, what to watch for' },
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
  const moveNo = `${Math.ceil(d.ply / 2)}${d.ply % 2 ? '.' : '…'}`
  const played = v.sanBefore(d.ply, v.game.moves[d.ply - 1].uci)
  const expected = v.sanBefore(d.ply, d.expected)
  return el('button', 'block w-full rounded-xl bg-surface p-3 text-left text-sm', { attrs: { type: 'button' }, on: { click: () => v.go(d.ply - 1) } }, [
    el('span', 'text-dim', `Study "${study.name}": `),
    d.byPlayer ? `you left it at ${moveNo} It plays ${expected}; you played ${played}.` : `your opponent left it at ${moveNo} with ${played} (the study expects ${expected}).`,
  ])
}
