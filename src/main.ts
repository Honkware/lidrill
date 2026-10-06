import { attributesModule, classModule, eventListenersModule, init, propsModule, styleModule, type VNode } from 'snabbdom'
import '@lichess-org/chessground/assets/chessground.base.css'
import './index.css'
import { Ctrl } from './ctrl'
import { view } from './view'

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
