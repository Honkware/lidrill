// Visitors and active players by day, read from the Python service on the
// VM over SSH: bun run stats [days]. LIDRILL_VM is the SSH host. Nothing on
// the public site serves these numbers.
import { execFileSync } from 'node:child_process'

const host = process.env.LIDRILL_VM
if (!host) {
  console.error('Set LIDRILL_VM to the SSH host of the VM, e.g. LIDRILL_VM=myvm bun run stats')
  process.exit(1)
}
const days = Number(process.argv[2]) || 14
// The key stays on the VM: curl runs there and only the counts come back
const remote = `KEY=$(sudo sed -n 's/^LIDRILL_KEY=//p' /etc/lidrill/server.env); curl -s "localhost:8010/stats?days=${days}" -H "x-lidrill-key: $KEY"`
const out = execFileSync('ssh', [host, remote], { encoding: 'utf8' })
const stats = JSON.parse(out) as { now: { visitors: number; active: number }; days: { day: string; visitors: number; active: number }[] }

console.log(`On the site in the last 5 minutes: ${stats.now.visitors} (${stats.now.active} have touched a board)\n`)
console.log('day         visitors  active')
for (const d of stats.days) console.log(`${d.day}  ${String(d.visitors).padStart(8)}  ${String(d.active).padStart(6)}`)
if (!stats.days.length) console.log('(no visits counted yet)')
