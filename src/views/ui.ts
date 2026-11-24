import { h, type VNode, type VNodeChildren } from 'snabbdom'
import { el } from '../el'

type Kind = 'primary' | 'plain' | 'quiet'

// Every button is 44px high. sm is the same height with smaller text, icon
// is a 44px square, and fill takes its width from a grid or flex row.
const SIZE = {
  md: 'min-h-11 px-4 text-base',
  sm: 'min-h-11 px-4 text-sm',
  icon: 'size-11 shrink-0',
  fill: 'min-h-11 text-sm',
}

const KIND = {
  primary: 'bg-accent text-bg not-disabled:hover:brightness-110',
  plain: 'bg-raised not-disabled:hover:brightness-110',
  quiet: 'text-dim not-disabled:hover:bg-hover not-disabled:active:bg-press',
}

// For a button that needs its own attributes, or a label or link drawn as one
export const btnClass = (kind: Kind = 'primary', size: keyof typeof SIZE = 'md') =>
  `inline-flex items-center justify-center gap-2 rounded-lg font-medium transition motion-safe:not-disabled:active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 ${SIZE[size]} ${KIND[kind]}`

export const button = (label: VNodeChildren, onClick: () => void, kind: Kind = 'primary', disabled = false) =>
  el('button', btnClass(kind), { attrs: { disabled, type: 'button' }, on: { click: onClick } }, label)

// A list whose rows are links or buttons the full width of the row. Inside a
// card it takes -mx-4 sm:-mx-5 so the rows reach the card's edges.
export const rowList = (rows: VNode[], extra = '') => el('ul', `divide-y divide-raised ${extra}`, rows)

const ROW = 'flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-hover focus-visible:-outline-offset-2 active:bg-press sm:px-5'

export const listRow = (to: string | (() => void), children: VNodeChildren) =>
  el('li', [typeof to === 'string' ? el('a', ROW, { attrs: { href: to } }, children) : el('button', ROW, { attrs: { type: 'button' }, on: { click: to } }, children)])

// One of a few exclusive choices, the options sharing one track as in lila's
// radio group. Each option is [value, text, a spoken name when the text is a
// symbol].
export function segmented<T extends string>(name: string, opts: [T, string, string?][], current: T | undefined, pick: (v: T) => void): VNode {
  return el(
    'div',
    'grid auto-cols-fr grid-flow-col gap-[3px] rounded-lg bg-raised p-[3px]',
    { attrs: { role: 'group', 'aria-label': name } },
    opts.map(([v, text, spoken]) => {
      const on = v === current
      return el(
        'button',
        // 44px to tap on a phone; seven options still fit a 375px screen at 41px each
        'h-11 rounded-md text-xs font-medium tabular-nums transition-colors focus-visible:-outline-offset-2 focus-visible:outline-fg sm:h-9',
        {
          attrs: { type: 'button', 'aria-pressed': String(on), ...(spoken && { 'aria-label': spoken, title: spoken }) },
          class: { 'bg-accent': on, 'text-bg': on, 'hover:bg-hover': !on, 'active:bg-press': !on },
          on: { click: () => pick(v) },
        },
        text,
      )
    }),
  )
}

export const card = (children: VNodeChildren, extra = '') => el('section', `rounded-xl bg-surface p-4 sm:p-5 ${extra}`, children)

// Until a board screen's data is read
export const loading = () => el('p', 'p-4 text-dim', { attrs: { role: 'status' } }, 'Loading…')

// A grey block in the shape of what is loading
export const loadingBlock = (extra: string) => el('div', `animate-pulse rounded-xl bg-surface ${extra}`)

export type Mark = 'good' | 'warn' | 'bad' | undefined

// One square per item in a run: coloured by result once done, grey to come,
// outlined for the one on screen
export const dots = (marks: Mark[], current: number, name: string) =>
  el(
    'div',
    'flex flex-wrap gap-1',
    { attrs: { role: 'img', 'aria-label': name } },
    marks.map((m, i) =>
      el('span', 'size-3 rounded-sm', { class: { 'bg-accent': m === 'good', 'bg-warn': m === 'warn', 'bg-bad': m === 'bad', 'bg-raised': !m, 'ring-2': i === current, 'ring-fg': i === current } }),
    ),
  )

// The same run as a bar across the panel, one segment per item
export const runBar = (marks: Mark[], current: number, name: string) =>
  el(
    'div',
    'flex gap-1',
    { attrs: { role: 'img', 'aria-label': name } },
    marks.map((m, i) =>
      el('span', 'h-1.5 min-w-0 flex-1 rounded-full', { class: { 'bg-accent': m === 'good', 'bg-warn': m === 'warn', 'bg-bad': m === 'bad', 'bg-raised': !m, 'ring-2': i === current, 'ring-fg': i === current } }),
    ),
  )

// role=alert has a screen reader read it out when it appears
export const errorLine = (text: string | undefined, extra = '') => el('p', `text-sm text-bad ${extra}`, { attrs: { role: 'alert' } }, text)

// A card that says there is nothing to show yet
export const empty = (text: string) => card([el('p', 'text-dim', text)])

export const label = (text: string) => el('p', 'text-xs font-medium uppercase tracking-wide text-dim', text)

export const pct = (x?: number) => (x === undefined ? '–' : `${Math.round(x * 100)}%`)

export { pawns } from '../format'

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function dateLabel(ms: number): string {
  const d = new Date(ms)
  const days = Math.floor((Date.now() - ms) / 86400000)
  if (days < 1) return 'today'
  if (days < 2) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}

// 24px line icons, drawn for lidrill
const ICONS: Record<string, string> = {
  train: 'M6 4v16M18 4v16M6 12h12M3 8v8M21 8v8',
  openings: 'M12 7v13M12 7a3 3 0 00-3-3H4v13h5a3 3 0 013 3M12 7a3 3 0 013-3h5v13h-5a3 3 0 00-3 3',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  back: 'M15 5l-7 7 7 7',
  first: 'M17 6l-6 6 6 6M7 6v12',
  prev: 'M15 6l-6 6 6 6',
  next: 'M9 6l6 6-6 6',
  last: 'M7 6l6 6-6 6M17 6v12',
  hint: 'M9 18h6M10 21h4M12 3a6 6 0 00-3.5 10.9c.6.4 1 1.1 1 1.8V16h5v-.3c0-.7.4-1.4 1-1.8A6 6 0 0012 3z',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5',
  check: 'M4 12l5 5L20 6',
}

export const icon = (name: string, size = 22) =>
  h(
    'svg',
    {
      attrs: { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    },
    [h('path', { attrs: { d: ICONS[name] } })],
  )

// The square board area. Sized in CSS (.board) so board plus controls fit
// one phone screen.
export const board = (key: string, mount: (el: HTMLElement) => void): VNode =>
  el('div', 'board', [el('div', 'cg-wrap', { key, hook: { insert: v => mount(v.elm as HTMLElement) } })])

// A screen with nowhere to go back to has no Back, and its title lines up
// with the panel under it
const topBar = (title: string, onBack?: () => void, action?: VNode | null) =>
  el('div', 'flex items-center gap-2 px-2 py-2 sm:px-0', [
    onBack ? el('button', btnClass('quiet', 'icon'), { attrs: { 'aria-label': 'Back', type: 'button' }, on: { click: onBack } }, [icon('back')]) : null,
    el('h1', 'min-w-0 flex-1 truncate font-display text-lg', { class: { 'pl-2': !onBack, 'wide:pl-0': !onBack } }, title),
    action ?? null,
  ])

// A full-screen board screen. The column holds the board with an optional
// bar above and below it and a control row under it; the grid that places
// it beside the top bar and side panel is .board-screen in index.css. On a
// phone on its side the board fills the height, so it stays put while the
// panel scrolls. hero is Train's larger board, note a line under the title
// and action a control at the end of the top bar.
export const boardScreen = (o: {
  title: string
  back?: () => void
  action?: VNode | null
  note?: string
  hero?: boolean
  board: VNode
  above?: VNode
  below?: VNode
  controls?: VNode | null
  side: VNodeChildren
}) =>
  el('div', 'board-screen', { class: { 'with-bars': !!o.above, hero: !!o.hero } }, [
    el('div', '[grid-area:top]', [topBar(o.title, o.back, o.action), o.note ? el('p', 'px-4 pb-2 text-sm text-dim wide:px-0', o.note) : null]),
    el('div', '[grid-area:board] short:sticky short:top-0 short:self-start', [o.above ?? null, o.board, o.below ?? null, o.controls ? el('div', 'px-4 pt-3 wide:px-0', [o.controls]) : null]),
    el('aside', '[grid-area:side] space-y-4 px-4 pb-8 pt-3 wide:px-0 wide:pt-4', o.side),
  ])

// First, previous, next and last move, for the row under the board. A button
// is disabled where it would not move, as Lichess's are at either end.
export function jumps(at: number, first: number, last: number, go: (i: number) => void): VNode {
  const jump = (name: string, text: string, to: number) =>
    el('button', `${btnClass('plain', 'fill')} flex-1`, { attrs: { type: 'button', 'aria-label': text, disabled: to === at }, on: { click: () => go(to) } }, [icon(name)])
  return el('div', 'flex gap-2', [
    jump('first', 'First move', first),
    jump('prev', 'Previous move', Math.max(first, at - 1)),
    jump('next', 'Next move', Math.min(last, at + 1)),
    jump('last', 'Last move', last),
  ])
}

// Games per week, oldest first: the green part is zero-hang games. Empty
// weeks keep a stub so the eight slots always read as a timeline.
export function weekBars(weeks: { games: number; clean: number }[]): VNode {
  const max = Math.max(1, ...weeks.map(w => w.games))
  const ht = 40
  const bw = 10
  const gap = 5
  return svgEl('svg', { viewBox: `0 0 ${weeks.length * (bw + gap) - gap} ${ht}`, width: weeks.length * (bw + gap) - gap, height: ht, role: 'img', 'aria-label': 'Games per week, clean games in green' }, weeks.flatMap((w, i) => {
    const x = i * (bw + gap)
    if (!w.games) return [svgEl('rect', { x, y: ht - 2, width: bw, height: 2, rx: 1, class: 'fill-raised' })]
    const total = Math.max(4, (w.games / max) * ht)
    const clean = (w.clean / w.games) * total
    return [
      svgEl('rect', { x, y: ht - total, width: bw, height: total, rx: 2, class: 'fill-bad opacity-60' }, [svgEl('title', {}, [`${w.clean} of ${w.games} clean`])]),
      clean ? svgEl('rect', { x, y: ht - clean, width: bw, height: clean, rx: 2, class: 'fill-accent' }) : null,
    ]
  }))
}

function svgEl(tag: string, attrs: Record<string, string | number>, children: (VNode | string | null)[] = []): VNode {
  return h(tag, { attrs }, children.filter((c): c is VNode | string => c !== null))
}

export const judgColor = { inaccuracy: 'text-inaccuracy', mistake: 'text-mistake', blunder: 'text-blunder' } as const
export const judgMark = { inaccuracy: '?!', mistake: '?', blunder: '??' } as const

export const resultChip = (result: 'win' | 'loss' | 'draw') =>
  el(
    'span',
    'grid size-8 shrink-0 place-items-center rounded-md text-sm font-bold',
    { class: { 'bg-accent': result === 'win', 'text-bg': result !== 'draw', 'bg-bad': result === 'loss', 'bg-raised': result === 'draw' } },
    result === 'win' ? 'W' : result === 'loss' ? 'L' : 'D',
  )

// Swing/cost words now live in src/server/surface.ts (single rendering
// surface,): the one place a certified swing is phrased outside a
// packet. Kept as a re-export so older imports stay on the sanctioned path.
export { costWords as pawnsWorth } from '../server/surface'

export const LEVEL_WORD = { beginner: 'beginner', club: 'club', advanced: 'advanced' } as const

// What counts as a hang at each level, in plain words
export const HANG_RULE = {
  beginner: 'a hang is one move that gives away three pawns or more, like dropping a knight or bishop',
  club: 'a hang is one move that gives away a pawn and a half or more and loses material',
  advanced: 'a hang is one of your worst 5% of moves, costing at least a pawn and a half',
} as const
