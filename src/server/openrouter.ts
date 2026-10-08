import type { Caller } from './narrate'

// One OpenRouter call: pinned model, temperature, strict JSON schema, a
// timeout, and the provider-reported cost for the budget. Router fields
// (plugins auto-router + provider.max_price) are sent only when the call
// carries `routing` - which narrate sets solely under its explicit
// autoRouter experiment opt-in (every production
// pass pinned, smooth included). The served model comes back in `model`.
// Captured at module load: the Stockfish WASM loader nulls globalThis.fetch
// on the node main thread, and the gate runs the engine and the narrator in
// the same process - a call-time lookup would find null and every pass would
// fail closed to the floor.
const fetchImpl: typeof fetch | undefined = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined

// Flake telemetry (instrument BEFORE fixing, refusal-reason
// telemetry bucketed by class): one JSON line per call with the HTTP status,
// the finish reason, the usage tokens, the latency, and the exact failure
// point. `outcome` is one of ok | http-<status> | fetch-throw | no-body |
// empty-content | json-parse. The fail-closed paths stay fail-closed - this
// only names why the floor served.
export interface CallTelemetry {
  pass: string
  model: string
  outcome: string
  status?: number
  finish?: string
  in?: number
  out?: number
  latencyMs: number
  detail?: string
}

export type CallLog = (t: CallTelemetry) => void

const jsonLine = (t: CallTelemetry) => console.warn(`llm-call ${JSON.stringify(t)}`)

export function openRouter(apiKey: string, timeoutMs = 45_000, log: CallLog = jsonLine): Caller {
  return async c => {
    const t0 = Date.now()
    const done = (outcome: string, extra: Partial<CallTelemetry> = {}): CallTelemetry => ({ pass: c.pass, model: c.model, outcome, latencyMs: Date.now() - t0, ...extra })
    let res: Response
    try {
      res = await (typeof globalThis.fetch === 'function' ? globalThis.fetch : fetchImpl!)('https://openrouter.ai/api/v1/chat/completions', {
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
          provider: { require_parameters: true, ...(c.routing ? { max_price: { prompt: c.routing.usdPerMTokIn, completion: c.routing.usdPerMTokOut } } : {}) },
          ...(c.routing ? { plugins: [{ id: 'auto-router', cost_tier: 'low' }] } : {}),
          reasoning: { exclude: true, effort: 'low' },
          usage: { include: true },
        }),
      })
    } catch (e) {
      log(done('fetch-throw', { detail: String(e) }))
      return { cost: 0 }
    }
    const data = (await res.json().catch(() => undefined)) as
      | { model?: string; usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number }; choices?: { finish_reason?: string; message?: { content?: string } }[] }
      | undefined
    const base = { status: res.status, finish: data?.choices?.[0]?.finish_reason, in: data?.usage?.prompt_tokens, out: data?.usage?.completion_tokens }
    const cost = data?.usage?.cost ?? 0
    if (!res.ok) {
      if (res.status === 403) {
        console.warn(`ALERT OpenRouter 403 FORBIDDEN on ${c.pass} (${c.model}) - the key is rejected or this slug does not serve on it. Do not assume a retry will fix this. Body: ${JSON.stringify(data).slice(0, 300)}`)
      } else {
        console.warn(`OpenRouter ${c.pass} ${res.status}: ${JSON.stringify(data).slice(0, 300)}`)
      }
      log(done(`http-${res.status}`, { ...base, detail: data ? JSON.stringify(data).slice(0, 200) : 'unreadable body' }))
      return { cost, model: data?.model }
    }
    if (!data) {
      log(done('no-body', base))
      return { cost }
    }
    const content = data.choices?.[0]?.message?.content ?? ''
    if (!content) {
      log(done('empty-content', { ...base, finish: data.choices?.[0]?.finish_reason ?? 'no-choice' }))
      return { cost, model: data.model }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ''))
    } catch {
      parsed = undefined
    }
    if (parsed === undefined) log(done('json-parse', { ...base, detail: content.slice(0, 120) }))
    else log(done('ok', base))
    return { json: parsed, cost, model: data.model }
  }
}
