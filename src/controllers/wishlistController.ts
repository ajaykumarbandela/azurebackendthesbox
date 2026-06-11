import { Response } from 'express'
import { randomUUID } from 'crypto'
import { query, queryOne, uuidParam } from '../db'
import { AuthRequest } from '../middleware/auth'

// Product embed used by the wishlist (returns the joined product objects).
const wishlistProductJson = `
  JSON_QUERY((SELECT p.id, p.title, p.base_price, p.discount_pct, p.type,
    JSON_QUERY((SELECT img.url, img.is_primary, img.color FROM dbo.product_images img WHERE img.product_id = p.id FOR JSON PATH, INCLUDE_NULL_VALUES)) AS images,
    JSON_QUERY((SELECT v.id, v.color, v.size, v.quantity FROM dbo.variants v WHERE v.product_id = p.id FOR JSON PATH, INCLUDE_NULL_VALUES)) AS variants
    FROM dbo.products p WHERE p.id = wi.product_id FOR JSON PATH, INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER)) AS product`

export async function getWishlist(req: AuthRequest, res: Response) {
  const rows = await query<{ product: string | null }>(
    `SELECT ${wishlistProductJson} FROM dbo.wishlist_items wi WHERE wi.user_id = @uid ORDER BY wi.created_at DESC`,
    { uid: uuidParam(req.user!.id) }
  )
  // Storefront expects { data: Product[] } — unwrap the joined product.
  const data = rows.map((w) => (w.product ? JSON.parse(w.product) : null)).filter(Boolean)
  res.json({ data })
}

export async function addToWishlist(req: AuthRequest, res: Response) {
  const { product_id } = req.body

  // Idempotent insert (ignore if already present).
  await query(
    `IF NOT EXISTS (SELECT 1 FROM dbo.wishlist_items WHERE user_id = @uid AND product_id = @pid)
       INSERT INTO dbo.wishlist_items (id, user_id, product_id, created_at)
       VALUES (@id, @uid, @pid, SYSDATETIMEOFFSET())`,
    { id: uuidParam(randomUUID()), uid: uuidParam(req.user!.id), pid: uuidParam(product_id) }
  )

  const row = await queryOne<{ id: string; created_at: string; product: string | null }>(
    `SELECT wi.id, wi.created_at, ${wishlistProductJson}
     FROM dbo.wishlist_items wi WHERE wi.user_id = @uid AND wi.product_id = @pid`,
    { uid: uuidParam(req.user!.id), pid: uuidParam(product_id) }
  )
  res.status(201).json(row ? { ...row, product: row.product ? JSON.parse(row.product) : null } : null)
}

export async function removeFromWishlist(req: AuthRequest, res: Response) {
  await query(
    'DELETE FROM dbo.wishlist_items WHERE product_id = @pid AND user_id = @uid',
    { pid: uuidParam(req.params.productId), uid: uuidParam(req.user!.id) }
  )
  res.json({ success: true })
}

export async function toggleWishlist(req: AuthRequest, res: Response) {
  const { product_id } = req.body

  const existing = await queryOne<{ id: string }>(
    'SELECT id FROM dbo.wishlist_items WHERE user_id = @uid AND product_id = @pid',
    { uid: uuidParam(req.user!.id), pid: uuidParam(product_id) }
  )

  if (existing) {
    await query('DELETE FROM dbo.wishlist_items WHERE id = @id', { id: uuidParam(existing.id) })
    return res.json({ added: false })
  }

  await query(
    'INSERT INTO dbo.wishlist_items (id, user_id, product_id, created_at) VALUES (@id, @uid, @pid, SYSDATETIMEOFFSET())',
    { id: uuidParam(randomUUID()), uid: uuidParam(req.user!.id), pid: uuidParam(product_id) }
  )
  res.json({ added: true })
}
