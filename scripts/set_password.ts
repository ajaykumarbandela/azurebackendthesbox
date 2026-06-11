// Set (or reset) a user's password in Azure.
// Usage: tsx scripts/set_password.ts <email> <newPassword>
import { query, queryOne, uuidParam } from '../src/db'
import { hashPassword } from '../src/auth/password'

const [, , email, password] = process.argv
if (!email || !password) {
  process.stderr.write('usage: set_password.ts <email> <password>\n')
  process.exit(1)
}

;(async () => {
  const user = await queryOne<{ id: string }>('SELECT id FROM dbo.profiles WHERE email = @email', { email })
  if (!user) { process.stderr.write(`no user with email ${email}\n`); process.exit(1) }
  const hash = await hashPassword(password)
  await query('UPDATE dbo.profiles SET password_hash = @h, updated_at = SYSDATETIMEOFFSET() WHERE id = @id', {
    h: hash,
    id: uuidParam(user.id),
  })
  process.stderr.write(`password set for ${email}\n`)
  process.exit(0)
})().catch((e) => { process.stderr.write('ERR: ' + e.message + '\n'); process.exit(1) })
