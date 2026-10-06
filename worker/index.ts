import { openRouterBody, validate } from '../src/server/explain'

// lidrill is a static site; this Worker only answers /api/*. Everything else
// is served from the assets without running it (run_worker_first).

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
  OPENROUTER_API_KEY: string
  EXPLAIN_LIMIT: { limit(options: { key: string }): Promise<{ success: boolean }> }
}

const ORIGINS = [/^https:\/\/(www\.)?lidrill\.org$/, /^https:\/\/lidrill\.lidrill\.workers\.dev$/, /^http:\/\/localhost:\d+$/]

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

async function explain(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405)
  const origin = request.headers.get('origin') ?? ''
  if (!ORIGINS.some(o => o.test(origin))) return json({ error: 'Not from lidrill' }, 403)
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  if (!(await env.EXPLAIN_LIMIT.limit({ key: ip })).success) return json({ error: 'Too many explanations at once. Try again in a minute.' }, 429)
  const facts = validate(await request.json().catch(() => undefined))
  if (!facts) return json({ error: 'That isn’t a puzzle position.' }, 400)

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://lidrill.org',
      'X-Title': 'lidrill',
    },
    body: JSON.stringify(openRouterBody(facts)),
  })
  const data = (await res.json().catch(() => ({}))) as { model?: string; choices?: { message?: { content?: string } }[]; error?: { message?: string } }
  const text = data.choices?.[0]?.message?.content?.trim()
  if (!res.ok || !text) return json({ error: 'The explanation service didn’t answer. Try again later.', upstream: res.status }, 502)
  return json({ text, model: data.model })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api/explain') return explain(request, env)
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404)
    return env.ASSETS.fetch(request)
  },
}
