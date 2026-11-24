import { afterEach, describe, expect, it, vi } from 'vitest'
import { startPings } from './ping'

describe('startPings', () => {
  afterEach(() => vi.useRealTimers())

  it('pings on load, once more at the first touch of a board, and every five minutes after', async () => {
    vi.useFakeTimers()
    const sent: boolean[] = []
    const fetchFn = (async (_: string, init: RequestInit) => (sent.push(JSON.parse(init.body as string).active), new Response('{}'))) as unknown as typeof fetch
    document.body.innerHTML = '<p id="text"></p><cg-board><piece id="piece"></piece></cg-board>'
    const press = (id: string) => document.getElementById(id)!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    startPings(fetchFn)
    expect(sent).toEqual([false])
    press('text')
    expect(sent).toEqual([false])
    press('piece')
    press('piece')
    expect(sent).toEqual([false, true])
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(sent).toEqual([false, true, true])
  })
})
