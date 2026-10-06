// Splits an explanation into plain text and links to the board. A link is
// a move written in SAN (Nf3, exd5, e8=Q, O-O, with optional move number
// and check mark) or a bare square (e4). Moves from the solution or the
// game point from their real squares; any other move or square marks its
// destination only. Castling that isn't a known move links to nothing.

export interface Target {
  from?: string
  to: string
}

export type Segment = { text: string; target?: Target }

const TOKEN = /\b(?:\d+\.(?:\.\.)?\s?)?(O-O(?:-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?)[+#]?(?![\w-])/g

export function linkSegments(text: string, known: Map<string, Target>): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    const san = m[1]
    const square = san.match(/[a-h][1-8](?=(?:=[QRBN])?$)/)?.[0]
    const target = known.get(san) ?? (square ? { to: square } : undefined)
    if (!target) continue
    if (m.index > last) out.push({ text: text.slice(last, m.index) })
    out.push({ text: m[0], target })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}
