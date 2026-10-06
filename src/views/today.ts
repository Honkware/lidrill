import type { VNode } from 'snabbdom'
import type { Ctrl } from '../ctrl'
import { el } from '../el'
import { leakLine } from '../report'
import { button, card, HANG_RULE, label, pawnsWorth, pct, plural, weekBars } from './ui'

export function todayView(ctrl: Ctrl): VNode {
  const t = ctrl.today
  const p = ctrl.profile
  if (!t || !p)
    return ctrl.ready
      ? el('div', 'space-y-4', [
          card([el('p', 'text-dim', ctrl.syncing ? 'Fetching your games…' : 'No games yet.')]),
          ctrl.error ? el('p', 'text-sm text-bad', ctrl.error) : null,
        ])
      : skeleton()
  // Half-width cards on wide screens; an odd one out takes the full row so
  // the grid never leaves a hole
  const halves = [dueCard(ctrl), replayCard(ctrl), weekCard(ctrl), planCard(ctrl), drillsCard(ctrl), lichessCard(ctrl)].filter((c): c is VNode => !!c)
  if (halves.length % 2) {
    const last = halves[halves.length - 1]
    last.data = { ...last.data, class: { ...(last.data?.class ?? {}), 'md:col-span-2': true } }
  }
  return el('div', 'grid gap-4 md:grid-cols-2', [
    streakCard(ctrl),
    bandNote(ctrl),
    leakCard(ctrl),
    ...halves,
    t.openings.length ? openingsCard(ctrl) : null,
    ctrl.error ? el('p', 'text-sm text-bad md:col-span-2', ctrl.error) : null,
  ])
}

// Grey blocks in the shape of the dashboard while the first load runs
function skeleton(): VNode {
  const block = (extra: string) => el('div', `animate-pulse rounded-xl bg-surface ${extra}`)
  return el('div', 'grid gap-4 md:grid-cols-2', [block('h-32 md:col-span-2'), block('h-44'), block('h-44'), block('h-40'), block('h-40')])
}

// Hero metric. With no streak yet the copy points at the next game,
// never at the zero.
function streakCard(ctrl: Ctrl): VNode {
  const { streak, weeks } = ctrl.today!
  const band = ctrl.profile!.band
  const rule = `For you, ${HANG_RULE[band]}.`
  const played = weeks.some(w => w.games)
  return card(
    [
      el('div', 'flex items-end justify-between gap-4', [
        el('div', [
          el('p', 'font-display text-5xl leading-none tabular-nums', String(streak.current)),
          el('p', 'mt-1 text-sm', `zero-hang ${streak.current === 1 ? 'game' : 'games'} in a row`),
        ]),
        played ? el('div', 'flex flex-col items-end gap-1', [weekBars(weeks), el('p', 'text-xs text-dim', 'last 8 weeks')]) : null,
      ]),
      el(
        'p',
        'mt-3 text-xs text-dim',
        streak.current
          ? `${streak.best > streak.current ? `Best ${streak.best}. ` : 'Your best yet. '}${rule}`
          : streak.best
            ? `Your best is ${streak.best}. The next game without a hang starts a new run. ${rule}`
            : `Your first game without a hang starts it. ${rule}`,
      ),
    ],
    'md:col-span-2',
  )
}

function leakCard(ctrl: Ctrl): VNode | null {
  const leak = ctrl.today!.report.leak
  return leak ? card([label('Keeps happening'), el('p', 'mt-2', leakLine(leak))], 'md:col-span-2') : null
}

function dueCard(ctrl: Ctrl): VNode {
  const { queue } = ctrl.today!
  const due = queue.puzzles.length
  const external = queue.puzzles.filter(x => x.source === 'lichess').length
  return card([
    label('Due today'),
    el('p', 'mt-1 font-display text-3xl', plural(due, 'puzzle')),
    queue.recovery ? el('p', 'mt-1 text-sm text-dim', 'Welcome back. A short set to get going again.') : null,
    external ? el('p', 'mt-1 text-sm text-dim', `${external} of them from Lichess: your weak themes and puzzles you missed there.`) : null,
    due
      ? el('div', 'mt-4 grid', [button('Start', () => ctrl.startDrill())])
      : el(
          'p',
          'mt-2 text-sm text-dim',
          ctrl.counts.puzzles
            ? 'Nothing due. Come back tomorrow.'
            : ctrl.syncing
              ? 'Going through your games now. The first puzzles show up here within a few minutes.'
              : 'No puzzles yet. Sync your games first.',
        ),
  ])
}

function replayCard(ctrl: Ctrl): VNode | null {
  const pick = ctrl.today!.replayPick
  if (!pick) return null
  return card([
    label('Turning points'),
    el('p', 'mt-1', [
      `Your last game${pick.game.opponent ? ` vs ${pick.game.opponent}` : ''} had `,
      el('strong', '', plural(pick.stops, 'turning point')),
      '. Replay it and find the moves you missed.',
    ]),
    el('div', 'mt-4 grid', [button('Replay', () => ctrl.go('replay', pick.game.id), 'plain')]),
  ])
}

function delta(now: number, before: number, lowerIsBetter: boolean): string {
  const d = Math.round((now - before) * 100)
  if (!d) return 'same as last week'
  return `${d > 0 ? '+' : '−'}${Math.abs(d)} pts, ${(lowerIsBetter ? d < 0 : d > 0) ? 'better' : 'worse'}`
}

function weekCard(ctrl: Ctrl): VNode {
  const r = ctrl.today!.report
  const w = r.thisWeek
  const l = r.lastWeek
  const stat = (name: string, value: string, note?: string) =>
    el('div', [el('p', 'text-xs text-dim', name), el('p', 'font-medium tabular-nums', value), note ? el('p', 'text-xs text-dim', note) : null])
  return card([
    label('This week'),
    el('p', 'mt-2', r.focus),
    w.games
      ? el('div', 'mt-4 grid grid-cols-3 gap-3', [
          stat('Games with a hang', pct(w.hangRate), l.games ? delta(w.hangRate, l.hangRate, true) : undefined),
          stat('Won when ahead', pct(w.conversionRate), w.conversionRate === undefined ? 'no big leads' : undefined),
          stat('Puzzles solved', pct(w.solveRate), w.solveRate === undefined ? 'none yet' : undefined),
        ])
      : el('p', 'mt-3 text-sm text-dim', 'No analyzed games this week yet.'),
    w.timeouts || w.earlyResigns
      ? el('p', 'mt-3 text-xs text-dim', [
          w.timeouts ? `${plural(w.timeouts, 'loss')} on time. ` : '',
          w.earlyResigns ? `${plural(w.earlyResigns, 'early resignation')} (before move 20).` : '',
        ])
      : null,
  ])
}

// Repertoire: what the plan aims for and how often games get there
function planCard(ctrl: Ctrl): VNode {
  const t = ctrl.today!
  const rep = ctrl.profile!.repertoireStudy
  const chosen = !!ctrl.profile!.repertoire?.length
  return card([
    label('Openings plan'),
    el(
      'p',
      'mt-2',
      rep
        ? `Your study "${rep.name}".`
        : `${chosen ? 'Your picks' : 'Aiming for'}: ${t.targets.join(', ')}.`,
    ),
    t.compliance !== undefined
      ? el('p', 'mt-1 text-sm text-dim', `${pct(t.compliance)} of your last 30 games ${rep ? 'followed it for 4+ moves' : 'got there'}.`)
      : null,
    el('a', 'mt-3 inline-block text-sm text-accent', { attrs: { href: '#/settings' } }, 'Change'),
  ])
}

function drillsCard(ctrl: Ctrl): VNode | null {
  const d = ctrl.today!.practice
  const beginner = ctrl.profile!.band === 'beginner'
  const open = d.conversion + (beginner ? 0 : d.defense)
  if (!open && !d.cleared) return null
  return card([
    label('Drills'),
    el(
      'p',
      'mt-2',
      open
        ? [
            d.conversion ? `${plural(d.conversion, 'winning position')} you didn't convert` : '',
            d.conversion && !beginner && d.defense ? ' and ' : '',
            !beginner && d.defense ? `${plural(d.defense, 'worse position')} you saved` : '',
            ', ready to play out against Stockfish.',
          ].join('')
        : 'All cleared. New ones come from your next games.',
    ),
    d.cleared ? el('p', 'mt-1 text-sm text-dim', `${d.cleared} cleared so far.`) : null,
    open ? el('div', 'mt-4 grid', [button('Open drills', () => ctrl.go('drills'), 'plain')]) : null,
  ])
}

function lichessCard(ctrl: Ctrl): VNode | null {
  const t = ctrl.today!
  const weak = ctrl.profile?.weakThemes ?? []
  if (!weak.length && !t.puzzlePerf) return null
  return card([
    label('Lichess puzzles'),
    t.puzzlePerf
      ? el('p', 'mt-2', [
          `Puzzle performance ${t.puzzlePerf.now}`,
          t.puzzlePerf.delta ? el('span', 'text-dim', ` (${t.puzzlePerf.delta > 0 ? '+' : ''}${t.puzzlePerf.delta} since last week)`) : '',
          ', last 90 days.',
        ])
      : null,
    weak.length
      ? el('div', 'mt-3', [
          el('p', 'text-sm text-dim', 'Weakest themes, which get extra puzzles:'),
          el('div', 'mt-2 flex flex-wrap gap-2', weak.slice(0, 6).map(w => el('span', 'rounded-full bg-raised px-3 py-1 text-sm', `${w.name} ${w.performance}`))),
        ])
      : null,
  ])
}

function openingsCard(ctrl: Ctrl): VNode {
  const rows = ctrl.today!.openings
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
    'md:col-span-2',
  )
}

// One plan-card note after a band change
function bandNote(ctrl: Ctrl): VNode | null {
  const hist = ctrl.profile?.bandHistory ?? []
  const last = hist.at(-1)
  if (hist.length < 2 || !last || Date.now() - last.at > 7 * 86400000) return null
  const order = ['beginner', 'club', 'advanced']
  const up = order.indexOf(last.band) > order.indexOf(hist.at(-2)!.band)
  const extra = up && last.band === 'club' ? ' Defense drills are unlocked.' : ''
  return card(
    [
      el(
        'p',
        '',
        `lidrill now sees you as a ${last.band} player, from your Lichess rating. Puzzles come from moves that gave away ${pawnsWorth(ctrl.profile!.swingThresholdCp)} or more, and ${HANG_RULE[last.band]}.${extra}`,
      ),
    ],
    'md:col-span-2 border border-accent',
  )
}
