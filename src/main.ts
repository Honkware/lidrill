import { attributesModule, classModule, eventListenersModule, init, propsModule, styleModule, type VNode } from 'snabbdom'
import '@lichess-org/chessground/assets/chessground.base.css'
import './index.css'
import { Ctrl } from './ctrl'
import { view } from './views/layout'

const patch = init([classModule, attributesModule, propsModule, styleModule, eventListenersModule])

let vnode: VNode | Element = document.getElementById('app')!
let scheduled = false

// Batch redraws into one patch per frame
function redraw() {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(() => {
    scheduled = false
    vnode = patch(vnode, view(ctrl))
  })
}

const ctrl = new Ctrl(redraw)
redraw()

// Offline shell and installability; not in dev, where it would
// cache Vite's modules
if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js')
