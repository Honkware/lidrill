import type { Eval } from '../db'

// Anything that speaks UCI one line at a time: the browser worker, or the
// Node build in tests.
export interface UciEngine {
  send(cmd: string): void
  onLine(listener: (line: string) => void): void
}

export function workerEngine(url = '/engine/stockfish-19-lite-single.js'): UciEngine {
  const worker = new Worker(url)
  return {
    send: cmd => worker.postMessage(cmd),
    onLine: listener => worker.addEventListener('message', e => listener(String(e.data))),
  }
}

export interface SearchResult {
  eval: Eval // side to move's point of view, as UCI reports it
  pv: string[]
  depth: number
  multipv: number
}

// Runs searches one at a time; UCI has no request ids, so overlapping
// searches would mix up their output.
export class Engine {
  private queue: Promise<unknown> = Promise.resolve()
  private listener: (line: string) => void = () => {}
  private uci: UciEngine

  constructor(uci: UciEngine) {
    this.uci = uci
    uci.onLine(line => this.listener(line))
    uci.send('uci')
    uci.send('setoption name Hash value 32')
  }

  search(fen: string, depth: number): Promise<SearchResult> {
    return this.searchLines(fen, depth, 1).then(lines => lines[0] ?? { eval: { cp: 0 }, pv: [], depth: 0 })
  }

  // The best `count` lines, best first (UCI MultiPV)
  searchLines(fen: string, depth: number, count: number): Promise<SearchResult[]> {
    const run = () =>
      new Promise<SearchResult[]>(resolve => {
        const lines: SearchResult[] = []
        this.listener = line => {
          if (line.startsWith('bestmove')) return resolve(lines.filter(Boolean))
          const parsed = parseInfo(line)
          if (parsed) lines[parsed.multipv - 1] = parsed
        }
        this.uci.send(`setoption name MultiPV value ${count}`)
        this.uci.send(`position fen ${fen}`)
        this.uci.send(`go depth ${depth}`)
      })
    const next = this.queue.then(run)
    this.queue = next.catch(() => {})
    return next
  }
}

export function parseInfo(line: string): SearchResult | null {
  if (!line.startsWith('info ') || !line.includes(' pv ')) return null
  const score = line.match(/ score (cp|mate) (-?\d+)/)
  const depth = line.match(/ depth (\d+)/)
  if (!score || !depth) return null
  const value = parseInt(score[2])
  return {
    eval: score[1] === 'cp' ? { cp: value } : { mate: value },
    pv: line.split(' pv ')[1].trim().split(' '),
    depth: parseInt(depth[1]),
    multipv: parseInt(line.match(/ multipv (\d+)/)?.[1] ?? '1'),
  }
}
