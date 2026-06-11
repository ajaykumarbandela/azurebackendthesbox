// Set one shared temporary password on every user that has no password yet
// (migrated users whose Supabase hashes could not be exported).
// Usage: tsx scripts/set_temp_passwords.ts "<tempPassword>"
import { query } from '../src/db'
import { hashPassword } from '../src/auth/password'

const temp = process.argv[2] || 'ChangeMe@2026'

;(async () => {
  const targets = await query<{ id: string; email: string; role: string }>(
    'SELECT id, email, role FROM dbo.profiles WHERE password_hash IS NULL'
  )
  if (targets.length === 0) { console.log('No users need a password.'); process.exit(0) }

  const hash = await hashPassword(temp)
  await query('UPDATE dbo.profiles SET password_hash = @h, updated_at = SYSDATETIMEOFFSET() WHERE password_hash IS NULL', { h: hash })

  console.log(`Set temporary password "${temp}" on ${targets.length} users:`)
  for (const t of targets) console.log(`  ${t.role.padEnd(10)} ${t.email}`)
  console.log('\n⚠ Require these users to change their password after first login.')
  process.exit(0)
})().catch((e) => { console.error('ERR:', e.message); process.exit(1) })
