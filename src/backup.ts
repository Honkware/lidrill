import { db, type Puzzle } from './db'

// One-file export of everything lidrill knows. The Lichess token
// is never in it, and the explorer cache is left out because it's only a
// cache.
const TABLES = ['games', 'puzzles', 'reviews', 'profile', 'syncState', 'journal', 'liPuzzle', 'practice'] as const
type TableName = (typeof TABLES)[number]

export interface Backup {
  app: 'lidrill'
  version: 1
  exportedAt: string
  tables: Record<TableName, unknown[]>
}

export async function exportData(): Promise<Backup> {
  const tables = {} as Backup['tables']
  for (const name of TABLES) tables[name] = await db.table(name).toArray()
  return { app: 'lidrill', version: 1, exportedAt: new Date().toISOString(), tables }
}

// JSON turns the FSRS card dates into strings
function reviveCard(p: Puzzle): Puzzle {
  const card = { ...p.card, due: new Date(p.card.due) }
  if (card.last_review) card.last_review = new Date(card.last_review)
  return { ...p, card }
}

// Replaces local data with the file's. Sign-in is kept as it is.
export async function importData(text: string): Promise<void> {
  const data = JSON.parse(text) as Backup
  if (data.app !== 'lidrill' || data.version !== 1 || typeof data.tables !== 'object')
    throw new Error("That file isn't a lidrill export.")
  await db.transaction('rw', TABLES.map(t => db.table(t)), async () => {
    for (const name of TABLES) {
      const rows = (data.tables[name] ?? []) as unknown[]
      await db.table(name).clear()
      await db.table(name).bulkAdd(name === 'puzzles' ? (rows as Puzzle[]).map(reviveCard) : rows)
    }
  })
}

// Everything except the sign-in, which has its own button
export async function deleteAllData(): Promise<void> {
  await db.transaction('rw', [...TABLES, 'explorer'].map(t => db.table(t)), async () => {
    for (const name of [...TABLES, 'explorer']) await db.table(name).clear()
  })
}
