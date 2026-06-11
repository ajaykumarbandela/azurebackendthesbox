import { Response } from 'express'
import { randomUUID } from 'crypto'
import { query, queryOne, uuidParam } from '../db'
import { AuthRequest } from '../middleware/auth'

// Reproduces the Supabase cartSelect embed:
//   { id, quantity, product_id, variant_id,
//     product:{id,title,base_price,discount_pct,type, images:[{url,is_primary,color}]},
//     variant:{id,color,size,quantity,sku,image_url} }
const cartJsonCols = `
  ci.id, ci.quantity, ci.product_id, ci.variant_id,
  JSON_QUERY((SELECT p.id, p.title, p.base_price, p.discount_pct, p.type,
    JSON_QUERY((SELECT img.url, img.is_primary, img.color FROM dbo.product_images img WHERE img.product_id = p.id FOR JSON PATH, INCLUDE_NULL_VALUES)) AS images
    FROM dbo.products p WHERE p.id = ci.product_id FOR JSON PATH, INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER)) AS product,
  JSON_QUERY((SELECT v.id, v.color, v.size, v.quantity, v.sku, v.image_url FROM dbo.variants v WHERE v.id = ci.variant_id FOR JSON PATH, INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER)) AS variant`

function parseCartRow(row: Record<string, unknown>) {
  return {
    ...row,
    product: row.product ? JSON.parse(row.product as string) : null,
    variant: row.variant ? JSON.parse(row.variant as string) : null,
  }
}

async function fetchCart(userId: string) {
  const rows = await query(
    `SELECT ${cartJsonCols} FROM dbo.cart_items ci WHERE ci.user_id = @uid ORDER BY ci.id ASC`,
    { uid: uuidParam(userId) }
  )
  return rows.map(parseCartRow)
}

export async function getCart(req: AuthRequest, res: Response) {
  res.json({ items: await fetchCart(req.user!.id) })
}

export async function addToCart(req: AuthRequest, res: Response) {
  const { product_id, variant_id, quantity = 1 } = req.body

  const variant = await queryOne<{ quantity: number }>(
    'SELECT quantity FROM dbo.variants WHERE id = @id',
    { id: uuidParam(variant_id) }
  )
  if (!variant || variant.quantity < 1) {
    return res.status(400).json({ error: 'Item out of stock' })
  }

  // upsert on (user_id, variant_id): MERGE replaces the Supabase onConflict.
  await query(
    `MERGE dbo.cart_items AS t
     USING (SELECT @uid AS user_id, @vid AS variant_id) AS s
       ON t.user_id = s.user_id AND t.variant_id = s.variant_id
     WHEN MATCHED THEN UPDATE SET quantity = @qty, product_id = @pid
     WHEN NOT MATCHED THEN INSERT (id, user_id, product_id, variant_id, quantity, created_at)
       VALUES (@id, @uid, @pid, @vid, @qty, SYSDATETIMEOFFSET());`,
    {
      id: uuidParam(randomUUID()), uid: uuidParam(req.user!.id),
      pid: uuidParam(product_id), vid: uuidParam(variant_id), qty: quantity,
    }
  )
  res.status(201).json({ items: await fetchCart(req.user!.id) })
}

export async function updateCartItem(req: AuthRequest, res: Response) {
  const { quantity } = req.body
  if (!quantity || quantity < 1) {
    return res.status(400).json({ error: 'Quantity must be >= 1' })
  }

  await query(
    'UPDATE dbo.cart_items SET quantity = @qty WHERE id = @id AND user_id = @uid',
    { qty: quantity, id: uuidParam(req.params.id), uid: uuidParam(req.user!.id) }
  )
  res.json({ items: await fetchCart(req.user!.id) })
}

export async function removeFromCart(req: AuthRequest, res: Response) {
  await query(
    'DELETE FROM dbo.cart_items WHERE id = @id AND user_id = @uid',
    { id: uuidParam(req.params.id), uid: uuidParam(req.user!.id) }
  )
  res.json({ items: await fetchCart(req.user!.id) })
}

export async function clearCart(req: AuthRequest, res: Response) {
  await query('DELETE FROM dbo.cart_items WHERE user_id = @uid', { uid: uuidParam(req.user!.id) })
  res.json({ items: [] })
}
