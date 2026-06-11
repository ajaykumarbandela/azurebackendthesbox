import Razorpay from 'razorpay'
import crypto from 'crypto'
import { Response } from 'express'
import { randomUUID } from 'crypto'
import { query, queryOne, getPool, uuidParam, sql } from '../db'
import {
  notifyAdminOrderPlaced,
  notifyCustomerStatusUpdate,
} from '../services/notificationService'
import { AuthRequest } from '../middleware/auth'
import { VALID_ORDER_TRANSITIONS, OrderStatus } from '../types'

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
})

// Reproduces the Supabase orderSelect embed:
//   { ...order, user:{id,name,phone}, address:{...},
//     order_items:[{ id,quantity,unit_price,
//       product:{id,title,type,images:[{url,is_primary}]},
//       variant:{id,color,size,sku} }] }
const orderJsonCols = `
  o.*,
  JSON_QUERY((SELECT pr.id, pr.name, pr.phone FROM dbo.profiles pr WHERE pr.id = o.user_id
              FOR JSON PATH, INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER)) AS [user],
  JSON_QUERY((SELECT a.* FROM dbo.addresses a WHERE a.id = o.address_id
              FOR JSON PATH, INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER)) AS [address],
  JSON_QUERY((
    SELECT oi.id, oi.quantity, oi.unit_price,
      JSON_QUERY((SELECT p2.id, p2.title, p2.type,
        JSON_QUERY((SELECT img.url, img.is_primary FROM dbo.product_images img WHERE img.product_id = p2.id
                    FOR JSON PATH, INCLUDE_NULL_VALUES)) AS images
        FROM dbo.products p2 WHERE p2.id = oi.product_id
        FOR JSON PATH, INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER)) AS product,
      JSON_QUERY((SELECT v.id, v.color, v.size, v.sku FROM dbo.variants v WHERE v.id = oi.variant_id
                  FOR JSON PATH, INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER)) AS variant
    FROM dbo.order_items oi WHERE oi.order_id = o.id
    FOR JSON PATH, INCLUDE_NULL_VALUES
  )) AS order_items`

function parseOrderRow(row: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!row) return row
  return {
    ...row,
    user: row.user ? JSON.parse(row.user as string) : null,
    address: row.address ? JSON.parse(row.address as string) : null,
    order_items: row.order_items ? JSON.parse(row.order_items as string) : [],
  }
}

// Builds the internal order from the user's cart + address, then creates the
// matching Razorpay order. Amount is computed server-side, never trusted from
// the client. verifyPayment later flips this order to 'confirmed'.
export async function createRazorpayOrder(req: AuthRequest, res: Response) {
  const { address, coupon } = req.body
  const userId = req.user!.id

  const cart = await query<{
    product_id: string; variant_id: string; quantity: number
    base_price: number; discount_pct: number; product_category_id: string | null
    category_parent_id: string | null; variant_quantity: number
  }>(
    `SELECT ci.product_id, ci.variant_id, ci.quantity,
            p.base_price, p.discount_pct, p.category_id AS product_category_id,
            c.parent_id AS category_parent_id, v.quantity AS variant_quantity
     FROM dbo.cart_items ci
     LEFT JOIN dbo.products p ON p.id = ci.product_id
     LEFT JOIN dbo.categories c ON c.id = p.category_id
     LEFT JOIN dbo.variants v ON v.id = ci.variant_id
     WHERE ci.user_id = @uid`,
    { uid: uuidParam(userId) }
  )

  if (!cart.length) return res.status(400).json({ error: 'Your cart is empty' })

  let subtotal = 0
  const items: { product_id: string; variant_id: string; quantity: number; unit_price: number }[] = []
  for (const c of cart) {
    if (c.base_price == null || c.variant_quantity == null) {
      return res.status(400).json({ error: 'An item in your cart is no longer available' })
    }
    if (c.variant_quantity < c.quantity) {
      return res.status(400).json({ error: 'Insufficient stock for an item in your cart' })
    }
    const unitPrice = Math.round(c.base_price * (1 - (c.discount_pct ?? 0) / 100))
    subtotal += unitPrice * c.quantity
    items.push({ product_id: c.product_id, variant_id: c.variant_id, quantity: c.quantity, unit_price: unitPrice })
  }

  // Optional coupon
  let discount = 0
  let couponCode: string | null = null
  if (coupon) {
    const cp = await queryOne<{
      code: string; discount_pct: number; max_uses: number | null; used_count: number
      starts_at: string | null; expires_at: string | null; active: boolean
      category_id: string | null; product_id: string | null
    }>(
      `SELECT code, discount_pct, max_uses, used_count, starts_at, expires_at, active, category_id, product_id
       FROM dbo.coupons WHERE code = @code`,
      { code: coupon }
    )
    const now = new Date()
    const timeValid =
      cp && cp.active &&
      (!cp.starts_at || new Date(cp.starts_at) <= now) &&
      (!cp.expires_at || new Date(cp.expires_at) > now) &&
      (cp.max_uses == null || cp.used_count < cp.max_uses)
    let scopeMatch = true
    if (timeValid && (cp!.category_id || cp!.product_id)) {
      scopeMatch = cart.some((c) => {
        if (cp!.product_id && c.product_id === cp!.product_id) return true
        if (cp!.category_id) return c.product_category_id === cp!.category_id || c.category_parent_id === cp!.category_id
        return false
      })
    }
    if (timeValid && scopeMatch) {
      discount = Math.round((subtotal * cp!.discount_pct) / 100)
      couponCode = cp!.code
    }
  }

  const shipping = subtotal >= 999 ? 0 : 99
  const total = subtotal + shipping - discount
  if (total <= 0) return res.status(400).json({ error: 'Invalid order total' })

  // Persist address
  let addressId: string | null = null
  if (address?.line1) {
    const aid = randomUUID()
    await query(
      `INSERT INTO dbo.addresses (id, user_id, line1, line2, city, state, pincode, country, created_at)
       VALUES (@id, @uid, @l1, @l2, @city, @state, @pin, @country, SYSDATETIMEOFFSET())`,
      {
        id: uuidParam(aid), uid: uuidParam(userId), l1: address.line1, l2: address.line2 ?? null,
        city: address.city, state: address.state, pin: address.pincode, country: address.country ?? 'India',
      }
    )
    addressId = aid
  }

  // Internal order awaiting payment + items, in one transaction
  const orderId = randomUUID()
  await query(
    `INSERT INTO dbo.orders (id, user_id, address_id, status, total_amount, discount_amount, coupon_applied, created_at, updated_at)
     VALUES (@id, @uid, @aid, 'placed', @total, @disc, @coupon, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET())`,
    { id: uuidParam(orderId), uid: uuidParam(userId), aid: uuidParam(addressId), total, disc: discount, coupon: couponCode }
  )
  for (const i of items) {
    await query(
      `INSERT INTO dbo.order_items (id, order_id, product_id, variant_id, quantity, unit_price)
       VALUES (@id, @oid, @pid, @vid, @qty, @price)`,
      { id: uuidParam(randomUUID()), oid: uuidParam(orderId), pid: uuidParam(i.product_id), vid: uuidParam(i.variant_id), qty: i.quantity, price: i.unit_price }
    )
  }
  if (couponCode) {
    await getPool().then((p) => p.request().input('code', couponCode).execute('dbo.increment_coupon_usage'))
  }

  const rzpOrder = await razorpay.orders.create({
    amount: Math.round(total * 100),
    currency: 'INR',
    receipt: orderId,
  })

  res.json({ razorpay_order_id: rzpOrder.id, amount: rzpOrder.amount, currency: rzpOrder.currency, order_id: orderId })
}

export async function placeOrder(req: AuthRequest, res: Response) {
  const { address_id, items, coupon_code, total_amount, discount_amount = 0 } = req.body
  if (!items?.length) return res.status(400).json({ error: 'Order must have at least one item' })

  const variantIds: string[] = items.map((i: { variant_id: string }) => i.variant_id)
  const variants = await query<{ id: string; quantity: number }>(
    `SELECT id, quantity FROM dbo.variants WHERE id IN (${variantIds.map((_, i) => `@v${i}`).join(',')})`,
    Object.fromEntries(variantIds.map((v, i) => [`v${i}`, uuidParam(v)]))
  )
  for (const item of items as { variant_id: string; quantity: number }[]) {
    const v = variants.find((x) => x.id.toLowerCase() === item.variant_id.toLowerCase())
    if (!v || v.quantity < item.quantity) {
      return res.status(400).json({ error: `Insufficient stock for variant ${item.variant_id}` })
    }
  }

  const orderId = randomUUID()
  const order = await queryOne(
    `INSERT INTO dbo.orders (id, user_id, address_id, status, total_amount, discount_amount, coupon_applied, created_at, updated_at)
     OUTPUT inserted.*
     VALUES (@id, @uid, @aid, 'placed', @total, @disc, @coupon, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET())`,
    { id: uuidParam(orderId), uid: uuidParam(req.user!.id), aid: uuidParam(address_id || null), total: total_amount, disc: discount_amount, coupon: coupon_code || null }
  )

  for (const i of items as { product_id: string; variant_id: string; quantity: number; unit_price: number }[]) {
    await query(
      `INSERT INTO dbo.order_items (id, order_id, product_id, variant_id, quantity, unit_price)
       VALUES (@id, @oid, @pid, @vid, @qty, @price)`,
      { id: uuidParam(randomUUID()), oid: uuidParam(orderId), pid: uuidParam(i.product_id), vid: uuidParam(i.variant_id), qty: i.quantity, price: i.unit_price }
    )
  }
  if (coupon_code) {
    await getPool().then((p) => p.request().input('code', coupon_code).execute('dbo.increment_coupon_usage'))
  }

  res.status(201).json(order)
}

export async function verifyPayment(req: AuthRequest, res: Response) {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, order_id } = req.body

  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex')
  if (expected !== razorpay_signature) {
    return res.status(400).json({ error: 'Payment signature mismatch' })
  }

  const order = await queryOne<{ id: string }>(
    `UPDATE dbo.orders SET status = 'confirmed', razorpay_order_id = @roid, razorpay_payment_id = @rpid, updated_at = SYSDATETIMEOFFSET()
     OUTPUT inserted.id
     WHERE id = @id AND user_id = @uid`,
    { roid: razorpay_order_id, rpid: razorpay_payment_id, id: uuidParam(order_id), uid: uuidParam(req.user!.id) }
  )
  if (!order) return res.status(400).json({ error: 'Order not found' })

  const orderItems = await query<{ variant_id: string; quantity: number }>(
    'SELECT variant_id, quantity FROM dbo.order_items WHERE order_id = @oid',
    { oid: uuidParam(order_id) }
  )
  const pool = await getPool()
  for (const item of orderItems) {
    await pool.request()
      .input('variant_id', sql.UniqueIdentifier, item.variant_id)
      .input('qty', sql.Int, item.quantity)
      .execute('dbo.decrement_variant_stock')
  }

  await query('DELETE FROM dbo.cart_items WHERE user_id = @uid', { uid: uuidParam(req.user!.id) })

  const full = parseOrderRow(await queryOne(`SELECT ${orderJsonCols} FROM dbo.orders o WHERE o.id = @id`, { id: uuidParam(order_id) }))
  notifyAdminOrderPlaced(full as unknown as { id: string; total_amount: number; order_items?: unknown[] })

  res.json({ success: true, order: full })
}

export async function getOrders(req: AuthRequest, res: Response) {
  const { status, userId, page = '1', limit = '20' } = req.query

  const where: string[] = []
  const params: Record<string, unknown> = { offset: (+page - 1) * +limit, limit: +limit }
  if (req.user!.role === 'customer') { where.push('o.user_id = @uid'); params.uid = uuidParam(req.user!.id) }
  else if (userId) { where.push('o.user_id = @uid'); params.uid = uuidParam(userId as string) }
  if (status) { where.push('o.status = @status'); params.status = status }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const rows = await query(
    `SELECT ${orderJsonCols} FROM dbo.orders o ${whereSql}
     ORDER BY o.created_at DESC OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
    params
  )
  const countRow = await queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM dbo.orders o ${whereSql}`, params)
  const count = countRow?.total ?? 0

  res.json({
    data: rows.map((r) => parseOrderRow(r)),
    count, total: count, page: +page, limit: +limit, totalPages: Math.ceil(count / +limit),
  })
}

export async function getOrderById(req: AuthRequest, res: Response) {
  const where = ['o.id = @id']
  const params: Record<string, unknown> = { id: uuidParam(req.params.id) }
  if (req.user!.role === 'customer') { where.push('o.user_id = @uid'); params.uid = uuidParam(req.user!.id) }

  const row = await queryOne(`SELECT ${orderJsonCols} FROM dbo.orders o WHERE ${where.join(' AND ')}`, params)
  if (!row) return res.status(404).json({ error: 'Order not found' })
  res.json(parseOrderRow(row))
}

export async function updateOrderStatus(req: AuthRequest, res: Response) {
  if (!['admin', 'employee'].includes(req.user!.role)) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  const { status } = req.body
  const { id } = req.params

  const current = await queryOne<{ status: string; user_id: string; razorpay_payment_id: string | null; total_amount: number }>(
    'SELECT status, user_id, razorpay_payment_id, total_amount FROM dbo.orders WHERE id = @id',
    { id: uuidParam(id) }
  )
  if (!current) return res.status(404).json({ error: 'Order not found' })

  if (!VALID_ORDER_TRANSITIONS[current.status as OrderStatus]?.includes(status)) {
    return res.status(400).json({
      error: `Cannot transition from ${current.status} to ${status}`,
      allowed: VALID_ORDER_TRANSITIONS[current.status as OrderStatus],
    })
  }

  if (status === 'refunded' && current.razorpay_payment_id) {
    try {
      await razorpay.payments.refund(current.razorpay_payment_id, { amount: Math.round(Number(current.total_amount) * 100) })
    } catch (err) {
      return res.status(502).json({ error: err instanceof Error ? err.message : 'Razorpay refund failed' })
    }
  }

  const sets = ['status = @status', 'updated_at = SYSDATETIMEOFFSET()']
  const params: Record<string, unknown> = { status, id: uuidParam(id) }
  if (status === 'refunded') sets.push("refund_status = 'completed'")

  const data = await queryOne(`UPDATE dbo.orders SET ${sets.join(', ')} OUTPUT inserted.* WHERE id = @id`, params)

  notifyCustomerStatusUpdate(current.user_id, id, status)
  res.json(data)
}

export async function requestRefund(req: AuthRequest, res: Response) {
  const reason = (req.body?.reason ?? '').toString().trim()
  if (!reason) return res.status(400).json({ error: 'Please add a reason for the refund request' })

  const where = ['id = @id']
  const params: Record<string, unknown> = { id: uuidParam(req.params.id) }
  if (req.user!.role === 'customer') { where.push('user_id = @uid'); params.uid = uuidParam(req.user!.id) }

  const current = await queryOne<{ status: string; refund_status: string | null }>(
    `SELECT status, refund_status, user_id FROM dbo.orders WHERE ${where.join(' AND ')}`,
    params
  )
  if (!current) return res.status(404).json({ error: 'Order not found' })

  const refundable: OrderStatus[] = ['confirmed', 'processing', 'shipped', 'delivered']
  if (!refundable.includes(current.status as OrderStatus)) {
    return res.status(400).json({ error: `A ${current.status} order cannot be refunded` })
  }
  if (current.refund_status === 'requested' || current.refund_status === 'completed') {
    return res.status(400).json({ error: 'A refund has already been requested for this order' })
  }

  await query(
    `UPDATE dbo.orders SET refund_status = 'requested', refund_reason = @reason, updated_at = SYSDATETIMEOFFSET() WHERE id = @id`,
    { reason, id: uuidParam(req.params.id) }
  )
  const row = await queryOne(`SELECT ${orderJsonCols} FROM dbo.orders o WHERE o.id = @id`, { id: uuidParam(req.params.id) })
  res.json(parseOrderRow(row))
}

export async function cancelOrder(req: AuthRequest, res: Response) {
  const where = ['id = @id']
  const params: Record<string, unknown> = { id: uuidParam(req.params.id) }
  if (req.user!.role === 'customer') { where.push('user_id = @uid'); params.uid = uuidParam(req.user!.id) }

  const current = await queryOne<{ status: string; user_id: string }>(
    `SELECT status, user_id FROM dbo.orders WHERE ${where.join(' AND ')}`,
    params
  )
  if (!current) return res.status(404).json({ error: 'Order not found' })

  if (!VALID_ORDER_TRANSITIONS[current.status as OrderStatus]?.includes('cancelled')) {
    return res.status(400).json({ error: `Cannot cancel an order with status ${current.status}` })
  }

  const data = await queryOne(
    `UPDATE dbo.orders SET status = 'cancelled', updated_at = SYSDATETIMEOFFSET() OUTPUT inserted.* WHERE id = @id`,
    { id: uuidParam(req.params.id) }
  )
  notifyCustomerStatusUpdate(current.user_id, req.params.id, 'cancelled')
  res.json(data)
}
