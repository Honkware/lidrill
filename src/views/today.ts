import type { VNode } from 'snabbdom'
import type { Ctrl } from '../ctrl'
import type { Band } from '../db'
import { el } from '../el'
import { button, card, label, pct, plural, sparkline } from './ui'

const HANG_RULE: Record<Band, string> = {
  beginner: 'a hang is a move that loses 3+ pawns',
  club: 'a hang is a move that drops 1.5+ pawns and loses material',
  advanced: 'a hang is one of your worst 5% of moves, and at least 1.5 pawns',
}

export function todayView(ctrl: Ctrl): VNode {
  const t = ctrl.today
  const p = ctrl.profile
  if (!t || !p)
    return el('div', 'space-y-4', [
      card([el('p', 'text-dim', ctrl.syncing ? 'Fetching your games…' : 'No games yet.')]),
      ctrl.error ? el('p', 'text-sm text-bad', ctrl.error) : null,
    ])
  const { queue, streak } = t
  const due = queue.puzzles.length
  const external = queue.puzzles.filter(x => x.source === 'lichess').length
  return el('div', 'grid gap-4 md:grid-cols-2', [
    // Streak hero
    card(
      [
        el('div', 'flex items-end justify-between gap-4', [
          el('div', [
            el('p', 'font-display text-5xl leading-none tabular-nums', String(streak.current)),
            el('p', 'mt-1 text-sm', `zero-hang ${streak.current === 1 ? 'game' : 'games'} in a row`),
          ]),
          t.weeks.some(w => w !== undefined) ? el('div', 'text-right', [sparkline(t.weeks), el('p', 'text-xs text-dim', 'last 8 weeks')]) : null,
        ]),
        el('p', 'mt-3 text-xs text-dim', `Best ${streak.best}. For you, ${HANG_RULE[p.band]}.`),
      ],
      'md:col-span-2',
    ),
    bandNote(ctrl),
    // Today's puzzles
    card(
      [
        label('Due today'),
        el('p', 'mt-1 font-display text-3xl', plural(due, 'puzzle')),
        queue.recovery ? el('p', 'mt-1 text-sm text-dim', 'Welcome back. A short set to get going again.') : null,
        external ? el('p', 'mt-1 text-sm text-dim', `Includes ${plural(external, 'Lichess puzzle')} from your weak themes or misses.`) : null,
        due
          ? el('div', 'mt-4 grid', [button(`Start`, () => ctrl.startDrill())])
          : el(
              'p',
              'mt-2 text-sm text-dim',
              ctrl.counts.puzzles
                ? 'Nothing due. Come back tomorrow.'
                : ctrl.syncing
                  ? 'Going through your games now. The first puzzles show up here within a few minutes.'
                  : 'No puzzles yet. Sync your games first.',
            ),
      ],
    ),
    // Turning Points
    t.replayPick
      ? card([
          label('Turning points'),
          el('p', 'mt-1', [
            `Your last game${t.replayPick.game.opponent ? ` vs ${t.replayPick.game.opponent}` : ''} had `,
            el('strong', '', plural(t.replayPick.stops, 'turning point')),
            '. Replay it and find the moves you missed.',
          ]),
          el('div', 'mt-4 grid', [button('Replay', () => ctrl.go('replay', t.replayPick!.game.id), 'plain')]),
        ])
      : null,
    weekCard(ctrl),
    planCard(ctrl),
    p.weakThemes?.length || t.puzzlePerf ? lichessCard(ctrl) : null,
    t.openings.length ? openingsCard(ctrl) : null,
    ctrl.error ? el('p', 'text-sm text-bad md:col-span-2', ctrl.error) : null,
  ])
}

function trend(now?: number, before?: number, lowerIsBetter = false): string {
  if (now === undefined || before === undefined) return ''
  const d = Math.round((now - before) * 100)
  if (!d) return ' (same as last week)'
  const better = lowerIsBetter ? d < 0 : d > 0
  return ` (${d > 0 ? '+' : ''}${d} pts, ${better ? 'better' : 'worse'})`
}

function weekCard(ctrl: Ctrl): VNode {
  const r = ctrl.today!.report
  const w = r.thisWeek
  const l = r.lastWeek
  const stat = (name: string, value: string, extra: string) =>
    el('div', [el('p', 'text-xs text-dim', name), el('p', 'font-medium tabular-nums', value), extra ? el('p', 'text-xs text-dim', extra) : null])
  return card([
    label('This week'),
    el('p', 'mt-2', r.focus),
    el('div', 'mt-4 grid grid-cols-3 gap-3', [
      stat('Games with a hang', w.games ? pct(w.hangRate) : '–', trend(w.games ? w.hangRate : undefined, l.games ? l.hangRate : undefined, true).trim()),
      stat('Won when ahead', pct(w.conversionRate), ''),
      stat('Puzzles solved', pct(w.solveRate), ''),
    ]),
    w.timeouts || w.earlyResigns
      ? el('p', 'mt-3 text-xs text-dim', [
          w.timeouts ? `${plural(w.timeouts, 'loss')} on time. ` : '',
          w.earlyResigns ? `${plural(w.earlyResigns, 'early resignation')} (before move 20).` : '',
        ])
      : null,
  ])
}

function planCard(ctrl: Ctrl): VNode {
  const t = ctrl.today!
  const time = ctrl.profile?.trainingTime
  return card([
    label('Plan'),
    time
      ? el('p', 'mt-2', [`You train: `, el('strong', '', time), '.'])
      : el('form', 'mt-2 space-y-2', { on: { submit: e => (e.preventDefault(), ctrl.setPlan({ trainingTime: (document.getElementById('when') as HTMLInputElement).value.trim() || undefined })) } }, [
          el('label', 'block text-sm', { attrs: { for: 'when' } }, 'When will you do your daily puzzles?'),
          el('div', 'flex gap-2', [
            el('input', 'min-h-11 min-w-0 flex-1 rounded-lg bg-raised px-3', { attrs: { id: 'when', placeholder: 'e.g. after dinner', autocomplete: 'off' } }),
            el('button', 'min-h-11 rounded-lg bg-raised px-4 font-medium', { attrs: { type: 'submit' } }, 'Save'),
          ]),
        ]),
    el('p', 'mt-3 text-sm text-dim', [`Openings to aim for: ${t.targets.join(', ')}. `, t.compliance !== undefined ? `${pct(t.compliance)} of your last 30 games got there.` : '']),
  ])
}

function lichessCard(ctrl: Ctrl): VNode {
  const t = ctrl.today!
  const weak = ctrl.profile?.weakThemes ?? []
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
          el(
            'div',
            'mt-2 flex flex-wrap gap-2',
            weak.slice(0, 6).map(w => el('span', 'rounded-full bg-raised px-3 py-1 text-sm', `${w.name} ${w.performance}`)),
          ),
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
        el('table', 'w-full min-w-[22rem] text-sm', [
          el('thead', [
            el('tr', 'text-left text-xs text-dim', [
              el('th', 'px-1 py-1 font-normal', 'Opening'),
              el('th', 'px-1 py-1 text-right font-normal', 'Games'),
              el('th', 'px-1 py-1 text-right font-normal', 'W / D / L'),
              el('th', 'px-1 py-1 text-right font-normal', 'Avg worst move'),
            ]),
          ]),
          el(
            'tbody',
            rows.map(r =>
              el('tr', 'border-t border-raised', [
                el('td', 'max-w-[12rem] truncate px-1 py-2', r.family),
                el('td', 'px-1 py-2 text-right tabular-nums', String(r.games)),
                el('td', 'px-1 py-2 text-right tabular-nums', `${r.win} / ${r.draw} / ${r.loss}`),
                el('td', 'px-1 py-2 text-right tabular-nums', r.avgWorstCp ? `−${(r.avgWorstCp / 100).toFixed(1)}` : '–'),
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
  const up = ['beginner', 'club', 'advanced'].indexOf(last.band) > ['beginner', 'club', 'advanced'].indexOf(hist.at(-2)!.band)
  const extra = up && last.band === 'club' ? ' Defense drills are unlocked.' : ''
  return card(
    [el('p', '', `${up ? 'You moved up' : 'You moved'} to ${last.band} level. Puzzles now start at a ${((ctrl.profile!.swingThresholdCp) / 100).toFixed(1)}-pawn swing and the hang rule changed with it.${extra}`)],
    'md:col-span-2 border border-accent',
  )
}
