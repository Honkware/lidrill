// Smooth-pass live check: prove openrouter/auto serves with the documented
// provider.max_price {prompt, completion} object shape (a bare number 400s).
const key = process.env.OPENROUTER_API_KEY
if (!key) { console.error('OPENROUTER_API_KEY is not set'); process.exit(1) }

const started = performance.now()
const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://lidrill.org', 'X-Title': 'lidrill smooth check' },
  body: JSON.stringify({
    model: 'openrouter/auto',
    temperature: 0.3,
    max_tokens: 900,
    messages: [
      { role: 'system', content: 'You answer with JSON only.' },
      { role: 'user', content: 'Answer: {"ok":true}' },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'slots', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } },
    provider: { require_parameters: true, max_price: { prompt: 0.75, completion: 3.75 } },
    plugins: [{ id: 'auto-router', cost_tier: 'low' }],
    reasoning: { exclude: true, effort: 'low' },
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
