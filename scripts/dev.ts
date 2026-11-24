// `bun run dev`: Vite with hot reload, and the Worker beside it so /api/*
// answers. Vite proxies /api to the Worker (vite.config.ts). The Python
// service in server/ is optional and started by hand; this only reports on it.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'

const VITE_PORT = 5173
// Also the proxy target in vite.config.ts
const WORKER_PORT = 8787

const procs: ChildProcess[] = []

function stop(code: number): never {
  for (const p of procs) p.kill()
  process.exit(code)
}

function run(cmd: string, args: string[]) {
  // No stdin for the children, so wrangler's hotkeys don't take the terminal
  const p = spawn(`node_modules/.bin/${cmd}`, args, { stdio: ['ignore', 'inherit', 'inherit'] })
  p.on('exit', code => stop(code ?? 1))
  procs.push(p)
}

function devVars(): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const line of readFileSync('.dev.vars', 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m) vars[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2')
  }
  return vars
}

async function workerUp(): Promise<boolean> {
  for (let i = 0; i < 120; i++) {
    const up = await fetch(`http://localhost:${WORKER_PORT}/api/challenge`).then(
      r => r.ok,
      () => false,
    )
    if (up) return true
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}

const OFF = 'Maia games, opening trees and sync are off'

async function backend(vars: Record<string, string>): Promise<string> {
  if (!vars.BACKEND_URL) return `BACKEND_URL is not in .dev.vars: ${OFF}`
  const res = await fetch(`${vars.BACKEND_URL}/health`, { headers: { 'x-lidrill-key': vars.LIDRILL_KEY ?? '' }, signal: AbortSignal.timeout(2000) }).catch(() => null)
  if (!res) return `not running: ${OFF}`
  if (res.status === 401) return `${vars.BACKEND_URL} refused the LIDRILL_KEY in .dev.vars: ${OFF}`
  return res.ok ? `running at ${vars.BACKEND_URL}` : `${vars.BACKEND_URL} answered ${res.status}: ${OFF}`
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

run('vite', ['--port', String(VITE_PORT), '--strictPort'])

if (!existsSync('.dev.vars')) {
  console.log('[dev] Worker: not started, /api is off. Copy .dev.vars.example to .dev.vars and start again.')
} else {
  const vars = devVars()
  // wrangler refuses to start without the assets directory a build leaves
  mkdirSync('dist', { recursive: true })
  // wrangler dev rewrites an Origin that matches the request's Host to its
  // upstream, by default the route in wrangler.jsonc, and the Worker's Origin
  // check then answers 403. Naming Vite as the upstream keeps it as sent.
  run('wrangler', ['dev', '--port', String(WORKER_PORT), '--local-upstream', `localhost:${VITE_PORT}`, '--upstream-protocol', 'http', '--show-interactive-dev-session=false'])
  const up = await workerUp()
  const key = vars.OPENROUTER_API_KEY
  console.log(`[dev] Worker: ${up ? `running at http://localhost:${WORKER_PORT}, reached through http://localhost:${VITE_PORT}/api` : 'did not start, see the wrangler output above'}`)
  console.log(`[dev] Python backend: ${await backend(vars)}`)
  console.log(`[dev] OpenRouter key: ${key && key !== 'your-openrouter-key' ? 'set' : 'not set, explanations are off'}`)
}
