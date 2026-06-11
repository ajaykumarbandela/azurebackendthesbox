// ============================================================
// Supabase (Postgres) -> Azure SQL migration runner.
//   Phase 1: create schema from azure_schema.sql (GO-batched)
//   Phase 2: copy all rows, FK-safe order, typed inserts
//   Phase 3: verify row counts match
// Re-runnable: data load deletes child->parent before reloading.
// ============================================================
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { createClient } = require('@supabase/supabase-js')
const sql = require('mssql')

const AZURE = {
  user: 'adminuser',
  password: 'Admin@123,.',
  server: 'thesbox.database.windows.net',
  database: 'TheSBoxDatabase1',
  options: { encrypt: true, trustServerCertificate: false },
  connectionTimeout: 30000,
  requestTimeout: 60000,
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// Column type map per table. Drives sql.Request input typing so values bind
// correctly. Keys not listed default to NVarChar(MAX).
const T = sql
const SCHEMA = {
  profiles: { id: T.UniqueIdentifier, name: T.NVarChar(T.MAX), phone: T.NVarChar(64), role: T.NVarChar(20), employee_status: T.NVarChar(20), fcm_token: T.NVarChar(T.MAX), whatsapp: T.NVarChar(64), created_at: T.DateTimeOffset, updated_at: T.DateTimeOffset },
  categories: { id: T.UniqueIdentifier, name: T.NVarChar(T.MAX), slug: T.NVarChar(255), description: T.NVarChar(T.MAX), image_url: T.NVarChar(T.MAX), parent_id: T.UniqueIdentifier, created_at: T.DateTimeOffset },
  products: { id: T.UniqueIdentifier, title: T.NVarChar(T.MAX), description: T.NVarChar(T.MAX), type: T.NVarChar(20), category_id: T.UniqueIdentifier, base_price: T.Decimal(10,2), discount_pct: T.Decimal(5,2), coupon_code: T.NVarChar(255), coupon_disc: T.Decimal(5,2), published: T.Bit, created_by: T.UniqueIdentifier, created_at: T.DateTimeOffset, updated_at: T.DateTimeOffset },
  product_images: { id: T.UniqueIdentifier, product_id: T.UniqueIdentifier, url: T.NVarChar(T.MAX), alt_text: T.NVarChar(T.MAX), is_primary: T.Bit, color: T.NVarChar(255), display_order: T.Int },
  variants: { id: T.UniqueIdentifier, product_id: T.UniqueIdentifier, color: T.NVarChar(255), size: T.NVarChar(255), quantity: T.Int, sold_count: T.Int, sku: T.NVarChar(255), image_url: T.NVarChar(T.MAX), created_at: T.DateTimeOffset },
  addresses: { id: T.UniqueIdentifier, user_id: T.UniqueIdentifier, line1: T.NVarChar(T.MAX), line2: T.NVarChar(T.MAX), city: T.NVarChar(255), state: T.NVarChar(255), pincode: T.NVarChar(32), country: T.NVarChar(128), is_default: T.Bit, created_at: T.DateTimeOffset },
  orders: { id: T.UniqueIdentifier, user_id: T.UniqueIdentifier, address_id: T.UniqueIdentifier, status: T.NVarChar(20), total_amount: T.Decimal(10,2), discount_amount: T.Decimal(10,2), coupon_applied: T.NVarChar(255), razorpay_order_id: T.NVarChar(255), razorpay_payment_id: T.NVarChar(255), refund_status: T.NVarChar(255), refund_reason: T.NVarChar(T.MAX), shiprocket_order_id: T.NVarChar(255), shiprocket_shipment_id: T.NVarChar(255), shiprocket_awb: T.NVarChar(255), shiprocket_courier_id: T.Int, shiprocket_courier_name: T.NVarChar(255), tracking_url: T.NVarChar(T.MAX), shipment_status: T.NVarChar(255), expected_delivery_date: T.Date, label_url: T.NVarChar(T.MAX), invoice_url: T.NVarChar(T.MAX), manifest_url: T.NVarChar(T.MAX), created_at: T.DateTimeOffset, updated_at: T.DateTimeOffset },
  order_items: { id: T.UniqueIdentifier, order_id: T.UniqueIdentifier, product_id: T.UniqueIdentifier, variant_id: T.UniqueIdentifier, quantity: T.Int, unit_price: T.Decimal(10,2) },
  cart_items: { id: T.UniqueIdentifier, user_id: T.UniqueIdentifier, product_id: T.UniqueIdentifier, variant_id: T.UniqueIdentifier, quantity: T.Int, created_at: T.DateTimeOffset },
  wishlist_items: { id: T.UniqueIdentifier, user_id: T.UniqueIdentifier, product_id: T.UniqueIdentifier, created_at: T.DateTimeOffset },
  coupons: { id: T.UniqueIdentifier, code: T.NVarChar(255), discount_pct: T.Decimal(5,2), max_uses: T.Int, used_count: T.Int, starts_at: T.DateTimeOffset, expires_at: T.DateTimeOffset, category_id: T.UniqueIdentifier, product_id: T.UniqueIdentifier, active: T.Bit, created_at: T.DateTimeOffset },
  offline_sales: { id: T.UniqueIdentifier, variant_id: T.UniqueIdentifier, product_id: T.UniqueIdentifier, sold_by: T.UniqueIdentifier, quantity: T.Int, unit_price: T.Decimal(10,2), customer_name: T.NVarChar(T.MAX), customer_phone: T.NVarChar(64), created_at: T.DateTimeOffset },
  notifications: { id: T.UniqueIdentifier, user_id: T.UniqueIdentifier, title: T.NVarChar(T.MAX), body: T.NVarChar(T.MAX), read: T.Bit, created_at: T.DateTimeOffset },
  ai_quota_settings: { id: T.Int, image_limit: T.Int, content_limit: T.Int, reset_period: T.NVarChar(20), period_start: T.DateTimeOffset, images_used: T.Int, content_used: T.Int, updated_at: T.DateTimeOffset, updated_by: T.UniqueIdentifier },
  ai_usage_log: { id: T.UniqueIdentifier, usage_type: T.NVarChar(20), user_id: T.UniqueIdentifier, created_at: T.DateTimeOffset },
}

// Insert order: parents before children (FK-safe). Delete uses the reverse.
const LOAD_ORDER = [
  'profiles', 'categories', 'products', 'product_images', 'variants',
  'addresses', 'orders', 'order_items', 'cart_items', 'wishlist_items',
  'coupons', 'offline_sales', 'notifications', 'ai_quota_settings', 'ai_usage_log',
]
// "read" is a reserved word -> must be bracketed in SQL.
const RESERVED = { read: '[read]' }

function coerce(type, val) {
  if (val === null || val === undefined) return null
  if (type === T.Bit) return val === true || val === 'true' || val === 1 ? 1 : 0
  if (type === T.DateTimeOffset || type === T.Date) return new Date(val)
  return val
}

async function runSchema(pool) {
  console.log('\n=== PHASE 1: schema ===')
  const ddl = fs.readFileSync(path.join(__dirname, '..', 'azure_schema.sql'), 'utf8')
  const batches = ddl.split(/^\s*GO\s*$/im).map(b => b.trim()).filter(Boolean)
  let n = 0
  for (const b of batches) {
    await pool.request().batch(b)
    n++
  }
  console.log(`  executed ${n} batches`)
  const t = await pool.request().query("select table_name from information_schema.tables where table_type='BASE TABLE' order by table_name")
  console.log('  tables now:', t.recordset.map(x => x.table_name).join(', '))
}

async function clearAll(pool) {
  console.log('\n=== PHASE 2a: clear existing (re-run safety) ===')
  for (const tbl of [...LOAD_ORDER].reverse()) {
    await pool.request().query(`DELETE FROM dbo.${tbl}`)
  }
  console.log('  cleared')
}

async function fetchAll(table) {
  // page through to avoid the 1000-row PostgREST cap
  const rows = []
  let from = 0
  const PAGE = 1000
  for (;;) {
    const { data, error } = await sb.from(table).select('*').range(from, from + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    rows.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }
  return rows
}

async function loadTable(pool, table) {
  const cols = SCHEMA[table]
  const colNames = Object.keys(cols)
  const rows = await fetchAll(table)
  if (rows.length === 0) { console.log(`  ${table.padEnd(20)} 0 rows`); return 0 }

  for (const row of rows) {
    const req = pool.request()
    const colSql = colNames.map(c => RESERVED[c] || c)
    const params = colNames.map((c, i) => {
      req.input(`p${i}`, cols[c], coerce(cols[c], row[c]))
      return `@p${i}`
    })
    await req.query(`INSERT INTO dbo.${table} (${colSql.join(',')}) VALUES (${params.join(',')})`)
  }
  console.log(`  ${table.padEnd(20)} ${rows.length} rows`)
  return rows.length
}

async function loadData(pool) {
  console.log('\n=== PHASE 2b: copy data ===')
  // Disable FK checks during load to tolerate self-references (categories.parent_id)
  // and the coupons<->products soft cycle, then re-enable WITH CHECK to validate.
  // sp_MSforeachtable is unavailable on Azure SQL DB -> iterate explicitly.
  for (const tbl of LOAD_ORDER) await pool.request().query(`ALTER TABLE dbo.${tbl} NOCHECK CONSTRAINT ALL`)
  for (const tbl of LOAD_ORDER) await loadTable(pool, tbl)
  for (const tbl of LOAD_ORDER) await pool.request().query(`ALTER TABLE dbo.${tbl} WITH CHECK CHECK CONSTRAINT ALL`)
  console.log('  FK constraints re-enabled and validated')
}

async function verify(pool) {
  console.log('\n=== PHASE 3: verify ===')
  let ok = true
  for (const tbl of LOAD_ORDER) {
    const { count } = await sb.from(tbl).select('*', { count: 'exact', head: true })
    const r = await pool.request().query(`SELECT COUNT(*) AS c FROM dbo.${tbl}`)
    const az = r.recordset[0].c
    const match = count === az
    if (!match) ok = false
    console.log(`  ${tbl.padEnd(20)} supabase=${count}  azure=${az}  ${match ? 'OK' : 'MISMATCH'}`)
  }
  console.log(ok ? '\n  ALL TABLES MATCH ✔' : '\n  ⚠ MISMATCHES ABOVE')
}

;(async () => {
  const pool = await sql.connect(AZURE)
  await runSchema(pool)
  await clearAll(pool)
  await loadData(pool)
  await verify(pool)
  await pool.close()
  process.exit(0)
})().catch(e => { console.error('\nFATAL:', e.message); process.exit(1) })
