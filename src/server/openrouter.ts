import type { Caller } from './narrate'

// One OpenRouter call: pinned model, temperature, strict JSON schema, a
// timeout, and the provider-reported cost for the budget. A call may instead
// ride the auto-router: model openrouter/auto,
// the auto-router plugin with cost_tier low, and provider.max_price as the
// documented { prompt, completion } per-million-dollar cap holding the
// reservation the budget check made. The served model comes back in `model`
// either way.
// Captured at module load: the Stockfish WASM loader nulls globalThis.fetch
// on the node main thread, and the gate runs the engine and the narrator in
// the same process - a call-time lookup would find null and every pass would
// fail closed to the floor.
const fetchImpl: typeof fetch | undefined = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined

export function openRouter(apiKey: string, timeoutMs = 45_000): Caller {
  return async c => {
    const auto = c.routing
    const res = await (typeof globalThis.fetch === 'function' ? globalThis.fetch : fetchImpl!)('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://lidrill.org', 'X-Title': 'lidrill' },
      body: JSON.stringify({
        model: c.model,
        temperature: c.temperature,
        max_tokens: c.maxTokens,
        messages: [
          { role: 'system', content: c.system },
          { role: 'user', content: c.user },
        ],
        response_format: { type: 'json_schema', json_schema: { name: c.pass === 'decompose' ? 'claims' : 'slots', strict: true, schema: c.schema } },
        provider: { require_parameters: true, ...(auto ? { max_price: { prompt: auto.usdPerMTokIn, completion: auto.usdPerMTokOut } } : {}) },
        ...(auto ? { plugins: [{ id: 'auto-router', cost_tier: 'low' }] } : {}),
        reasoning: { exclude: true, effort: 'low' },
        usage: { include: true },
      }),
    })
    const data = (await res.json().catch(() => ({}))) as { model?: string; usage?: { cost?: number }; choices?: { message?: { content?: string } }[] }
    const cost = data.usage?.cost ?? 0
    if (!res.ok) {
      if (res.status === 403) {
        console.warn(`ALERT OpenRouter 403 FORBIDDEN on ${c.pass} (${c.model}) - the key is rejected or this slug does not serve on it. Do not assume a retry will fix this. Body: ${JSON.stringify(data).slice(0, 300)}`)
      } else {
        console.warn(`OpenRouter ${c.pass} ${res.status}: ${JSON.stringify(data).slice(0, 300)}`)
      }
      return { cost, model: data.model }
    }
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
