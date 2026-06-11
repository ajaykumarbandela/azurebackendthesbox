import { query, queryOne, getPool, uuidParam, sql } from '../db'

export type AiUsageType = 'image' | 'content'
export type ResetPeriod = 'lifetime' | 'monthly'

export class QuotaExceededError extends Error {
  readonly usageType: AiUsageType
  constructor(usageType: AiUsageType) {
    const label = usageType === 'image' ? 'image' : 'content'
    super(`AI ${label} quota exhausted. Contact platform admin.`)
    this.name = 'QuotaExceededError'
    this.usageType = usageType
  }
}

interface QuotaRow {
  image_limit: number
  content_limit: number
  reset_period: ResetPeriod
  period_start: string
  images_used: number
  content_used: number
  updated_at: string | null
}

export interface QuotaBucket { used: number; limit: number; remaining: number }
export interface QuotaStats {
  images: QuotaBucket
  content: QuotaBucket
  resetPeriod: ResetPeriod
  periodStart: string
  updatedAt: string | null
}

async function ensurePeriodFresh(): Promise<void> {
  const pool = await getPool()
  await pool.request().execute('dbo.maybe_reset_ai_quota_period')
}

async function fetchSettingsRow(): Promise<QuotaRow> {
  await ensurePeriodFresh()
  const data = await queryOne<QuotaRow>(
    `SELECT image_limit, content_limit, reset_period, period_start, images_used, content_used, updated_at
     FROM dbo.ai_quota_settings WHERE id = 1`
  )
  if (!data) throw new Error('AI quota settings not configured')
  return data
}

function toStats(row: QuotaRow): QuotaStats {
  return {
    images: { used: row.images_used, limit: row.image_limit, remaining: Math.max(0, row.image_limit - row.images_used) },
    content: { used: row.content_used, limit: row.content_limit, remaining: Math.max(0, row.content_limit - row.content_used) },
    resetPeriod: row.reset_period,
    periodStart: row.period_start,
    updatedAt: row.updated_at,
  }
}

export async function getQuotaStats(): Promise<QuotaStats> {
  return toStats(await fetchSettingsRow())
}

export async function consumeQuota(type: AiUsageType, userId?: string): Promise<void> {
  const pool = await getPool()
  try {
    const req = pool.request().input('p_type', type)
    if (userId) req.input('p_user_id', sql.UniqueIdentifier, userId)
    await req.execute('dbo.consume_ai_quota')
  } catch (err) {
    const msg = (err instanceof Error ? err.message : '').toLowerCase()
    if (msg.includes('image quota exhausted')) throw new QuotaExceededError('image')
    if (msg.includes('content quota exhausted')) throw new QuotaExceededError('content')
    throw err instanceof Error ? err : new Error('Quota consumption failed')
  }
}

export interface UpdateLimitsInput {
  imageLimit?: number
  contentLimit?: number
  resetPeriod?: ResetPeriod
}

export async function updateLimits(input: UpdateLimitsInput, updatedBy: string): Promise<QuotaStats> {
  const profile = await queryOne<{ id: string }>('SELECT id FROM dbo.profiles WHERE id = @id', { id: uuidParam(updatedBy) })

  const sets: string[] = ['updated_at = SYSDATETIMEOFFSET()', 'updated_by = @updated_by']
  const params: Record<string, unknown> = { updated_by: uuidParam(profile?.id ?? null) }

  if (input.imageLimit !== undefined) {
    if (!Number.isInteger(input.imageLimit) || input.imageLimit < 0) throw new Error('imageLimit must be a non-negative integer')
    sets.push('image_limit = @image_limit'); params.image_limit = input.imageLimit
  }
  if (input.contentLimit !== undefined) {
    if (!Number.isInteger(input.contentLimit) || input.contentLimit < 0) throw new Error('contentLimit must be a non-negative integer')
    sets.push('content_limit = @content_limit'); params.content_limit = input.contentLimit
  }
  if (input.resetPeriod !== undefined) {
    if (!['lifetime', 'monthly'].includes(input.resetPeriod)) throw new Error('resetPeriod must be lifetime or monthly')
    sets.push('reset_period = @reset_period'); params.reset_period = input.resetPeriod
    if (input.resetPeriod === 'monthly') {
      sets.push('period_start = @period_start')
      params.period_start = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()
    }
  }

  await query(`UPDATE dbo.ai_quota_settings SET ${sets.join(', ')} WHERE id = 1`, params)
  return getQuotaStats()
}

export async function resetPeriodCounters(): Promise<QuotaStats> {
  const pool = await getPool()
  await pool.request().execute('dbo.reset_ai_quota_period')
  return getQuotaStats()
}
