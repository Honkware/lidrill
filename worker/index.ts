import { issue, verify } from '../src/server/guard'
import { narrate, type Caller } from '../src/server/narrate'
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

// One OpenRouter call: pinned model, temperature, strict JSON schema, a
// timeout, and the provider-reported cost for the budget
function openRouter(env: Env): Caller {
  return async c => {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(25_000),
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://lidrill.org', 'X-Title': 'lidrill' },
      body: JSON.stringify({
        model: c.model,
        temperature: c.temperature,
        max_tokens: c.maxTokens,
        messages: [
          { role: 'system', content: c.system },
          { role: 'user', content: c.user },
        ],
        response_format: { type: 'json_schema', json_schema: { name: c.pass === 'decompose' ? 'claims' : 'slots', strict: true, schema: c.schema } },
        provider: { require_parameters: true },
        reasoning: { exclude: true, effort: 'low' },
        usage: { include: true },
      }),
    })
    const data = (await res.json().catch(() => ({}))) as { model?: string; usage?: { cost?: number }; choices?: { message?: { content?: string } }[] }
    const cost = data.usage?.cost ?? 0
    if (!res.ok) return { cost, model: data.model }
    const content = data.choices?.[0]?.message?.content ?? ''
    let parsed: unknown
    try {
      parsed = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ''))
    } catch {
      parsed = undefined
    }
    return { json: parsed, cost, model: data.model }
  }
}

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
  const n = problems.length ? { slots: templateFloor(packet), source: 'floor' as const, reason: `packet self-check: ${problems[0]}`, calls: 0, cost: 0, models: [] } : await narrate(packet, openRouter(env))
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
