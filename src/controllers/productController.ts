import { Request, Response } from 'express'
import { randomUUID } from 'crypto'
import { query, queryOne, uuidParam } from '../db'
import { AuthRequest } from '../middleware/auth'

// Reproduces the Supabase embedded-resource shape:
//   { ...product, category:{id,name,slug}, images:[...], variants:[...] }
// via correlated FOR JSON subqueries. JSON_QUERY keeps nested arrays/objects
// as JSON (not escaped strings). Column alias `p` must be set by the caller.
const productJsonCols = `
  p.id, p.title, p.description, p.type, p.category_id, p.base_price, p.discount_pct,
  p.coupon_code, p.coupon_disc, p.published, p.created_by, p.created_at, p.updated_at,
  JSON_QUERY((
    SELECT c.id, c.name, c.slug FROM dbo.categories c WHERE c.id = p.category_id
    FOR JSON PATH, INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER
  )) AS category,
  JSON_QUERY((
    SELECT pi.id, pi.url, pi.color, pi.is_primary, pi.display_order, pi.alt_text
    FROM dbo.product_images pi WHERE pi.product_id = p.id ORDER BY pi.display_order
    FOR JSON PATH, INCLUDE_NULL_VALUES
  )) AS images,
  JSON_QUERY((
    SELECT v.id, v.color, v.size, v.quantity, v.sold_count, v.sku, v.image_url
    FROM dbo.variants v WHERE v.product_id = p.id
    FOR JSON PATH, INCLUDE_NULL_VALUES
  )) AS variants`

// Each row comes back with category/images/variants as JSON strings (because we
// SELECT ... FOR JSON inside JSON_QUERY but read the outer row normally). Parse
// them so the response is real nested JSON, matching the old PostgREST output.
function parseProductRow(row: Record<string, unknown>) {
  return {
    ...row,
    published: !!row.published,
    category: row.category ? JSON.parse(row.category as string) : null,
    images: row.images ? JSON.parse(row.images as string) : [],
    variants: row.variants ? JSON.parse(row.variants as string) : [],
  }
}

export async function getAllProducts(req: Request, res: Response) {
  const { type, category, search, minPrice, maxPrice, page = '1', limit = '20', published, sort } = req.query

  const where: string[] = []
  const params: Record<string, unknown> = {}

  if (published !== 'all') where.push('p.published = 1')
  if (type) {
    const arr = (type as string).split(',').map((t) => t.trim()).filter(Boolean)
    where.push(`p.type IN (${arr.map((_, i) => `@type${i}`).join(',')})`)
    arr.forEach((t, i) => (params[`type${i}`] = t))
  }
  if (category) {
    const catParam = (category as string).split(',').map((c) => c.trim()).filter(Boolean)
    // top-level category match also includes its sub-categories
    const subs = await query<{ id: string }>(
      `SELECT id FROM dbo.categories WHERE parent_id IN (${catParam.map((_, i) => `@pc${i}`).join(',')})`,
      Object.fromEntries(catParam.map((c, i) => [`pc${i}`, uuidParam(c)]))
    )
    const catIds = [...catParam, ...subs.map((s) => s.id)]
    where.push(`p.category_id IN (${catIds.map((_, i) => `@cat${i}`).join(',')})`)
    catIds.forEach((c, i) => (params[`cat${i}`] = uuidParam(c)))
  }
  if (search) { where.push('p.title LIKE @search'); params.search = `%${search}%` }
  if (minPrice) { where.push('p.base_price >= @minPrice'); params.minPrice = +minPrice }
  if (maxPrice) { where.push('p.base_price <= @maxPrice'); params.maxPrice = +maxPrice }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const orderSql =
    sort === 'price_asc' ? 'ORDER BY p.base_price ASC'
    : sort === 'price_desc' ? 'ORDER BY p.base_price DESC'
    : 'ORDER BY p.created_at DESC'

  const offset = (+page - 1) * +limit
  params.offset = offset
  params.limit = +limit

  const rows = await query(
    `SELECT ${productJsonCols}
     FROM dbo.products p ${whereSql} ${orderSql}
     OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
    params
  )
  const countRow = await queryOne<{ total: number }>(
    `SELECT COUNT(*) AS total FROM dbo.products p ${whereSql}`,
    params
  )
  const count = countRow?.total ?? 0

  res.json({
    data: rows.map(parseProductRow),
    count,
    total: count,
    page: +page,
    limit: +limit,
    totalPages: Math.ceil(count / +limit),
  })
}

export async function getProductById(req: Request, res: Response) {
  const row = await queryOne(
    `SELECT ${productJsonCols} FROM dbo.products p WHERE p.id = @id`,
    { id: uuidParam(req.params.id) }
  )
  if (!row) return res.status(404).json({ error: 'Product not found' })
  res.json(parseProductRow(row))
}

export async function createProduct(req: AuthRequest, res: Response) {
  const { title, description, type, category_id, base_price, discount_pct, coupon_code, coupon_disc } = req.body
  const id = randomUUID()

  try {
    const data = await queryOne(
      `INSERT INTO dbo.products (id, title, description, type, category_id, base_price, discount_pct, coupon_code, coupon_disc, created_by, published, created_at, updated_at)
       OUTPUT inserted.*
       VALUES (@id, @title, @description, @type, @category_id, @base_price, @discount_pct, @coupon_code, @coupon_disc, @created_by, 0, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET())`,
      {
        id: uuidParam(id), title, description: description ?? null, type,
        category_id: uuidParam(category_id || null),
        base_price, discount_pct: discount_pct ?? 0,
        coupon_code: coupon_code || null, coupon_disc: coupon_disc || null,
        created_by: uuidParam(req.user!.id),
      }
    )
    res.status(201).json(data)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Create failed' })
  }
}

export async function updateProduct(req: AuthRequest, res: Response) {
  const allowed = ['title', 'description', 'type', 'category_id', 'base_price', 'discount_pct', 'coupon_code', 'coupon_disc']
  const sets: string[] = ['updated_at = SYSDATETIMEOFFSET()']
  const params: Record<string, unknown> = { id: uuidParam(req.params.id) }
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      sets.push(`${key} = @${key}`)
      params[key] = key === 'category_id' ? uuidParam(req.body[key] || null) : req.body[key]
    }
  }

  try {
    const data = await queryOne(
      `UPDATE dbo.products SET ${sets.join(', ')} OUTPUT inserted.* WHERE id = @id`,
      params
    )
    if (!data) return res.status(404).json({ error: 'Product not found' })
    res.json(data)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Update failed' })
  }
}

export async function publishProduct(req: AuthRequest, res: Response) {
  const data = await queryOne(
    'UPDATE dbo.products SET published = 1, updated_at = SYSDATETIMEOFFSET() OUTPUT inserted.* WHERE id = @id',
    { id: uuidParam(req.params.id) }
  )
  if (!data) return res.status(404).json({ error: 'Product not found' })
  res.json(data)
}

export async function unpublishProduct(req: AuthRequest, res: Response) {
  const data = await queryOne(
    'UPDATE dbo.products SET published = 0, updated_at = SYSDATETIMEOFFSET() OUTPUT inserted.* WHERE id = @id',
    { id: uuidParam(req.params.id) }
  )
  if (!data) return res.status(404).json({ error: 'Product not found' })
  res.json(data)
}

export async function deleteProduct(req: AuthRequest, res: Response) {
  try {
    await query('DELETE FROM dbo.products WHERE id = @id', { id: uuidParam(req.params.id) })
    res.json({ success: true })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Delete failed' })
  }
}

export async function addProductImage(req: AuthRequest, res: Response) {
  const { url, alt_text, is_primary, color, display_order } = req.body
  const { product_id } = req.params

  if (is_primary) {
    await query('UPDATE dbo.product_images SET is_primary = 0 WHERE product_id = @pid', {
      pid: uuidParam(product_id),
    })
  }

  const data = await queryOne(
    `INSERT INTO dbo.product_images (id, product_id, url, alt_text, is_primary, color, display_order)
     OUTPUT inserted.*
     VALUES (@id, @pid, @url, @alt_text, @is_primary, @color, @display_order)`,
    {
      id: uuidParam(randomUUID()), pid: uuidParam(product_id), url, alt_text: alt_text ?? null,
      is_primary: is_primary ? 1 : 0, color: color ?? null, display_order: display_order ?? 0,
    }
  )
  res.status(201).json(data)
}

export async function deleteProductImage(req: AuthRequest, res: Response) {
  const { product_id, image_id } = req.params
  await query('DELETE FROM dbo.product_images WHERE id = @iid AND product_id = @pid', {
    iid: uuidParam(image_id), pid: uuidParam(product_id),
  })
  res.json({ success: true })
}
