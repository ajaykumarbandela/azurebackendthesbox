import { Router, Response } from 'express'
import { body, validationResult } from 'express-validator'
import { randomUUID } from 'crypto'
import { query, queryOne, uuidParam } from '../db'
import { authenticate, requireRole, requireApprovedEmployee, AuthRequest } from '../middleware/auth'

const router = Router()

router.get('/product/:productId', async (req, res) => {
  const data = await query(
    'SELECT * FROM dbo.variants WHERE product_id = @pid ORDER BY created_at',
    { pid: uuidParam(req.params.productId) }
  )
  res.json(data)
})

router.post(
  '/',
  authenticate,
  requireApprovedEmployee,
  [body('product_id').isUUID(), body('quantity').isInt({ min: 0 })],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() })

    const { product_id, color, size, quantity, sku, image_url } = req.body
    try {
      const data = await queryOne(
        `INSERT INTO dbo.variants (id, product_id, color, size, quantity, sku, image_url, created_at)
         OUTPUT inserted.*
         VALUES (@id, @pid, @color, @size, @quantity, @sku, @image_url, SYSDATETIMEOFFSET())`,
        { id: uuidParam(randomUUID()), pid: uuidParam(product_id), color: color ?? null, size: size ?? null, quantity, sku: sku ?? null, image_url: image_url ?? null }
      )
      res.status(201).json(data)
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Create failed' })
    }
  }
)

router.put('/product/:productId/bulk', authenticate, requireApprovedEmployee, async (req: AuthRequest, res: Response) => {
  const { variants } = req.body as { variants: Array<{ color: string; size: string; quantity: number; sku?: string; image_url?: string }> }
  if (!Array.isArray(variants)) return res.status(400).json({ error: 'variants must be an array' })

  const productId = req.params.productId
  const skuFor = (v: { color: string; size: string; sku?: string }) => {
    const provided = (v.sku ?? '').trim()
    if (provided) return provided
    return `${productId.slice(0, 6)}-${v.color}-${v.size || 'na'}`.toLowerCase().replace(/\s+/g, '-')
  }

  // Dedupe by sku.
  const bySku = new Map<string, { color: string; size: string; quantity: number; sku: string; image_url: string | null }>()
  for (const v of variants) {
    const sku = skuFor(v)
    bySku.set(sku, { color: v.color, size: v.size, quantity: v.quantity, sku, image_url: v.image_url ?? null })
  }
  const rows = [...bySku.values()]

  // Upsert each row by sku (MERGE), preserving id/sold_count on existing rows.
  for (const r of rows) {
    await query(
      `MERGE dbo.variants AS t
       USING (SELECT @sku AS sku) AS s ON t.sku = s.sku
       WHEN MATCHED THEN UPDATE SET product_id=@pid, color=@color, size=@size, quantity=@quantity, image_url=@image_url
       WHEN NOT MATCHED THEN INSERT (id, product_id, color, size, quantity, sku, image_url, created_at)
         VALUES (@id, @pid, @color, @size, @quantity, @sku, @image_url, SYSDATETIMEOFFSET());`,
      { id: uuidParam(randomUUID()), pid: uuidParam(productId), color: r.color, size: r.size, quantity: r.quantity, sku: r.sku, image_url: r.image_url }
    )
  }

  // Replace the variant set: drop rows no longer present (by sku).
  const keepSkus = rows.map((r) => r.sku)
  if (keepSkus.length > 0) {
    await query(
      `DELETE FROM dbo.variants WHERE product_id = @pid AND sku NOT IN (${keepSkus.map((_, i) => `@k${i}`).join(',')})`,
      { pid: uuidParam(productId), ...Object.fromEntries(keepSkus.map((k, i) => [`k${i}`, k])) }
    )
  } else {
    await query('DELETE FROM dbo.variants WHERE product_id = @pid', { pid: uuidParam(productId) })
  }

  const data = await query('SELECT * FROM dbo.variants WHERE product_id = @pid ORDER BY created_at', { pid: uuidParam(productId) })
  res.json(data)
})

router.patch('/:id', authenticate, requireApprovedEmployee, async (req: AuthRequest, res: Response) => {
  const { quantity, color, size, image_url } = req.body
  const sets: string[] = []
  const params: Record<string, unknown> = { id: uuidParam(req.params.id) }
  if (quantity !== undefined) { sets.push('quantity = @quantity'); params.quantity = quantity }
  if (color) { sets.push('color = @color'); params.color = color }
  if (size) { sets.push('size = @size'); params.size = size }
  if (image_url !== undefined) { sets.push('image_url = @image_url'); params.image_url = image_url }
  if (sets.length === 0) return res.status(400).json({ error: 'No updates provided' })

  try {
    const data = await queryOne(`UPDATE dbo.variants SET ${sets.join(', ')} OUTPUT inserted.* WHERE id = @id`, params)
    if (!data) return res.status(404).json({ error: 'Variant not found' })
    res.json(data)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Update failed' })
  }
})

router.delete('/:id', authenticate, requireRole('admin'), async (req: AuthRequest, res: Response) => {
  try {
    await query('DELETE FROM dbo.variants WHERE id = @id', { id: uuidParam(req.params.id) })
    res.json({ success: true })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Delete failed' })
  }
})

export default router
