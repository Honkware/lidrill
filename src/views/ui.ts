import { h, type VNode, type VNodeChildren } from 'snabbdom'
import { el } from '../el'

export const button = (label: VNodeChildren, onClick: () => void, kind: 'primary' | 'plain' | 'quiet' = 'primary', disabled = false) =>
  el(
    'button',
    'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 font-medium transition active:scale-95',
    {
      class: {
        'bg-accent': kind === 'primary',
        'text-bg': kind === 'primary',
        'bg-raised': kind === 'plain',
        'text-dim': kind === 'quiet',
        'opacity-50': disabled,
      },
      attrs: { disabled, type: 'button' },
      on: { click: onClick },
    },
    label,
  )

export const card = (children: VNodeChildren, extra = '') => el('section', `rounded-xl bg-surface p-4 sm:p-5 ${extra}`, children)

export const label = (text: string) => el('p', 'text-xs font-medium uppercase tracking-wide text-dim', text)

export const pct = (x?: number) => (x === undefined ? '–' : `${Math.round(x * 100)}%`)

export const pawns = (cp: number) => `${cp >= 0 ? '+' : '−'}${(Math.abs(cp) / 100).toFixed(1)}`

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
  today: 'M4 12l4 4 12-12',
  review: 'M4 6h16M4 12h16M4 18h10',
  drills: 'M6 4v16M18 4v16M6 12h12M3 8v8M21 8v8',
  games: 'M12 4v11m0 0l-4-4m4 4l4-4M5 20h14',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM4 12h2m12 0h2M12 4v2m0 12v2M6.3 6.3l1.4 1.4m8.6 8.6l1.4 1.4m0-11.4l-1.4 1.4m-8.6 8.6l-1.4 1.4',
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

// Top bar for the full-screen board screens
export const topBar = (title: string, onBack: () => void, right?: VNode | null) =>
  el('div', 'flex items-center gap-2 px-2 py-2 sm:px-0', [
    el('button', 'grid size-10 place-items-center rounded-lg text-dim', { attrs: { 'aria-label': 'Back', type: 'button' }, on: { click: onBack } }, [icon('back')]),
    el('h1', 'min-w-0 flex-1 truncate font-display text-lg', title),
    right ?? null,
  ])

export function sparkline(values: (number | undefined)[], w = 160, hgt = 36): VNode {
  const pts = values.map((v, i) => (v === undefined ? null : [(i / Math.max(1, values.length - 1)) * w, hgt - 4 - v * (hgt - 8)]))
  const segs: string[] = []
  let open = false
  for (const p of pts) {
    if (!p) {
      open = false
      continue
    }
    segs.push(`${open ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
    open = true
  }
  return h('svg', { attrs: { viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt, class: 'text-accent', 'aria-hidden': 'true' } }, [
    h('path', { attrs: { d: segs.join(' '), fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' } }),
    ...pts.filter((p): p is number[] => !!p).map(p => h('circle', { attrs: { cx: p[0], cy: p[1], r: 2.5, fill: 'currentColor' } })),
  ])
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
