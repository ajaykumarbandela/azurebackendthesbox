import { Response } from 'express'
import { query, queryOne, uuidParam } from '../db'
import { AuthRequest } from '../middleware/auth'
import { notifyCustomerStatusUpdate } from '../services/notificationService'
import {
  assignAwb,
  cancelByAwbs,
  checkServiceability,
  createAdhocOrder,
  generateInvoice,
  generateLabel,
  generateManifest,
  getPickupLocation,
  getPickupPincode,
  trackByAwb,
  type CreateAdhocOrderPayload,
} from '../services/shiprocketService'
import type { OrderStatus } from '../types'

// order embed for shipment (product: id,title,type — no images; variant: id,color,size,sku)
const ORDER_JSON = `
  o.*,
  JSON_QUERY((SELECT pr.id, pr.name, pr.phone FROM dbo.profiles pr WHERE pr.id = o.user_id FOR JSON PATH, INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER)) AS [user],
  JSON_QUERY((SELECT a.* FROM dbo.addresses a WHERE a.id = o.address_id FOR JSON PATH, INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER)) AS [address],
  JSON_QUERY((SELECT oi.id, oi.quantity, oi.unit_price,
      JSON_QUERY((SELECT p.id, p.title, p.type FROM dbo.products p WHERE p.id = oi.product_id FOR JSON PATH, INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER)) AS product,
      JSON_QUERY((SELECT v.id, v.color, v.size, v.sku FROM dbo.variants v WHERE v.id = oi.variant_id FOR JSON PATH, INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER)) AS variant
    FROM dbo.order_items oi WHERE oi.order_id = o.id FOR JSON PATH, INCLUDE_NULL_VALUES)) AS order_items`

type OrderRecord = Record<string, any>
function parseOrder(row: Record<string, unknown> | null): OrderRecord | null {
  if (!row) return null
  return {
    ...row,
    user: row.user ? JSON.parse(row.user as string) : null,
    address: row.address ? JSON.parse(row.address as string) : null,
    order_items: row.order_items ? JSON.parse(row.order_items as string) : [],
  }
}

const WEIGHT_KG: Record<string, number> = { saree: 0.5, jewellery: 0.2 }

function defaultWeightKg(items: Array<{ quantity: number; product?: { type?: string } | null }>): number {
  let total = 0
  for (const item of items) {
    const type = item.product?.type ?? 'saree'
    total += (WEIGHT_KG[type] ?? 0.5) * item.quantity
  }
  return Math.max(0.1, Math.round(total * 100) / 100)
}

async function loadOrderForShipment(orderId: string, userId?: string) {
  const where = ['o.id = @id']
  const params: Record<string, unknown> = { id: uuidParam(orderId) }
  if (userId) { where.push('o.user_id = @uid'); params.uid = uuidParam(userId) }
  const row = await queryOne(`SELECT ${ORDER_JSON} FROM dbo.orders o WHERE ${where.join(' AND ')}`, params)
  return parseOrder(row)
}

async function getCustomerEmail(userId: string): Promise<string> {
  const row = await queryOne<{ email: string | null }>(
    'SELECT email FROM dbo.profiles WHERE id = @id',
    { id: uuidParam(userId) }
  )
  return row?.email ?? 'customer@yuvaranisilks.in'
}

function buildAdhocPayload(order: any, email: string, weight: number): CreateAdhocOrderPayload {
  const addr = order.address as { line1: string; line2?: string; city: string; state: string; pincode: string; country?: string }
  const user = order.user as { name: string; phone?: string }
  const nameParts = (user?.name ?? 'Customer').trim().split(/\s+/)
  const firstName = nameParts[0] ?? 'Customer'
  const lastName = nameParts.slice(1).join(' ') || '.'

  const items = (order.order_items ?? []) as Array<{
    quantity: number; unit_price: number
    product?: { title?: string; type?: string } | null
    variant?: { sku?: string; color?: string; size?: string } | null
  }>

  return {
    order_id: order.id.slice(0, 8).toUpperCase(),
    order_date: new Date(order.created_at).toISOString().slice(0, 16).replace('T', ' '),
    pickup_location: getPickupLocation(),
    billing_customer_name: firstName,
    billing_last_name: lastName,
    billing_address: addr.line1,
    billing_address_2: addr.line2 ?? undefined,
    billing_city: addr.city,
    billing_pincode: addr.pincode,
    billing_state: addr.state,
    billing_country: addr.country ?? 'India',
    billing_email: email,
    billing_phone: user?.phone ?? '9999999999',
    shipping_is_billing: true,
    order_items: items.map((item, idx) => ({
      name: item.product?.title ?? `Item ${idx + 1}`,
      sku: item.variant?.sku ?? `SKU-${idx + 1}`,
      units: item.quantity,
      selling_price: Number(item.unit_price),
    })),
    payment_method: 'Prepaid',
    sub_total: Number(order.total_amount),
    length: 20, breadth: 15, height: 5, weight,
  }
}

export async function checkServiceabilityHandler(req: AuthRequest, res: Response) {
  const { orderId, weight: weightOverride } = req.body as { orderId?: string; weight?: number }
  if (!orderId) return res.status(400).json({ error: 'orderId is required' })

  const order = await loadOrderForShipment(orderId)
  if (!order) return res.status(404).json({ error: 'Order not found' })
  if (!order.address) return res.status(400).json({ error: 'Order has no delivery address' })

  const addr = order.address as { pincode: string }
  const items = (order.order_items ?? []) as Array<{ quantity: number; product?: { type?: string } }>
  const weight = weightOverride ?? defaultWeightKg(items)

  const couriers = await checkServiceability({
    pickup_postcode: getPickupPincode(),
    delivery_postcode: addr.pincode,
    weight, cod: 0,
    order_id: (order.shiprocket_order_id as string) ?? order.id.slice(0, 8),
  })

  res.json({ couriers, weight, delivery_pincode: addr.pincode })
}

export async function createShipmentHandler(req: AuthRequest, res: Response) {
  const { orderId, courier_id, weight: weightOverride } = req.body as { orderId?: string; courier_id?: number; weight?: number }
  if (!orderId || courier_id == null) {
    return res.status(400).json({ error: 'orderId and courier_id are required' })
  }

  const order = await loadOrderForShipment(orderId)
  if (!order) return res.status(404).json({ error: 'Order not found' })
  if (order.shiprocket_awb) return res.status(400).json({ error: 'Shipment already created for this order' })
  if (!order.address) return res.status(400).json({ error: 'Order has no delivery address' })

  const allowedStatuses = ['confirmed', 'processing']
  if (!allowedStatuses.includes(order.status as string)) {
    return res.status(400).json({ error: `Cannot ship order with status "${order.status}". Order must be confirmed first.` })
  }

  const items = (order.order_items ?? []) as Array<{ quantity: number; product?: { type?: string } }>
  const weight = weightOverride ?? defaultWeightKg(items)
  const email = await getCustomerEmail(order.user_id as string)
  const payload = buildAdhocPayload(order, email, weight)

  const created = await createAdhocOrder(payload)
  const awbResult = await assignAwb(created.shipment_id, courier_id)
  const trackingUrl = `https://shiprocket.co/tracking/${awbResult.awb_code}`

  await query(
    `UPDATE dbo.orders SET shiprocket_order_id=@soid, shiprocket_shipment_id=@ssid, shiprocket_awb=@awb,
       shiprocket_courier_id=@cid, shiprocket_courier_name=@cname, tracking_url=@turl,
       shipment_status='AWB ASSIGNED', status='processing', updated_at=SYSDATETIMEOFFSET()
     WHERE id=@id`,
    {
      soid: String(created.order_id), ssid: String(created.shipment_id), awb: awbResult.awb_code,
      cid: courier_id, cname: awbResult.courier_name, turl: trackingUrl, id: uuidParam(orderId),
    }
  )
  const updated = await loadOrderForShipment(orderId)

  notifyCustomerStatusUpdate(order.user_id as string, orderId, 'processing')

  res.json({
    order: updated, awb: awbResult.awb_code, courier_name: awbResult.courier_name,
    tracking_url: trackingUrl, shiprocket_order_id: created.order_id, shiprocket_shipment_id: created.shipment_id,
  })
}

async function requireShipment(
  orderId: string
): Promise<{ ok: true; order: any } | { ok: false; error: string; status: number }> {
  const order = await loadOrderForShipment(orderId)
  if (!order) return { ok: false, error: 'Order not found', status: 404 }
  if (!order.shiprocket_shipment_id) return { ok: false, error: 'No Shiprocket shipment on this order', status: 400 }
  return { ok: true, order }
}

export async function getLabelHandler(req: AuthRequest, res: Response) {
  const { orderId } = req.params
  const loaded = await requireShipment(orderId)
  if (!loaded.ok) return res.status(loaded.status).json({ error: loaded.error })

  const shipmentId = Number(loaded.order.shiprocket_shipment_id)
  if (!Number.isFinite(shipmentId)) return res.status(400).json({ error: 'Invalid Shiprocket shipment id' })
  const labelUrl = await generateLabel([shipmentId])

  await query('UPDATE dbo.orders SET label_url=@u, updated_at=SYSDATETIMEOFFSET() WHERE id=@id', { u: labelUrl, id: uuidParam(orderId) })
  res.json({ label_url: labelUrl })
}

export async function getInvoiceHandler(req: AuthRequest, res: Response) {
  const { orderId } = req.params
  const loaded = await requireShipment(orderId)
  if (!loaded.ok) return res.status(loaded.status).json({ error: loaded.error })

  const srOrderId = Number(loaded.order.shiprocket_order_id)
  if (!Number.isFinite(srOrderId)) return res.status(400).json({ error: 'Invalid Shiprocket order id' })
  const invoiceUrl = await generateInvoice([srOrderId])

  await query('UPDATE dbo.orders SET invoice_url=@u, updated_at=SYSDATETIMEOFFSET() WHERE id=@id', { u: invoiceUrl, id: uuidParam(orderId) })
  res.json({ invoice_url: invoiceUrl })
}

export async function getManifestHandler(req: AuthRequest, res: Response) {
  const { orderId } = req.params
  const loaded = await requireShipment(orderId)
  if (!loaded.ok) return res.status(loaded.status).json({ error: loaded.error })

  const shipmentId = Number(loaded.order.shiprocket_shipment_id)
  if (!Number.isFinite(shipmentId)) return res.status(400).json({ error: 'Invalid Shiprocket shipment id' })
  const manifestUrl = await generateManifest([shipmentId])

  await query('UPDATE dbo.orders SET manifest_url=@u, updated_at=SYSDATETIMEOFFSET() WHERE id=@id', { u: manifestUrl, id: uuidParam(orderId) })
  res.json({ manifest_url: manifestUrl })
}

export async function trackShipmentHandler(req: AuthRequest, res: Response) {
  const { orderId } = req.params
  const userId = req.user!.role === 'customer' ? req.user!.id : undefined
  const order = await loadOrderForShipment(orderId, userId)
  if (!order) return res.status(404).json({ error: 'Order not found' })
  if (!order.shiprocket_awb) return res.status(400).json({ error: 'No AWB assigned yet' })

  const tracking = await trackByAwb(order.shiprocket_awb as string)
  res.json({ tracking, awb: order.shiprocket_awb, tracking_url: order.tracking_url })
}

export async function cancelShipmentHandler(req: AuthRequest, res: Response) {
  const { orderId } = req.params
  const loaded = await requireShipment(orderId)
  if (!loaded.ok) return res.status(loaded.status).json({ error: loaded.error })

  if (['shipped', 'delivered'].includes(loaded.order.status)) {
    return res.status(400).json({ error: 'Cannot cancel shipment after it has been shipped' })
  }

  const awb = loaded.order.shiprocket_awb
  if (!awb) return res.status(400).json({ error: 'No AWB on this order' })
  await cancelByAwbs([awb])

  await query(
    `UPDATE dbo.orders SET shiprocket_order_id=NULL, shiprocket_shipment_id=NULL, shiprocket_awb=NULL,
       shiprocket_courier_id=NULL, shiprocket_courier_name=NULL, tracking_url=NULL, shipment_status='CANCELLED',
       label_url=NULL, invoice_url=NULL, manifest_url=NULL, updated_at=SYSDATETIMEOFFSET()
     WHERE id=@id`,
    { id: uuidParam(orderId) }
  )
  const data = await loadOrderForShipment(orderId)
  res.json({ order: data, message: 'Shipment cancelled on Shiprocket' })
}

function mapWebhookToOrderStatus(currentStatus: string): OrderStatus | null {
  const s = currentStatus.toUpperCase()
  if (s.includes('DELIVERED')) return 'delivered'
  if (s.includes('PICKED') || s.includes('TRANSIT') || s.includes('OUT FOR DELIVERY') || s.includes('SHIPPED')) return 'shipped'
  return null
}

export async function webhookHandler(req: AuthRequest, res: Response) {
  const token = req.headers['x-api-key'] as string | undefined
  const expected = process.env.SHIPROCKET_WEBHOOK_TOKEN
  if (!expected || token !== expected) return res.status(401).json({ error: 'Invalid webhook token' })

  const body = req.body as { awb?: string; current_status?: string; shipment_status?: string; etd?: string; scans?: unknown }
  const awb = body.awb
  const shipmentStatus = body.current_status ?? body.shipment_status ?? ''
  if (!awb) return res.status(200).json({ ok: true, skipped: 'no awb' })

  const order = await queryOne<{ id: string; user_id: string; status: string }>(
    'SELECT id, user_id, status FROM dbo.orders WHERE shiprocket_awb = @awb',
    { awb }
  )
  if (!order) return res.status(200).json({ ok: true, skipped: 'order not found' })

  const newStatus = mapWebhookToOrderStatus(shipmentStatus)
  const sets = ['shipment_status = @ss', 'updated_at = SYSDATETIMEOFFSET()']
  const params: Record<string, unknown> = { ss: shipmentStatus, id: uuidParam(order.id) }
  if (body.etd) { sets.push('expected_delivery_date = @etd'); params.etd = body.etd.slice(0, 10) }
  if (newStatus && newStatus !== order.status) { sets.push('status = @status'); params.status = newStatus }

  await query(`UPDATE dbo.orders SET ${sets.join(', ')} WHERE id = @id`, params)

  if (newStatus && newStatus !== order.status) {
    notifyCustomerStatusUpdate(order.user_id, order.id, newStatus)
  }
  res.json({ ok: true })
}
