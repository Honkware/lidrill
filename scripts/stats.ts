// Visitors and active players by day, read from the Python service on the
// VM over SSH: bun run stats [days]. bun run stats flags [n] prints the
// explanations players reported instead. LIDRILL_VM is the SSH host. Nothing
// on the public site serves either.
import { execFileSync } from 'node:child_process'

const host = process.env.LIDRILL_VM
if (!host) {
  console.error('Set LIDRILL_VM to the SSH host of the VM, e.g. LIDRILL_VM=myvm bun run stats')
  process.exit(1)
}
// The key stays on the VM: curl runs there and only the answer comes back
const read = (path: string) => JSON.parse(execFileSync('ssh', [host, `KEY=$(sudo sed -n 's/^LIDRILL_KEY=//p' /etc/lidrill/server.env); curl -s "localhost:8010${path}" -H "x-lidrill-key: $KEY"`], { encoding: 'utf8' }))

if (process.argv[2] === 'flags') {
  const { flags } = read(`/stats/flags?limit=${Number(process.argv[3]) || 20}`) as { flags: { at: number; fen: string; played?: string; best: string; tried?: string; floor: number; version: number; text: string }[] }
  for (const f of flags) {
    console.log(`${new Date(f.at).toISOString().slice(0, 16).replace('T', ' ')}  ${f.floor ? 'fixed text' : 'model'}  v${f.version}`)
    console.log(`  ${f.fen}`)
    console.log(`  played ${f.played ?? '-'}, best ${f.best}${f.tried ? `, tried ${f.tried}` : ''}`)
    console.log(`  ${f.text.replace(/\n/g, '\n  ')}\n`)
  }
  if (!flags.length) console.log('(no explanations reported yet)')
  process.exit(0)
}

const days = Number(process.argv[2]) || 14
const stats = read(`/stats?days=${days}`) as { now: { visitors: number; active: number }; days: { day: string; visitors: number; active: number }[] }

console.log(`On the site in the last 5 minutes: ${stats.now.visitors} (${stats.now.active} have touched a board)\n`)
console.log('day         visitors  active')
for (const d of stats.days) console.log(`${d.day}  ${String(d.visitors).padStart(8)}  ${String(d.active).padStart(6)}`)
if (!stats.days.length) console.log('(no visits counted yet)')
