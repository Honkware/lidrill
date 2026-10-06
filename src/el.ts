import { h, type VNode, type VNodeChildren, type VNodeData } from 'snabbdom'

// Snabbdom wants classes in the selector ('div.p-6.flex'), but Tailwind only
// finds class names in plain space-separated strings. Write them the Tailwind
// way and build the selector here.
export function el(tag: string, classes: string, data?: VNodeData | VNodeChildren, children?: VNodeChildren): VNode {
  const sel = classes.trim() ? `${tag}.${classes.trim().split(/\s+/).join('.')}` : tag
  if (children !== undefined) return h(sel, data as VNodeData, children)
  if (data === undefined) return h(sel)
  const isData = typeof data === 'object' && data !== null && !Array.isArray(data) && !('sel' in data)
  return isData ? h(sel, data as VNodeData) : h(sel, data as VNodeChildren)
}
