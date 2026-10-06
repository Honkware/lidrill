import { issue, verify } from '../src/server/guard'
import { narrate } from '../src/server/narrate'
import { openRouter } from '../src/server/openrouter'
import { buildPacket, packetHash, packetProblems, validReport } from '../src/server/packet'
import { templateFloor } from '../src/server/floor'
import { sha256Hex } from '../src/server/sha256'

// lidrill is a static site; this Worker only answers /api/*. Everything else
// is served from the assets without running it (run_worker_first).

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
  OPENROUTER_API_KEY: string
  POW_SECRET: string
  EXPLAIN_LIMIT: { limit(options: { key: string }): Promise<{ success: boolean }> }
}

// Bumped with the shape of explanations: the browser asks again for anything older
export const EXPLAIN_VERSION = 9

const ORIGINS = [/^https:\/\/(www\.)?lidrill\.org$/, /^https:\/\/lidrill\.lidrill\.workers\.dev$/, /^http:\/\/localhost:\d+$/]

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } })

async function challenge(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  return json(await issue(env.POW_SECRET, ip))
}

// The browser's Stockfish report → packet → narrator (or floor). The answer
// is cached by request body, so replaying a request costs nothing.
async function explain(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405)
  const origin = request.headers.get('origin') ?? ''
  if (!ORIGINS.some(o => o.test(origin))) return json({ error: 'Not from lidrill' }, 403)
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const body = await request.text()
  if (body.length > 200_000) return json({ error: 'Too large' }, 413)
  const problem = await verify(env.POW_SECRET, ip, request.headers.get('x-lidrill-proof'), body)
  if (problem) return json({ error: `Request not accepted (${problem}). Try again.` }, 401)

  const cacheKey = new Request(`https://lidrill.org/api/explain-cache/${sha256Hex(body)}`)
  const cache = (caches as unknown as { default: Cache }).default
  const hit = await cache.match(cacheKey)
  if (hit) return hit

  if (!(await env.EXPLAIN_LIMIT.limit({ key: ip })).success) return json({ error: 'Too many explanations at once. Try again in a minute.' }, 429)
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return json({ error: 'That isn’t a puzzle report.' }, 400)
  }
  if (raw && typeof raw === 'object' && 'best' in raw && (raw as { best: { san?: unknown } }).best?.san) return json({ error: 'lidrill was updated. Reload the page.' }, 409)
  const report = validReport(raw)
  if (!report) return json({ error: 'That isn’t a puzzle report.' }, 400)
  const built = buildPacket(report)
  if (!built.ok) return json({ error: `That position can’t be explained (${built.error}).` }, 422)
  const packet = built.packet
  packet.meta.packetHash = await packetHash({ fen: report.fen, solution: report.solution, band: report.band })

  // A packet that fails its own self-check never reaches the model
  const problems = packetProblems(packet)
  const n = problems.length ? { slots: templateFloor(packet), source: 'floor' as const, reason: `packet self-check: ${problems[0]}`, calls: 0, cost: 0, models: [] } : await narrate(packet, openRouter(env.OPENROUTER_API_KEY))
  const response = json(
    { slots: n.slots, packet, source: n.source, reason: n.reason, models: n.models, calls: n.calls, cost: Number(n.cost.toFixed(5)), version: EXPLAIN_VERSION },
    200,
    { 'cache-control': 'public, max-age=86400' },
  )
  ctx.waitUntil(cache.put(cacheKey, response.clone()))
  return new Response(response.body, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api/challenge') return challenge(request, env)
    if (url.pathname === '/api/explain') return explain(request, env, ctx)
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404)
    return env.ASSETS.fetch(request)
  },
}
