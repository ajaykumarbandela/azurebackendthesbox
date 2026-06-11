/**
 * Create (or update) a default admin account in Azure SQL. CLI only.
 * Requires AZURE_SQL_* in env (or backend/.env).
 */
require('dotenv/config')
const { randomUUID } = require('crypto')
const bcrypt = require('bcryptjs')
const sql = require('mssql')

const config = {
  server: process.env.AZURE_SQL_SERVER,
  database: process.env.AZURE_SQL_DATABASE,
  user: process.env.AZURE_SQL_USER,
  password: process.env.AZURE_SQL_PASSWORD,
  options: { encrypt: (process.env.AZURE_SQL_ENCRYPT ?? 'true') === 'true', trustServerCertificate: false },
  connectionTimeout: 30000,
}

;(async () => {
  const email = 'admin@yuvaranisilks.com'
  const password = 'admin123'
  const name = 'Admin'

  console.log(`Creating admin user: ${email}`)
  const pool = await sql.connect(config)
  const hash = await bcrypt.hash(password, 10)

  const existing = await pool.request().input('email', sql.NVarChar(320), email)
    .query('SELECT id FROM dbo.profiles WHERE email = @email')

  if (existing.recordset.length > 0) {
    await pool.request()
      .input('email', sql.NVarChar(320), email)
      .input('name', sql.NVarChar(sql.MAX), name)
      .input('hash', sql.NVarChar(255), hash)
      .query(`UPDATE dbo.profiles SET role='admin', name=@name, password_hash=@hash, active=1,
              updated_at=SYSDATETIMEOFFSET() WHERE email=@email`)
    console.log('✓ Role updated to admin for existing user.')
  } else {
    await pool.request()
      .input('id', sql.UniqueIdentifier, randomUUID())
      .input('name', sql.NVarChar(sql.MAX), name)
      .input('email', sql.NVarChar(320), email)
      .input('hash', sql.NVarChar(255), hash)
      .query(`INSERT INTO dbo.profiles (id, name, role, employee_status, email, password_hash, active, created_at, updated_at)
              VALUES (@id, @name, 'admin', NULL, @email, @hash, 1, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET())`)
    console.log('✓ Admin user created.')
  }

  console.log('\n─────────────────────────────')
  console.log('Admin credentials:')
  console.log(`  Email   : ${email}`)
  console.log(`  Password: ${password}`)
  console.log('─────────────────────────────\n')
  process.exit(0)
})().catch((err) => { console.error('Error:', err.message); process.exit(1) })
