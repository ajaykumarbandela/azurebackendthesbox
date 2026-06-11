import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { config } from 'dotenv'
import sql from 'mssql'

// Load `.env` before reading `process.env` (same pattern the old supabase.ts used:
// route modules may import this before index.ts runs dotenv/config).
const envPaths = [join(process.cwd(), '.env'), join(__dirname, '..', '.env')]
for (const envPath of envPaths) {
  if (!existsSync(envPath)) continue
  if (statSync(envPath).size === 0) {
    throw new Error(`backend env file is empty: ${envPath}`)
  }
  config({ path: envPath })
  break
}

if (!process.env.AZURE_SQL_SERVER || !process.env.AZURE_SQL_DATABASE) {
  throw new Error(
    'Missing Azure SQL environment variables: AZURE_SQL_SERVER and AZURE_SQL_DATABASE are required.\n' +
      `Checked: ${envPaths.join(' and ')}`
  )
}

const poolConfig: sql.config = {
  server: process.env.AZURE_SQL_SERVER!,
  database: process.env.AZURE_SQL_DATABASE!,
  user: process.env.AZURE_SQL_USER,
  password: process.env.AZURE_SQL_PASSWORD,
  options: {
    encrypt: (process.env.AZURE_SQL_ENCRYPT ?? 'true') === 'true',
    trustServerCertificate: false,
  },
  pool: { max: 10, min: 1, idleTimeoutMillis: 30000 },
  connectionTimeout: 30000,
  requestTimeout: 60000,
}

// Single shared pool. `getPool` lazily connects and reuses the same connection
// promise so concurrent callers don't open multiple pools.
let poolPromise: Promise<sql.ConnectionPool> | null = null
export function getPool(): Promise<sql.ConnectionPool> {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(poolConfig).connect().catch((err: unknown) => {
      poolPromise = null // allow retry on next call
      throw err
    })
  }
  return poolPromise
}

export type Params = Record<string, unknown>

// Attach typed params. We infer the mssql type from the JS value; callers that
// need an explicit type (e.g. uniqueidentifier for a string) pass a {type,value}.
function bind(req: sql.Request, params?: Params): sql.Request {
  if (!params) return req
  for (const [name, raw] of Object.entries(params)) {
    if (raw !== null && typeof raw === 'object' && 'type' in (raw as object) && 'value' in (raw as object)) {
      const { type, value } = raw as { type: sql.ISqlType; value: unknown }
      req.input(name, type, value)
    } else {
      req.input(name, raw)
    }
  }
  return req
}

// Run a query, return all rows.
export async function query<T = Record<string, unknown>>(text: string, params?: Params): Promise<T[]> {
  const pool = await getPool()
  const result = await bind(pool.request(), params).query<T>(text)
  return result.recordset ?? []
}

// Run a query, return the first row or null.
export async function queryOne<T = Record<string, unknown>>(text: string, params?: Params): Promise<T | null> {
  const rows = await query<T>(text, params)
  return rows[0] ?? null
}

// Run a query and return rows + the total count from a parallel COUNT query.
// `countText` should select COUNT(*) AS total with the same WHERE clause.
export async function queryWithCount<T = Record<string, unknown>>(
  text: string,
  countText: string,
  params?: Params
): Promise<{ rows: T[]; total: number }> {
  const pool = await getPool()
  const [rows, countRes] = await Promise.all([
    bind(pool.request(), params).query<T>(text),
    bind(pool.request(), params).query<{ total: number }>(countText),
  ])
  return { rows: rows.recordset ?? [], total: countRes.recordset?.[0]?.total ?? 0 }
}

// Execute work inside a transaction. The callback receives a Request bound to
// the transaction; throw to roll back.
export async function withTransaction<T>(
  work: (tx: sql.Transaction, request: () => sql.Request) => Promise<T>
): Promise<T> {
  const pool = await getPool()
  const tx = new sql.Transaction(pool)
  await tx.begin()
  try {
    const result = await work(tx, () => new sql.Request(tx))
    await tx.commit()
    return result
  } catch (err) {
    await tx.rollback()
    throw err
  }
}

// Re-export the type namespace so callers can reference sql.UniqueIdentifier etc.
export { sql }

// Convenience helpers for the two non-obvious bindings we use everywhere.
export const uuidParam = (value: string | null) => ({ type: sql.UniqueIdentifier, value })
export const datetimeParam = (value: Date | string | null) => ({
  type: sql.DateTimeOffset as unknown as sql.ISqlType,
  value: value == null ? null : new Date(value),
})
