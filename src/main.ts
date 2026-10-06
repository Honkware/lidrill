import { attributesModule, classModule, eventListenersModule, init, propsModule, styleModule, type VNode } from 'snabbdom'
import './index.css'
import { view } from './view'

const patch = init([classModule, attributesModule, propsModule, styleModule, eventListenersModule])

let vnode: VNode | Element = document.getElementById('app')!

export function redraw() {
  vnode = patch(vnode, view())
}

redraw()
