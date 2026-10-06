import { h } from 'snabbdom'

export const view = () =>
  h('main.mx-auto.max-w-3xl.p-6', [
    h('h1.font-display.text-3xl', 'lidrill'),
    h('p.text-dim', 'Train on the moves you actually missed.'),
  ])
