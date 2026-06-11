// Apply a .sql file to Azure SQL, splitting on GO batch separators.
// Usage: tsx scripts/apply_sql.ts <relative-or-abs.sql>
import { readFileSync } from 'fs'
import { join, isAbsolute } from 'path'
import { getPool } from '../src/db'

const arg = process.argv[2]
if (!arg) { console.error('usage: apply_sql.ts <file.sql>'); process.exit(1) }
const file = isAbsolute(arg) ? arg : join(process.cwd(), arg)

;(async () => {
  const ddl = readFileSync(file, 'utf8')
  const batches = ddl.split(/^\s*GO\s*$/im).map((b) => b.trim()).filter(Boolean)
  const pool = await getPool()
  let n = 0
  for (const b of batches) { await pool.request().batch(b); n++ }
  process.stderr.write(`applied ${n} batches from ${arg}\n`)
  process.exit(0)
})().catch((e) => { process.stderr.write('FATAL: ' + e.message + '\n'); process.exit(1) })
