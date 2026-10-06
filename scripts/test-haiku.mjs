// live check: prove anthropic/claude-haiku-4.5 serves on this key.
// Usage: OPENROUTER_API_KEY=sk-… bun scripts/test-haiku.mjs
// Prints the served model, latency and provider-reported cost; exits 1 on any
// non-OK status (a 403 here means the slug does not serve on the key).

const key = process.env.OPENROUTER_API_KEY
if (!key) {
  console.error('OPENROUTER_API_KEY is not set')
  process.exit(1)
}

const started = performance.now()
const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://lidrill.org', 'X-Title': 'lidrill check' },
  body: JSON.stringify({
    model: 'anthropic/claude-haiku-4.5',
    temperature: 0,
    max_tokens: 32,
    messages: [
      { role: 'system', content: 'You answer with JSON only.' },
      { role: 'user', content: 'Answer: {"ok":true,"model":"claude-haiku-4.5"}' },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'ok', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } },
    usage: { include: true },
  }),
})
const latencyMs = Math.round(performance.now() - started)
const data = await res.json().catch(() => ({}))

if (!res.ok) {
  console.error(`FAIL status=${res.status} latency=${latencyMs}ms body=${JSON.stringify(data).slice(0, 400)}`)
  process.exit(1)
}

console.log(`OK served=${data.model} latency=${latencyMs}ms cost=$${data.usage?.cost ?? 'n/a'} content=${JSON.stringify(data.choices?.[0]?.message?.content)}`)
