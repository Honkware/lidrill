import { issue, verify } from '../src/server/guard'
import type { Band } from '../src/db'
import { explainCacheKey } from '../src/server/explainCache'
import { EXPLAIN_VERSION } from '../src/server/explainVersion'
import { narrate } from '../src/server/narrate'
import { openRouter } from '../src/server/openrouter'
import { reconcileWithLine } from '../src/server/consistency'
import { BANDS, buildPacket, membershipOf, packetHash, packetProblems, stampTier, validPacket, validReport, type Packet } from '../src/server/packet'
import { templateFloor } from '../src/server/floor'
import { sha256Hex } from '../src/server/sha256'

// lidrill is a static site; this Worker only answers /api/*. Everything else
// is served from the assets without running it (run_worker_first).

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

// Minimal KV surface (no @cloudflare/workers-types dependency)
interface KVNamespace {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
  OPENROUTER_API_KEY: string
  POW_SECRET: string
  EXPLAIN_LIMIT: RateLimit
  PACKET_LIMIT: RateLimit
  SYNC_LIMIT: RateLimit
  MAIA_LIMIT: RateLimit
  PACKETS: KVNamespace
  // Server tier (docs/server-tier.md): the loopback FastAPI service, reached
  // through its cloudflared quick tunnel, guarded by the shared secret
  BACKEND_URL: string
  LIDRILL_KEY: string
}

// The explanation version lives in src/server/explainVersion.ts, shared with
// the client, so a bump never leaves the two sides disagreeing.

// Packets are a deterministic rebuild of a report plus config: a cache, not a
// record. 30 days is longer than any sync cycle.
const PACKET_TTL = 30 * 86400

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/

const ORIGINS = [/^https:\/\/(www\.)?lidrill\.org$/, /^https:\/\/lidrill\.lidrill\.workers\.dev$/, /^http:\/\/localhost:\d+$/]

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } })

async function challenge(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  return json(await issue(env.POW_SECRET, ip))
}

// What every guarded endpoint checks: method, Origin, size, and the
// challenge + proof of work bound to this IP and this exact body.
async function guarded(request: Request, env: Env): Promise<{ ip: string; body: string } | Response> {
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405)
  const origin = request.headers.get('origin') ?? ''
  if (!ORIGINS.some(o => o.test(origin))) return json({ error: 'Not from lidrill' }, 403)
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const body = await request.text()
  if (body.length > 200_000) return json({ error: 'Too large' }, 413)
  const problem = await verify(env.POW_SECRET, ip, request.headers.get('x-lidrill-proof'), body)
  if (problem) return json({ error: `Request not accepted (${problem}). Try again.` }, 401)
  return { ip, body }
}

// The browser's certified report, stored as a packet for every player with
// the same position: build, self-check, stamp the tier,
// and write to KV only after a get-miss - the first player to hit a unique
// position builds it for everyone.
async function packet(request: Request, env: Env): Promise<Response> {
  const g = await guarded(request, env)
  if (g instanceof Response) return g
  if (!(await env.PACKET_LIMIT.limit({ key: g.ip })).success) return json({ error: 'Too many uploads at once. Try again in a minute.' }, 429)
  let raw: unknown
  try {
    raw = JSON.parse(g.body)
  } catch {
    return json({ error: 'That isn’t a puzzle report.' }, 400)
  }
  // The tier says which device ran the certification. Over the wire only the
  // browser's tier exists; 'server' is reserved for in-Worker build jobs.
  const tier = (raw as { tier?: unknown })?.tier
  if (tier !== undefined && tier !== 'client-lite') return json({ error: 'Unknown tier.' }, 400)
  const report = validReport(raw)
  if (!report) return json({ error: 'That isn’t a puzzle report.' }, 400)
  const built = buildPacket(report)
  if (!built.ok) return json({ error: `That position can’t be explained (${built.error}).` }, 422)
  // Collapse to the stored eval line before the self-check, the
  // store, and (on the explain path) the narrator ever see the packet
  const pkt = reconcileWithLine(stampTier(built.packet, 'client-lite'), report.lineCp)
  const problems = packetProblems(pkt)
  if (problems.length) return json({ error: `That position can’t be explained (${problems[0]}).` }, 422)
  const hash = await packetHash({ fen: report.fen, solution: report.solution, band: report.band })
  pkt.meta.packetHash = hash
  if (await env.PACKETS.get(hash)) return json({ packetHash: hash, existing: true })
  await env.PACKETS.put(hash, JSON.stringify(pkt), { expirationTtl: PACKET_TTL })
  return json({ packetHash: hash }, 201)
}

// One narration over a packet that already passed its self-check: the
// narrator (or the floor), cost-accounted, cached by request body - the key
// carries the solve frame, so a different solving move never
// receives another player's framing.
async function narrateAndCache(pkt: Packet, solved: string | undefined, cacheKey: Request, ctx: { waitUntil(p: Promise<unknown>): void }, env: Env): Promise<Response> {
  const problems = packetProblems(pkt)
  const solve = { move: solved, membership: membershipOf(solved, pkt) }
  const n = problems.length
    ? { slots: templateFloor(pkt, { membership: solve.membership, solvingRef: solve.membership === 'set' ? (pkt.alternatives.find(a => a.uci === solved)?.id ?? undefined) : undefined }), source: 'floor' as const, reason: `packet self-check: ${problems[0]}`, calls: 0, cost: 0, models: [] }
    : await narrate(pkt, openRouter(env.OPENROUTER_API_KEY), solve)
  const response = json(
    { slots: n.slots, packet: pkt, source: n.source, reason: n.reason, models: n.models, calls: n.calls, cost: Number(n.cost.toFixed(5)), version: EXPLAIN_VERSION, frame: solve.membership },
    200,
    { 'cache-control': 'public, max-age=86400' },
  )
  ctx.waitUntil((caches as unknown as { default: Cache }).default.put(cacheKey, response.clone()))
  return new Response(response.body, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}

// The slim shape: the request carries only a packet
// reference; the packet - including its narrative context - was baked at
// POST /api/packet time. A miss sends the client back to the legacy
// certify-and-POST path, which is the migration safety net.
async function explainV2(raw: unknown, packetHashWanted: string, env: Env): Promise<{ packet: Packet; solved?: string } | Response> {
  const q = raw as { band?: unknown; tried?: unknown; solved?: unknown }
  if (!BANDS.includes(q.band as Band)) return json({ error: 'That isn’t a packet reference.' }, 400)
  if (q.tried !== undefined && typeof q.tried !== 'string') return json({ error: 'That isn’t a packet reference.' }, 400)
  if (q.solved !== undefined && (typeof q.solved !== 'string' || !UCI.test(q.solved))) return json({ error: 'That isn’t a packet reference.' }, 400)
  const stored = await env.PACKETS.get(packetHashWanted)
  let pkt: Packet | undefined
  try {
    pkt = stored ? validPacket(JSON.parse(stored)) : undefined
  } catch {
    pkt = undefined
  }
  // A corrupt entry behaves like a miss: the client rebuilds and re-uploads
  if (!pkt) return json({ error: 'packet-miss' }, 404)
  if (pkt.context.band !== q.band) return json({ error: 'This explanation was built for another level.' }, 409)
  if (q.tried !== undefined && pkt.tried?.uci !== q.tried) return json({ error: 'packet-miss' }, 404)
  return { packet: pkt, solved: q.solved }
}

// The browser's Stockfish report → packet → narrator (or floor). The answer
// is cached by request body, so replaying a request costs nothing. Accepts
// the legacy report-in shape (v1) and the slim packet-reference shape (v2).
async function explain(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
  const g = await guarded(request, env)
  if (g instanceof Response) return g

  // Version in the key: an EXPLAIN_VERSION bump must not serve the old shape;
  // the key also carries the solve frame via the request's solving move
  //a different move - a different frame - is a different entry
  const cacheKey = explainCacheKey(EXPLAIN_VERSION, g.body)
  const cache = (caches as unknown as { default: Cache }).default
  const hit = await cache.match(cacheKey)
  if (hit) return hit

  if (!(await env.EXPLAIN_LIMIT.limit({ key: g.ip })).success) return json({ error: 'Too many explanations at once. Try again in a minute.' }, 429)
  let raw: unknown
  try {
    raw = JSON.parse(g.body)
  } catch {
    return json({ error: 'That isn’t a puzzle report.' }, 400)
  }

  if (raw && typeof raw === 'object' && (raw as { v?: unknown }).v === 2) {
    const wanted = (raw as { packetHash?: unknown }).packetHash
    if (typeof wanted !== 'string' || !wanted.startsWith('sha256:')) return json({ error: 'That isn’t a packet reference.' }, 400)
    const v2 = await explainV2(raw, wanted, env)
    if (v2 instanceof Response) return v2
    return narrateAndCache(v2.packet, v2.solved, cacheKey, ctx, env)
  }

  if (raw && typeof raw === 'object' && 'best' in raw && (raw as { best: { san?: unknown } }).best?.san) return json({ error: 'lidrill was updated. Reload the page.' }, 409)
  const report = validReport(raw)
  if (!report) return json({ error: 'That isn’t a puzzle report.' }, 400)
  // The solving move selects the explanation frame; absent, the
  // contrast (miss) frame serves, as before
  const solved = (raw as { solved?: unknown }).solved
  if (solved !== undefined && (typeof solved !== 'string' || !UCI.test(solved))) return json({ error: 'That isn’t a puzzle report.' }, 400)
  const built = buildPacket(report)
  if (!built.ok) return json({ error: `That position can’t be explained (${built.error}).` }, 422)
  const pkt = reconcileWithLine(stampTier(built.packet, 'client-lite'), report.lineCp)
  pkt.meta.packetHash = await packetHash({ fen: report.fen, solution: report.solution, band: report.band })

  // A packet that fails its own self-check never reaches the model
  return narrateAndCache(pkt, solved, cacheKey, ctx, env)
}

// --- Server tier: /api/sync/* is the only
// door to the loopback backend. The client sends its Lichess token; we
// validate it with Lichess (cached 15 min per token), and only the account
// username goes into the backend URL - the token never reaches the VM.

const ACCOUNT_TTL = 15 * 60

async function accountFor(token: string, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<{ username: string } | Response> {
  // Cloudflare extends Cache.put with expirationTtl; the DOM type doesn't know it
  const cache = (caches as unknown as { default: Cache & { put(key: Request, response: Response, options?: { expirationTtl?: number }): Promise<void> } }).default
  const key = new Request(`https://lidrill.org/api/sync-account/${await sha256Hex(token)}`)
  try {
    const hit = await cache.match(key)
    if (hit) return (await hit.json()) as { username: string }
  } catch {
    // a broken cache just means we ask Lichess again
  }
  const res = await fetch('https://lichess.org/api/account', { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) return json({ error: 'sign-in-expired' }, 401)
  const { username } = (await res.json()) as { username?: string }
  if (!username) return json({ error: 'sign-in-expired' }, 401)
  const account = { username }
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify(account), { headers: { 'cache-control': 'no-store' } }), { expirationTtl: ACCOUNT_TTL }).catch(() => {}))
  return account
}

// Any /api/sync/<path> → BACKEND_URL/u/<username>/<path>. The shared secret
// is VM-local (Worker secret → tunnel → loopback), never exposed to clients.
async function syncProxy(request: Request, url: URL, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!token) return json({ error: 'Sign in with Lichess to sync.' }, 401)
  const account = await accountFor(token, ctx)
  if (account instanceof Response) return account
  if (!(await env.SYNC_LIMIT.limit({ key: account.username })).success) return json({ error: 'Too many syncs at once. Try again in a minute.' }, 429)
  const path = url.pathname.slice('/api/sync'.length)
  const upstream = `${env.BACKEND_URL}/u/${encodeURIComponent(account.username)}${path}${url.search}`
  const method = request.method
  const res = await fetch(upstream, {
    method,
    headers: { 'x-lidrill-key': env.LIDRILL_KEY, ...(method === 'POST' || method === 'PUT' || method === 'DELETE' ? { 'content-type': request.headers.get('content-type') ?? 'application/json' } : {}) },
    ...(method === 'POST' || method === 'PUT' ? { body: await request.text() } : {}),
  })
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } })
}

// One Maia-3 move for a game in progress. The model runs on the backend, on
// a CPU that costs nothing per call, so an Origin check and a per-visitor
// rate limit are enough here and a move doesn't wait on a proof of work.
async function maiaMove(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405)
  if (!ORIGINS.some(o => o.test(request.headers.get('origin') ?? ''))) return json({ error: 'Not from lidrill' }, 403)
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  if (!(await env.MAIA_LIMIT.limit({ key: ip })).success) return json({ error: 'Too many moves at once. Try again in a minute.' }, 429)
  const body = await request.text()
  if (body.length > 10_000) return json({ error: 'Too large' }, 413)
  const res = await fetch(`${env.BACKEND_URL}/maia/move`, { method: 'POST', headers: { 'x-lidrill-key': env.LIDRILL_KEY, 'content-type': 'application/json' }, body })
  if (res.status === 400) return json({ error: 'Maia can’t move from that position.' }, 400)
  if (!res.ok) return json({ error: 'Maia isn’t available right now.' }, 502)
  return json(await res.json())
}

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api/challenge') return challenge(request, env)
    if (url.pathname === '/api/packet') return packet(request, env)
    if (url.pathname === '/api/explain') return explain(request, env, ctx)
    if (url.pathname === '/api/maia/move') return maiaMove(request, env)
    if (url.pathname.startsWith('/api/sync/')) return syncProxy(request, url, env, ctx)
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404)
    return env.ASSETS.fetch(request)
  },
}
