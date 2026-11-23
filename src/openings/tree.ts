import { Chess } from 'chessops/chess'
import { makeFen } from 'chessops/fen'
import { parseUci } from 'chessops/util'
import type { Game, Opening } from '../db'
import { swings } from '../metrics'
import type { Policy, Reply } from './policy'
import { DEPTH, keyOf, posKey, startsWith } from './repertoire'

// An opening's tree against the people Maia models. From the end of the
// opening's moves, the player's turn follows their repertoire move and the
// opponent's turn takes every reply Maia plays at least THRESHOLD of the
// time, down to the player's DEPTH-th move. Coverage is the share of the
// player's turns in that tree that have an answer, each weighted by the
// chance of reaching it. A turn without an answer ends its branch, since
// nothing past it can be known.

// Replies under 5% are dropped: one move in twenty is about the rarest a
// player meets often enough to prepare for, and keeping them makes the tree
// several times larger. The replies kept are weighted among themselves.
export const THRESHOLD = 0.05

// A position the player has gone wrong in before counts as twice as likely
// when ranking what to learn next
export const WRONG_BOOST = 2

// A move that cost this much is a mistake here even where the judgment,
// which works on winning chances, lets it pass in an already won position
const BIG_DROP_CP = 200

// A position with the player to move
export interface TreeNode {
  fen: string
  moves: string[] // UCI from the start
  reach: number // chance of reaching it from the end of the opening's moves
  answer?: string // the repertoire move, if there is one
}

export interface Tree {
  coverage: number
  nodes: TreeNode[]
}

export const kept = (replies: Reply[]) => replies.filter(r => r.p >= THRESHOLD)

// The opponent is to move and every position the player could reach after
// its reply is past the depth
export const pastDepth = (pos: Chess) => pos.fullmoves + (pos.turn === 'black' ? 1 : 0) > DEPTH

export async function buildTree(opening: Opening, rep: Map<string, string>, policy: Policy): Promise<Tree> {
  const nodes: TreeNode[] = []
  const root = Chess.default()
  for (const m of opening.moves) root.play(parseUci(m)!)

  const walk = async (pos: Chess, moves: string[], reach: number): Promise<void> => {
    if (pos.isEnd()) return
    if (pos.turn === opening.color) {
      if (pos.fullmoves > DEPTH) return
      const answer = rep.get(keyOf(pos))
      nodes.push({ fen: makeFen(pos.toSetup()), moves, reach, answer })
      if (!answer) return
      const next = pos.clone()
      next.play(parseUci(answer)!)
      return walk(next, [...moves, answer], reach)
    }
    if (pastDepth(pos)) return
    // A position where every move is under the cut (rare: it takes twenty
    // or more moves about equally likely) keeps Maia's favourite
    const all = await policy(moves)
    const replies = kept(all).length ? kept(all) : all.slice(0, 1)
    const total = replies.reduce((s, r) => s + r.p, 0)
    for (const r of replies) {
      const next = pos.clone()
      next.play(parseUci(r.uci)!)
      await walk(next, [...moves, r.uci], (reach * r.p) / total)
    }
  }

  await walk(root, [...opening.moves], 1)
  const all = nodes.reduce((s, n) => s + n.reach, 0)
  const answered = nodes.reduce((s, n) => s + (n.answer ? n.reach : 0), 0)
  // An opening whose own moves already reach the depth leaves nothing to learn
  return { coverage: all ? answered / all : 1, nodes }
}

// Positions the repertoire has no answer for, most worth learning first
export function rankGaps(nodes: TreeNode[], wrong: Set<string>): TreeNode[] {
  return nodes.filter(n => !n.answer).sort((a, b) => score(b, wrong) - score(a, wrong))
}

export const score = (n: { fen: string; reach: number }, wrong: Set<string>) => n.reach * (wrong.has(posKey(n.fen)) ? WRONG_BOOST : 1)

// Positions in the player's games, inside the tree depth, where their move
// was judged an inaccuracy or worse or lost a lot
export function wentWrong(games: Game[]): Set<string> {
  const out = new Set<string>()
  for (const g of games) {
    const big = new Set(swings(g).filter(s => s.swingCp >= BIG_DROP_CP).map(s => s.ply))
    const pos = Chess.default()
    for (const [i, m] of g.moves.slice(0, 2 * DEPTH).entries()) {
      if (pos.turn === g.color && (m.judg || big.has(i + 1))) out.add(keyOf(pos))
      pos.play(parseUci(m.uci)!)
    }
  }
  return out
}

// Cards a game makes in a trained opening it follows: the position where the
// player first left their repertoire, and any position with no repertoire
// move where they went wrong
export function gameCards(game: Game, rep: Map<string, string>, openings: Opening[], wrong: Set<string>): { fen: string; moves: string[]; opening: string }[] {
  const ucis = game.moves.map(m => m.uci)
  const o = openings.find(x => x.color === game.color && startsWith(ucis, x.moves))
  if (!o) return []
  const out: { fen: string; moves: string[]; opening: string }[] = []
  const pos = Chess.default()
  for (const [i, uci] of ucis.slice(0, 2 * DEPTH).entries()) {
    if (pos.turn === game.color && i >= o.moves.length) {
      const answer = rep.get(keyOf(pos))
      const card = { fen: makeFen(pos.toSetup()), moves: ucis.slice(0, i), opening: o.name }
      if (answer && answer !== uci) {
        out.push(card)
        break
      }
      if (!answer && wrong.has(keyOf(pos))) out.push(card)
    }
    pos.play(parseUci(uci)!)
  }
  return out
}
