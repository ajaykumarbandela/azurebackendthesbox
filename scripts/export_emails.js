// One-time: pull each user's email from Supabase auth.users and write it into
// Azure profiles.email (matched by id). Run while Supabase is still reachable.
require('dotenv').config()
const { createClient } = require('@supabase/supabase-js')
const sql = require('mssql')

const AZURE = { user: 'adminuser', password: 'Admin@123,.', server: 'thesbox.database.windows.net', database: 'TheSBoxDatabase1', options: { encrypt: true, trustServerCertificate: false }, connectionTimeout: 30000 }
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

async function allAuthUsers() {
  const users = []
  let page = 1
  for (;;) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw new Error(error.message)
    users.push(...data.users)
    if (data.users.length < 1000) break
    page++
  }
  return users
}

;(async () => {
  const users = await allAuthUsers()
  console.log(`fetched ${users.length} auth users`)
  const pool = await sql.connect(AZURE)
  let updated = 0, missing = 0
  for (const u of users) {
    if (!u.email) { missing++; continue }
    const r = await pool.request()
      .input('id', sql.UniqueIdentifier, u.id)
      .input('email', sql.NVarChar(320), u.email)
      .query('UPDATE dbo.profiles SET email=@email WHERE id=@id')
    if (r.rowsAffected[0] > 0) updated++
  }
  console.log(`updated ${updated} profiles with email; ${missing} auth users had no email`)
  const chk = await pool.request().query('SELECT COUNT(*) c FROM dbo.profiles WHERE email IS NOT NULL')
  console.log(`profiles with email now: ${chk.recordset[0].c}`)
  await pool.close(); process.exit(0)
})().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
