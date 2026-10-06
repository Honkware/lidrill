import { analyse, check, EXPLAIN_VERSION, fallback, links, openRouterBody, validate, type ExplainRequest } from '../src/server/explain'

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

type Turn = { role: 'assistant' | 'user'; content: string }

async function ask(env: Env, facts: ExplainRequest, retry: Turn[] = []): Promise<{ text?: string; model?: string }> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://lidrill.org',
        'X-Title': 'lidrill',
      },
      body: JSON.stringify(openRouterBody(facts, retry)),
    })
    const data = (await res.json()) as { model?: string; choices?: { message?: { content?: string } }[] }
    return { text: res.ok ? data.choices?.[0]?.message?.content?.trim() || undefined : undefined, model: data.model }
  } catch {
    return {}
  }
}

// The model words the checked points; its answer is checked against the
// facts, gets one retry with the problems named, and otherwise the points
// themselves are shown. Nothing unchecked reaches the player.
async function explain(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405)
  const origin = request.headers.get('origin') ?? ''
  if (!ORIGINS.some(o => o.test(origin))) return json({ error: 'Not from lidrill' }, 403)
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  if (!(await env.EXPLAIN_LIMIT.limit({ key: ip })).success) return json({ error: 'Too many explanations at once. Try again in a minute.' }, 429)
  const facts = validate(await request.json().catch(() => undefined))
  if (!facts) return json({ error: 'That isn’t a puzzle position.' }, 400)
  const a = analyse(facts)

  let { text, model } = await ask(env, facts)
  let verdict = text ? check(text, a) : undefined
  if (text && !verdict!.ok) {
    const again = await ask(env, facts, [
      { role: 'assistant', content: text },
      { role: 'user', content: `Rewrite it. Problems: ${verdict!.problems.join('; ')}. Use only the points and the moves in the lines.` },
    ])
    text = again.text
    model = again.model ?? model
    verdict = text ? check(text, a) : undefined
  }
  const source = text && verdict?.ok ? 'model' : 'facts'
  if (source === 'facts') text = fallback(a)
  return json({ text, links: links(text!, a), source, version: EXPLAIN_VERSION, model: source === 'model' ? model : undefined })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api/explain') return explain(request, env)
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404)
    return env.ASSETS.fetch(request)
  },
}
