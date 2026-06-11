import { Router, Response } from 'express'
import { randomUUID } from 'crypto'
import { query, queryOne, uuidParam } from '../db'
import { authenticate, requireRole, AuthRequest } from '../middleware/auth'

const router = Router()

// True if the user's cart holds at least one item the coupon's scope covers.
async function cartMatchesCouponScope(
  userId: string,
  coupon: { category_id: string | null; product_id: string | null }
): Promise<boolean> {
  if (!coupon.category_id && !coupon.product_id) return true

  const cart = await query<{ product_id: string; product_category_id: string | null; category_parent_id: string | null }>(
    `SELECT ci.product_id, p.category_id AS product_category_id, c.parent_id AS category_parent_id
     FROM dbo.cart_items ci
     LEFT JOIN dbo.products p ON p.id = ci.product_id
     LEFT JOIN dbo.categories c ON c.id = p.category_id
     WHERE ci.user_id = @uid`,
    { uid: uuidParam(userId) }
  )

  for (const c of cart) {
    if (coupon.product_id && c.product_id === coupon.product_id) return true
    if (coupon.category_id) {
      if (c.product_category_id === coupon.category_id) return true
      if (c.category_parent_id === coupon.category_id) return true
    }
  }
  return false
}

router.get('/validate/:code', authenticate, async (req: AuthRequest, res: Response) => {
  const data = await queryOne<{
    code: string; discount_pct: number; starts_at: string | null; expires_at: string | null
    max_uses: number | null; used_count: number; active: boolean; category_id: string | null; product_id: string | null
  }>(
    `SELECT code, discount_pct, starts_at, expires_at, max_uses, used_count, active, category_id, product_id
     FROM dbo.coupons WHERE code = @code`,
    { code: req.params.code.toUpperCase() }
  )

  if (!data) return res.status(404).json({ error: 'Invalid coupon code' })
  if (!data.active) return res.status(400).json({ error: 'Coupon is not active' })
  if (data.starts_at && new Date(data.starts_at) > new Date()) return res.status(400).json({ error: 'Coupon is not active yet' })
  if (data.expires_at && new Date(data.expires_at) < new Date()) return res.status(400).json({ error: 'Coupon has expired' })
  if (data.max_uses && data.used_count >= data.max_uses) return res.status(400).json({ error: 'Coupon usage limit reached' })

  const matches = await cartMatchesCouponScope(req.user!.id, data)
  if (!matches) return res.status(400).json({ error: 'Coupon does not apply to the items in your bag' })

  res.json({ code: data.code, discount_pct: data.discount_pct })
})

// Admin CRUD
router.get('/', authenticate, requireRole('admin'), async (_req: AuthRequest, res: Response) => {
  const rows = await query<{ category: string | null; product: string | null }>(
    `SELECT cp.*,
       JSON_QUERY((SELECT c.id, c.name FROM dbo.categories c WHERE c.id = cp.category_id FOR JSON PATH, INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER)) AS category,
       JSON_QUERY((SELECT p.id, p.title FROM dbo.products p WHERE p.id = cp.product_id FOR JSON PATH, INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER)) AS product
     FROM dbo.coupons cp ORDER BY cp.created_at DESC`
  )
  res.json(rows.map((r) => ({
    ...r,
    category: r.category ? JSON.parse(r.category) : null,
    product: r.product ? JSON.parse(r.product) : null,
  })))
})

router.post('/', authenticate, requireRole('admin'), async (req: AuthRequest, res: Response) => {
  const { code, discount_pct, max_uses, starts_at, expires_at, category_id, product_id } = req.body
  try {
    const data = await queryOne(
      `INSERT INTO dbo.coupons (id, code, discount_pct, max_uses, used_count, starts_at, expires_at, category_id, product_id, active, created_at)
       OUTPUT inserted.*
       VALUES (@id, @code, @discount_pct, @max_uses, 0, @starts_at, @expires_at, @category_id, @product_id, 1, SYSDATETIMEOFFSET())`,
      {
        id: uuidParam(randomUUID()), code: code.toUpperCase(), discount_pct, max_uses: max_uses || null,
        starts_at: starts_at || null, expires_at: expires_at || null,
        category_id: uuidParam(category_id || null), product_id: uuidParam(product_id || null),
      }
    )
    res.status(201).json(data)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Create failed' })
  }
})

router.patch('/:id', authenticate, requireRole('admin'), async (req: AuthRequest, res: Response) => {
  const { active, discount_pct, max_uses, starts_at, expires_at, category_id, product_id } = req.body
  const sets: string[] = []
  const params: Record<string, unknown> = { id: uuidParam(req.params.id) }
  if (active !== undefined) { sets.push('active = @active'); params.active = active ? 1 : 0 }
  if (discount_pct !== undefined) { sets.push('discount_pct = @discount_pct'); params.discount_pct = discount_pct }
  if (max_uses !== undefined) { sets.push('max_uses = @max_uses'); params.max_uses = max_uses }
  if (starts_at !== undefined) { sets.push('starts_at = @starts_at'); params.starts_at = starts_at }
  if (expires_at !== undefined) { sets.push('expires_at = @expires_at'); params.expires_at = expires_at }
  if (category_id !== undefined) { sets.push('category_id = @category_id'); params.category_id = uuidParam(category_id || null) }
  if (product_id !== undefined) { sets.push('product_id = @product_id'); params.product_id = uuidParam(product_id || null) }
  if (sets.length === 0) return res.status(400).json({ error: 'No updates provided' })

  try {
    const data = await queryOne(`UPDATE dbo.coupons SET ${sets.join(', ')} OUTPUT inserted.* WHERE id = @id`, params)
    if (!data) return res.status(404).json({ error: 'Coupon not found' })
    res.json(data)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Update failed' })
  }
})

export default router
