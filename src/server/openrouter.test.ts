import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LlmCall } from './narrate'
import { openRouter } from './openrouter'

// The auto-router contract (docs/21k-design.md (e), openrouter.ai/docs/guides/
// routing/routers/auto-router): model openrouter/auto, the auto-router plugin
// with cost_tier 'low', and provider.max_price as the documented object
// { prompt, completion } in $/M tokens capping what the router may pick.
// Draft and decompose stay pinned and send no router fields.

const routed: LlmCall = { pass: 'smooth', model: 'openrouter/auto', temperature: 0.3, maxTokens: 900, system: 's', user: 'u', schema: { type: 'object' }, routing: { usdPerMTokIn: 0.75, usdPerMTokOut: 3.75 } }
const pinned: LlmCall = { pass: 'draft', model: 'google/gemini-3.8-flash', temperature: 0.3, maxTokens: 900, system: 's', user: 'u', schema: { type: 'object' } }

afterEach(() => vi.unstubAllGlobals())

describe('openRouter caller', () => {
  it('rides the auto-router on a routed call and records the served model', async () => {
    let sent: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', async (_url: string, init?: { body?: string }) => {
      sent = JSON.parse(init!.body!)
      return new Response(JSON.stringify({ model: 'openai/gpt-5.1', choices: [{ message: { content: '{"ok":true}' } }], usage: { cost: 0.0012 } }), { status: 200 })
    })
    const r = await openRouter('key')(routed)
    // the documented max_price shape is an object of $/M-token rates, not a
    // bare number - a bare number is a 400 from OpenRouter
    expect(sent).toMatchObject({
      model: 'openrouter/auto',
      plugins: [{ id: 'auto-router', cost_tier: 'low' }],
      provider: { require_parameters: true, max_price: { prompt: 0.75, completion: 3.75 } },
    })
    expect((sent!.provider as Record<string, unknown>).max_price).toEqual({ prompt: 0.75, completion: 3.75 })
    expect(r).toEqual({ json: { ok: true }, cost: 0.0012, model: 'openai/gpt-5.1' })
  })

  it('pins draft and decompose: the pinned slug, no router fields', async () => {
    let sent: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', async (_url: string, init?: { body?: string }) => {
      sent = JSON.parse(init!.body!)
      return new Response(JSON.stringify({ model: pinned.model, choices: [{ message: { content: '{}' } }], usage: { cost: 0 } }), { status: 200 })
    })
    await openRouter('key')(pinned)
    expect(sent!.model).toBe('google/gemini-3.8-flash')
    expect(sent).not.toHaveProperty('plugins')
    expect((sent!.provider as Record<string, unknown>).max_price).toBeUndefined()
  })

  it('a non-ok response carries the provider cost and served model, no json', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ model: 'x', usage: { cost: 0.0001 } }), { status: 500 }))
    const r = await openRouter('key')(pinned)
    expect(r).toEqual({ cost: 0.0001, model: 'x' })
  })
})
