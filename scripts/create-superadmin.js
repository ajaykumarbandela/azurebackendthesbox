/**
 * Create (or update) a super admin account in Azure SQL. CLI only.
 *
 * Usage:
 *   SUPERADMIN_EMAIL=sbox-platform-admin@yourdomain.com \
 *   SUPERADMIN_PASSWORD='your-strong-password-min-16-chars' \
 *   node scripts/create-superadmin.js
 *
 * Requires AZURE_SQL_* in env (or backend/.env).
 */
require('dotenv/config')
const { randomUUID } = require('crypto')
const bcrypt = require('bcryptjs')
const sql = require('mssql')

const email = process.env.SUPERADMIN_EMAIL
const password = process.env.SUPERADMIN_PASSWORD
const name = process.env.SUPERADMIN_NAME || 'S-Box Platform Admin'

function fail(msg) { console.error(`Error: ${msg}`); process.exit(1) }

if (!process.env.AZURE_SQL_SERVER || !process.env.AZURE_SQL_DATABASE) fail('Set AZURE_SQL_SERVER and AZURE_SQL_DATABASE.')
if (!email) fail('Set SUPERADMIN_EMAIL.')
if (!password) fail('Set SUPERADMIN_PASSWORD (min 16 characters).')
if (password.length < 16) fail('SUPERADMIN_PASSWORD must be at least 16 characters.')
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('SUPERADMIN_EMAIL must be a valid email address.')

const config = {
  server: process.env.AZURE_SQL_SERVER,
  database: process.env.AZURE_SQL_DATABASE,
  user: process.env.AZURE_SQL_USER,
  password: process.env.AZURE_SQL_PASSWORD,
  options: { encrypt: (process.env.AZURE_SQL_ENCRYPT ?? 'true') === 'true', trustServerCertificate: false },
  connectionTimeout: 30000,
}

;(async () => {
  console.log(`Creating super admin: ${email}`)
  const pool = await sql.connect(config)
  const hash = await bcrypt.hash(password, 10)

  const existing = await pool.request().input('email', sql.NVarChar(320), email)
    .query('SELECT id FROM dbo.profiles WHERE email = @email')

  if (existing.recordset.length > 0) {
    await pool.request()
      .input('email', sql.NVarChar(320), email)
      .input('name', sql.NVarChar(sql.MAX), name)
      .input('hash', sql.NVarChar(255), hash)
      .query(`UPDATE dbo.profiles SET role='superadmin', employee_status=NULL, name=@name,
              password_hash=@hash, active=1, updated_at=SYSDATETIMEOFFSET() WHERE email=@email`)
    console.log('✓ Existing user promoted to super admin and password set.')
  } else {
    await pool.request()
      .input('id', sql.UniqueIdentifier, randomUUID())
      .input('name', sql.NVarChar(sql.MAX), name)
      .input('email', sql.NVarChar(320), email)
      .input('hash', sql.NVarChar(255), hash)
      .query(`INSERT INTO dbo.profiles (id, name, role, employee_status, email, password_hash, active, created_at, updated_at)
              VALUES (@id, @name, 'superadmin', NULL, @email, @hash, 1, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET())`)
    console.log('✓ Super admin created.')
  }
  console.log('\nSign in at the superadmin app (port 3002) with the credentials from your env.\n')
  process.exit(0)
})().catch((err) => { console.error('Error:', err.message); process.exit(1) })
