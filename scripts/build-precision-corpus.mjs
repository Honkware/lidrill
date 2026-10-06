#!/usr/bin/env bun
// Builds the human-review corpus for the precision page (the
// release gate needs ≥99% claim-level precision, marked by a human).
//
//   bun scripts/build-precision-corpus.mjs
//
// Claims come from the gate corpus. Narrated claims are preferred: run the
// gate first (OPENROUTER_API_KEY=… GATE=1 bun run test:gate) so gate-out.json
// exists - then the corpus holds what the narrator actually wrote. Without
// it the corpus is built from the deterministic floor text of the same
// reports (source: "floor"), which still exercises the page end to end;
// re-run this script after a narrated gate to review model claims.
//
// Output: src/server/fixtures/precision-corpus.json
//   { schema, source, generatedAt, claims: [{ id, fen, band, slot, text }] }
// Claim ids are stable across rebuilds (report/band/slot/sentence), so a
// reviewer's marks survive a corpus refresh.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { SLOTS } from '../src/server/render.ts'
import { buildPacket, validReport } from '../src/server/packet.ts'
import { templateFloor } from '../src/server/floor.ts'
import { renderText } from '../src/server/render.ts'

const OUT = 'src/server/fixtures/precision-corpus.json'
const TARGET = 50

const reports = JSON.parse(readFileSync('src/server/fixtures/gate-reports.json', 'utf8'))
const narrated = existsSync('gate-out.json') ? JSON.parse(readFileSync('gate-out.json', 'utf8')) : undefined

// One claim per sentence, in corpus order
const claims = []
for (const [reportIndex, raw] of reports.entries()) {
  const narratedBands = new Map((narrated?.results ?? []).filter(r => r.fen === raw.fen).map(r => [r.band, r]))
  for (const band of ['beginner', 'club', 'advanced']) {
    const idPrefix = `g${reportIndex}-${band}`
    const narratedBand = narratedBands.get(band)
    if (narratedBand?.slots) {
      for (const slot of narratedBand.slots) {
        for (const [sentenceIndex, text] of slot.text.split(/(?<=\.)\s+/).filter(Boolean).entries())
          claims.push({ id: `${idPrefix}-${slot.slot}-${sentenceIndex}`, fen: raw.fen, band, slot: slot.slot, text })
      }
      continue
    }
    const report = validReport(JSON.parse(JSON.stringify({ ...raw, band })))
    if (!report) continue
    const built = buildPacket(report)
    if (!built.ok) continue
    const text = renderText(templateFloor(built.packet), built.packet)
    for (const slot of SLOTS)
      for (const [sentenceIndex, sentence] of text[slot].split(/(?<=\.)\s+/).filter(Boolean).entries())
        claims.push({ id: `${idPrefix}-${slot}-${sentenceIndex}`, fen: raw.fen, band, slot, text: sentence })
  }
}

// ~50 claims, spread evenly across the whole corpus
const picked = claims.length <= TARGET ? claims : Array.from({ length: TARGET }, (_, k) => claims[Math.round((k * (claims.length - 1)) / (TARGET - 1))])

const corpus = {
  schema: 'lidrill-precision-corpus/1',
  source: narrated?.results?.length ? 'model' : 'floor',
  generatedAt: new Date().toISOString(),
  claims: picked,
}
writeFileSync(OUT, `${JSON.stringify(corpus, null, 1)}\n`)
console.log(`${picked.length} claims (${corpus.source}) -> ${OUT}`)
