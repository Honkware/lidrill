import type { Game } from '../db'
import { CERT, cpOf, verdictOf, type Packet } from './packet'

// Cross-moment consistency (Turning Points): consecutive critical
// moments from one game must be monotone-consistent with the stored
// certified eval line within τ_instab; violations collapse to the weaker
// verdict. Two certifications of positions from the same game can disagree
// under eval jitter and contradict each other across stops; anchoring every
// packet to the game's own stored line (the Lichess analysis evals kept on
// game.moves) keeps the narration consistent with what the review screen
// shows, stop after stop.
//
// The rule runs wherever a packet is born (the Worker, before the narrator
// sees it) and again at the Turning Points consistency point in
// src/replay.ts, so rows stored before this check also collapse when shown.

export const LINE_REFUSAL = 'inconsistent with the stored eval line'

// The stored line's eval for the position before `ply` (1-indexed), in the
// player's point of view, as cp (mates converted so they compare like cp).
// undefined when the line has no eval there (the start position, book moves).
export function lineEvalCp(game: Game, ply: number): number | undefined {
  const e = game.moves[ply - 2]?.eval
  if (!e) return undefined
  const whitePov = e.mate !== undefined ? cpOf({ type: 'mate', value: e.mate }) : Math.max(-10000, Math.min(10000, e.cp ?? 0))
  return game.color === 'black' ? -whitePov : whitePov
}

// Collapse a packet that contradicts the stored line by more than τ_instab
// to the weaker verdict. The weaker verdict is the one closer to equal; on a
// tie (opposite signs, same size) the stored line wins, since it is the
// certification the rest of the game screen already shows. A certified mate
// is never touched (certified mates survive draw claims; an eval line
// can hide a mate below its horizon, so the line never overrides one).
// Idempotent: an already-collapsed packet collapses to itself.
export function reconcileWithLine(packet: Packet, lineCp: number | undefined): Packet {
  const before = packet.eval.before
  if (lineCp === undefined || before.type !== 'cp') return packet
  const at = cpOf(before)
  if (Math.abs(at - lineCp) <= CERT.instabCp) return packet
  const weaker = Math.abs(at) < Math.abs(lineCp) ? at : lineCp
  const p: Packet = structuredClone(packet)
  p.eval.before = { type: 'cp', value: weaker, stable: false, range: [Math.min(at, lineCp), Math.max(at, lineCp)], reachedDepth: before.reachedDepth }
  p.eval.verdict.before = verdictOf(p.eval.before)
  const after = packet.eval.afterPlayed
  if (p.played?.swing && p.played.swing.type === 'cp' && after?.type === 'cp') p.played.swing = { ...p.played.swing, value: cpOf(after) - weaker }
  const c = p.meta.certification
  if (!c.refusals.includes(LINE_REFUSAL)) c.refusals.push(LINE_REFUSAL)
  if (c.status === 'certified') c.status = 'partial'
  return p
}
