import type { Eval } from '../db'

// Anything that speaks UCI one line at a time: the browser worker, or the
// Node build in tests.
export interface UciEngine {
  send(cmd: string): void
  onLine(listener: (line: string) => void): void
  onError?(listener: () => void): void
  terminate?(): void
}

// Single-threaded workers only. The threaded build (Stockfish 19 lite) was
// tried under COOP/COEP and dropped: in a page only its first instance ever
// answers (later ones take commands as a helper thread would), and it
// crashed mid-search in the app. Parallel single-threaded workers get the
// same throughput without either problem.
export function workerEngine(url = '/engine/stockfish-19-lite-single.js'): UciEngine {
  const worker = new Worker(url)
  return {
    send: cmd => worker.postMessage(cmd),
    onLine: listener => worker.addEventListener('message', e => listener(String(e.data))),
    onError: listener => {
      // One report per worker: a crashing build can fire many error events
      let reported = false
      worker.addEventListener('error', e => {
        e.preventDefault()
        if (reported) return
        reported = true
        console.warn(`Stockfish failed: ${e.message || 'worker error'}`)
        listener()
      })
    },
    terminate: () => worker.terminate(),
  }
}

export interface SearchResult {
  eval: Eval // side to move's point of view, as UCI reports it
  pv: string[]
  depth: number
  multipv: number
}

// One certification search: depth target, node cap, MultiPV, and
// whether the hash is cleared first so a rerun is independent
export interface CertifyOptions {
  depth: number
  nodes: number // hard stop
  movetime?: number // the time budget, ms
  multipv: number
  clearHash: boolean
  timeoutMs?: number
}

type LineEval = { type: 'cp' | 'mate'; value: number }

export interface CertifiedRun {
  lines: { pv: string[]; eval: LineEval }[]
  depth: number
  nodes: number
  capped: boolean
  // The best line two iterations earlier, for the stability check: the
  // same search, so it costs nothing (a rerun with a cleared hash returns
  // the identical answer on one thread, measured)
  check?: { depth: number; pv: string[]; eval: LineEval }
}

export class EngineStalled extends Error {}

// Runs searches one at a time; UCI has no request ids, so overlapping
// searches would mix up their output. Supervised: a search that runs past
// its timeout kills the worker and starts a fresh one.
export class Engine {
  private queue: Promise<unknown> = Promise.resolve()
  private listener: (line: string) => void = () => {}
  private uci: UciEngine
  private make?: () => UciEngine

  constructor(uci: UciEngine | (() => UciEngine)) {
    this.make = typeof uci === 'function' ? uci : undefined
    this.uci = this.start(typeof uci === 'function' ? uci() : uci)
  }

  private failed: () => void = () => {}

  private start(uci: UciEngine): UciEngine {
    uci.onLine(line => this.listener(line))
    // A crashed worker: fail the running search and start over
    uci.onError?.(() => {
      this.failed()
      this.restart()
    })
    uci.send('uci')
    uci.send('setoption name Hash value 32')
    return uci
  }

  private restarts = 0

  // Start a fresh worker, a few times at most and not in a tight loop: a
  // build that can't run in this browser must not spin the page
  private restart() {
    this.uci.terminate?.()
    if (!this.make || this.restarts >= 3) return
    const delay = 500 * 2 ** this.restarts++
    setTimeout(() => (this.uci = this.start(this.make!())), delay)
  }

  // Ends the running search early (UCI stop): it still answers, so callers
  // that stop someone else's search must throw that answer away
  stop() {
    this.uci.send('stop')
  }

  // Wait until the worker has finished its startup handshake. Calling this
  // during app boot means the first real search starts from a warm engine.
  ready(): Promise<void> {
    return this.queue.then(() =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new EngineStalled('Stockfish did not become ready')), 5000)
        this.listener = line => {
          if (line === 'readyok') {
            clearTimeout(timer)
            resolve()
          }
        }
        this.uci.send('isready')
      }),
    )
  }

  certify(fen: string, o: CertifyOptions): Promise<CertifiedRun> {
    const run = () =>
      new Promise<CertifiedRun>((resolve, reject) => {
        const lines: CertifiedRun['lines'] = []
        let depth = 0
        let nodes = 0
        const byDepth = new Map<number, { pv: string[]; eval: LineEval }>()
        const timer = setTimeout(() => {
          this.listener = () => {}
          this.restart()
          reject(new EngineStalled(`Stockfish stopped answering on ${fen}`))
        }, o.timeoutMs ?? 120_000)
        this.failed = () => {
          clearTimeout(timer)
          this.listener = () => {}
          reject(new EngineStalled(`Stockfish crashed on ${fen}`))
        }
        const go = () => {
          this.listener = line => {
            if (line.startsWith('bestmove')) {
              clearTimeout(timer)
              const earlier = byDepth.get(depth - 2)
              return resolve({ lines: lines.filter(Boolean), depth, nodes, capped: depth < o.depth, check: earlier && { depth: depth - 2, ...earlier } })
            }
            const parsed = parseInfo(line)
            if (!parsed) return
            const n = Number(line.match(/ nodes (\d+)/)?.[1] ?? 0)
            if (n) nodes = n
            // Only complete iterations count: the first line of a new depth
            if (parsed.multipv === 1) depth = parsed.depth
            const entry = { pv: parsed.pv, eval: (parsed.eval.mate !== undefined ? { type: 'mate', value: parsed.eval.mate } : { type: 'cp', value: parsed.eval.cp ?? 0 }) as LineEval }
            lines[parsed.multipv - 1] = entry
            // A bound (lowerbound/upperbound) is a search still in progress
            if (parsed.multipv === 1 && !/ (lower|upper)bound /.test(line)) byDepth.set(parsed.depth, entry)
          }
          this.uci.send(`setoption name MultiPV value ${o.multipv}`)
          this.uci.send(`position fen ${fen}`)
          this.uci.send(`go depth ${o.depth} nodes ${o.nodes}${o.movetime ? ` movetime ${o.movetime}` : ''}`)
        }
        if (!o.clearHash) return go()
        // A cleared hash makes the second run independent of the first
        this.listener = line => {
          if (line === 'readyok') go()
        }
        this.uci.send('ucinewgame')
        this.uci.send('setoption name Clear Hash')
        this.uci.send('isready')
      })
    const next = this.queue.then(run)
    this.queue = next.catch(() => {})
    return next
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
