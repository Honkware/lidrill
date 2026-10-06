import type { ExplanationLink } from './db'

// Splits an explanation into plain text and the board links the server
// placed (by position in the text). Anything without a link stays plain, so
// a link can't point at the wrong squares.

export type Segment = { text: string; target?: ExplanationLink }

export function linkSegments(text: string, links: ExplanationLink[]): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const l of [...links].sort((a, b) => a.index - b.index)) {
    // Ignore links that don't match the text (e.g. an edited string)
    if (l.index < last || text.slice(l.index, l.index + l.text.length) !== l.text) continue
    if (l.index > last) out.push({ text: text.slice(last, l.index) })
    out.push({ text: l.text, target: l })
    last = l.index + l.text.length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}
