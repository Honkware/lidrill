import { db, type Puzzle } from './db'

// One-file export of everything lidrill knows. The Lichess token
// is never in it, and the explorer cache is left out because it's only a
// cache.
const TABLES = ['games', 'puzzles', 'reviews', 'profile', 'syncState', 'journal', 'liPuzzle', 'practice', 'explanations', 'replaySessions'] as const
type TableName = (typeof TABLES)[number]

export interface Backup {
  app: 'lidrill'
  version: 1
  exportedAt: string
  lichessUser?: string // whose data this is; older exports only have it in the profile
  tables: Record<TableName, unknown[]>
}

export async function exportData(): Promise<Backup> {
  const tables = {} as Backup['tables']
  for (const name of TABLES) tables[name] = await db.table(name).toArray()
  const lichessUser = (await db.profile.get('me'))?.lichessUser
  return { app: 'lidrill', version: 1, exportedAt: new Date().toISOString(), lichessUser, tables }
}

// JSON turns the FSRS card dates into strings
function reviveCard(p: Puzzle): Puzzle {
  const card = { ...p.card, due: new Date(p.card.due) }
  if (card.last_review) card.last_review = new Date(card.last_review)
  return { ...p, card }
}

const owner = (data: Backup): string | undefined =>
  data.lichessUser ?? (data.tables.profile?.[0] as { lichessUser?: string } | undefined)?.lichessUser

export const sameUser = (a?: string, b?: string) => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase()

// Replaces local data with the file's. Sign-in is kept as it is, so a backup
// from another Lichess account is refused: its games and puzzles would sit
// under the wrong sign-in.
export async function importData(text: string, signedInAs?: string): Promise<void> {
  const data = JSON.parse(text) as Backup
  if (data.app !== 'lidrill' || data.version !== 1 || typeof data.tables !== 'object')
    throw new Error("That file isn't a lidrill export.")
  const from = owner(data)
  if (signedInAs && from && !sameUser(from, signedInAs))
    throw new Error(`That backup is from the Lichess account ${from}, and you're signed in as ${signedInAs}. Sign in as ${from} to restore it.`)
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
  await db.transaction('rw', [...TABLES, 'explorer', 'certs'].map(t => db.table(t)), async () => {
    for (const name of [...TABLES, 'explorer', 'certs']) await db.table(name).clear()
  })
}
