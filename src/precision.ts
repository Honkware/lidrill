// The human precision pass: the release gate needs ≥99%
// claim-level precision on the gate corpus, marked by a human. This module
// is the page's logic - claims from the gate corpus, marks kept in
// localStorage, a summary and an export the gate can ingest:
//
//   { schema: 'lidrill-precision/1', generatedAt, corpus: { source },
//     summary: { total, marked, right, wrong, unknown, precision },
//     claims: [{ id, band, slot, text, fen, mark }] }
//
// precision = right / (right + wrong); "cannot determine" is excluded from
// both sides (a claim the reviewer can't judge carries no precision signal).

import type { Band } from './db'
import type { SlotName } from './server/packet'
import corpusJson from './server/fixtures/precision-corpus.json'

export const corpus = corpusJson as PrecisionCorpus

export const PRECISION_SCHEMA = 'lidrill-precision/1'
export const PRECISION_MARKS_KEY = 'lidrill.precision.marks.v1'

export interface PrecisionClaim {
  id: string
  fen: string
  band: Band
  slot: SlotName
  text: string
}

export interface PrecisionCorpus {
  schema: 'lidrill-precision-corpus/1'
  source: 'model' | 'floor'
  generatedAt: string
  claims: PrecisionClaim[]
}

export type Mark = 'right' | 'wrong' | 'unknown'

export type Marks = Record<string, Mark>

export function loadMarks(): Marks {
  try {
    const raw = localStorage.getItem(PRECISION_MARKS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, v]) => v === 'right' || v === 'wrong' || v === 'unknown')) as Marks
  } catch {
    return {}
  }
}

export function saveMarks(marks: Marks): void {
  try {
    localStorage.setItem(PRECISION_MARKS_KEY, JSON.stringify(marks))
  } catch {
    // storage can be off (private mode): the pass just isn't kept
  }
}

export interface PrecisionSummary {
  total: number
  marked: number
  right: number
  wrong: number
  unknown: number
  // right / (right + wrong), or null when nothing judgeable is marked
  precision: number | null
}

export function summarize(claims: PrecisionClaim[], marks: Marks): PrecisionSummary {
  let right = 0
  let wrong = 0
  let unknown = 0
  for (const c of claims) {
    if (marks[c.id] === 'right') right++
    else if (marks[c.id] === 'wrong') wrong++
    else if (marks[c.id] === 'unknown') unknown++
  }
  const judged = right + wrong
  return { total: claims.length, marked: judged + unknown, right, wrong, unknown, precision: judged ? right / judged : null }
}

export interface PrecisionExport {
  schema: typeof PRECISION_SCHEMA
  generatedAt: string
  corpus: { source: PrecisionCorpus['source']; generatedAt: string }
  summary: PrecisionSummary
  claims: (PrecisionClaim & { mark: Mark | null })[]
}

export function exportMarks(data: PrecisionCorpus, marks: Marks): PrecisionExport {
  return {
    schema: PRECISION_SCHEMA,
    generatedAt: new Date().toISOString(),
    corpus: { source: data.source, generatedAt: data.generatedAt },
    summary: summarize(data.claims, marks),
    claims: data.claims.map(c => ({ ...c, mark: marks[c.id] ?? null })),
  }
}
