import { Response } from 'express'
import { query, queryOne, getPool, datetimeParam } from '../db'
import { AuthRequest } from '../middleware/auth'

function monthStartISO(): string {
  return new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()
}

export async function getDashboardStats(_req: AuthRequest, res: Response) {
  const monthStart = monthStartISO()
  const params = { monthStart: datetimeParam(monthStart) }

  const row = await queryOne<Record<string, number>>(
    `SELECT
       (SELECT ISNULL(SUM(total_amount),0) FROM dbo.orders WHERE status <> 'cancelled') AS onlineRevenue,
       (SELECT ISNULL(SUM(total_amount),0) FROM dbo.orders WHERE status <> 'cancelled' AND created_at >= @monthStart) AS onlineRevenueMonth,
       (SELECT COUNT(*) FROM dbo.orders) AS totalOrders,
       (SELECT COUNT(*) FROM dbo.orders WHERE status = 'placed') AS pendingOrders,
       (SELECT COUNT(*) FROM dbo.variants WHERE quantity > 0 AND quantity < 5) AS lowStockVariants,
       (SELECT COUNT(*) FROM dbo.variants WHERE quantity = 0) AS outOfStockVariants,
       (SELECT COUNT(*) FROM dbo.products WHERE published = 1) AS totalProducts,
       (SELECT COUNT(*) FROM dbo.profiles WHERE role = 'customer') AS totalCustomers,
       (SELECT COUNT(*) FROM dbo.profiles WHERE role = 'employee') AS totalEmployees,
       (SELECT ISNULL(SUM(unit_price * quantity),0) FROM dbo.offline_sales) AS offlineRevenue,
       (SELECT ISNULL(SUM(unit_price * quantity),0) FROM dbo.offline_sales WHERE created_at >= @monthStart) AS offlineRevenueMonth`,
    params
  )

  const r = row!
  res.json({
    totalRevenue: Number(r.onlineRevenue) + Number(r.offlineRevenue),
    revenueThisMonth: Number(r.onlineRevenueMonth) + Number(r.offlineRevenueMonth),
    onlineRevenue: Number(r.onlineRevenue),
    offlineRevenue: Number(r.offlineRevenue),
    totalOrders: Number(r.totalOrders),
    pendingOrders: Number(r.pendingOrders),
    lowStockVariants: Number(r.lowStockVariants),
    outOfStockVariants: Number(r.outOfStockVariants),
    totalProducts: Number(r.totalProducts),
    totalCustomers: Number(r.totalCustomers),
    totalEmployees: Number(r.totalEmployees),
  })
}

export async function getSalesTimeline(_req: AuthRequest, res: Response) {
  const pool = await getPool()
  const result = await pool.request().execute('dbo.daily_sales_last_30_days')
  res.json(result.recordset ?? [])
}

export async function getInventory(req: AuthRequest, res: Response) {
  const { type, category } = req.query

  const rows = await query<{ id: string; color: string; size: string; quantity: number; sold_count: number; product: string | null }>(
    `SELECT v.id, v.color, v.size, v.quantity, v.sold_count,
       JSON_QUERY((SELECT p.id, p.title, p.type, p.published,
         JSON_QUERY((SELECT c.id, c.name FROM dbo.categories c WHERE c.id = p.category_id FOR JSON PATH, INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER)) AS category
         FROM dbo.products p WHERE p.id = v.product_id FOR JSON PATH, INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER)) AS product
     FROM dbo.variants v ORDER BY v.sold_count DESC`
  )
  let data = rows.map((v) => ({ ...v, product: v.product ? JSON.parse(v.product) : null }))

  if (type) data = data.filter((v: any) => v.product?.type === type)
  if (category) data = data.filter((v: any) => v.product?.category?.id === category)

  res.json(data)
}

// Per-employee offline-sales performance + top performer.
export async function getEmployeePerformance(req: AuthRequest, res: Response) {
  const period = req.query.period as string | undefined

  let since: string | undefined
  if (period === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); since = d.toISOString() }
  else if (period === 'week') { const d = new Date(); d.setDate(d.getDate() - 7); since = d.toISOString() }
  else if (period === 'month') { const d = new Date(); d.setDate(d.getDate() - 30); since = d.toISOString() }

  const where = since ? 'WHERE os.created_at >= @since' : ''
  const params = since ? { since: datetimeParam(since) } : {}

  const rows = await query<{ id: string; name: string; revenue: number; itemsSold: number; saleCount: number }>(
    `SELECT pr.id, MAX(pr.name) AS name,
            SUM(os.unit_price * os.quantity) AS revenue,
            SUM(os.quantity) AS itemsSold,
            COUNT(*) AS saleCount
     FROM dbo.offline_sales os JOIN dbo.profiles pr ON pr.id = os.sold_by
     ${where}
     GROUP BY pr.id
     ORDER BY revenue DESC`,
    params
  )
  const employees = rows.map((e) => ({ id: e.id, name: e.name ?? 'Unknown', revenue: Number(e.revenue), itemsSold: Number(e.itemsSold), saleCount: Number(e.saleCount) }))
  res.json({ employees, topPerformer: employees[0] ?? null })
}

// Online (web orders) vs offline (in-person) sales totals.
export async function getSalesSummary(_req: AuthRequest, res: Response) {
  const row = await queryOne<Record<string, number>>(
    `SELECT
       (SELECT ISNULL(SUM(total_amount),0) FROM dbo.orders WHERE status <> 'cancelled') AS onlineRevenue,
       (SELECT COUNT(*) FROM dbo.orders WHERE status <> 'cancelled') AS onlineCount,
       (SELECT ISNULL(SUM(unit_price * quantity),0) FROM dbo.offline_sales) AS offlineRevenue,
       (SELECT COUNT(*) FROM dbo.offline_sales) AS offlineCount`
  )
  const r = row!
  res.json({
    onlineRevenue: Number(r.onlineRevenue),
    offlineRevenue: Number(r.offlineRevenue),
    totalRevenue: Number(r.onlineRevenue) + Number(r.offlineRevenue),
    onlineCount: Number(r.onlineCount),
    offlineCount: Number(r.offlineCount),
  })
}

// Per-category inventory depth.
export async function getCategoryInventory(_req: AuthRequest, res: Response) {
  const data = await query<{ quantity: number; color: string | null; product: string | null }>(
    `SELECT v.quantity, v.color,
       JSON_QUERY((SELECT p.id, p.type,
         JSON_QUERY((SELECT c.id, c.name, c.parent_id FROM dbo.categories c WHERE c.id = p.category_id FOR JSON PATH, INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER)) AS category
         FROM dbo.products p WHERE p.id = v.product_id FOR JSON PATH, INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER)) AS product
     FROM dbo.variants v`
  )

  type Bucket = {
    id: string; name: string; parentId: string | null; itemsLeft: number
    variantCount: number; lowStock: number; products: Set<string>
    colors: Record<string, number>; types: Set<string>
  }
  const map: Record<string, Bucket> = {}

  for (const row of data) {
    const product = row.product ? JSON.parse(row.product) : null
    const cat = product?.category
    const key = cat?.id ?? 'uncategorized'
    if (!map[key]) {
      map[key] = { id: key, name: cat?.name ?? 'Uncategorized', parentId: cat?.parent_id ?? null, itemsLeft: 0, variantCount: 0, lowStock: 0, products: new Set(), colors: {}, types: new Set() }
    }
    const b = map[key]
    const qty = Number(row.quantity)
    b.itemsLeft += qty
    b.variantCount += 1
    if (qty < 5) b.lowStock += 1
    if (product?.id) b.products.add(product.id)
    if (row.color) b.colors[row.color] = (b.colors[row.color] || 0) + qty
    if (product?.type) b.types.add(product.type)
  }

  const result = Object.values(map)
    .map((b) => ({
      id: b.id, name: b.name, parentId: b.parentId, type: [...b.types][0] ?? null,
      productCount: b.products.size, colorCount: Object.keys(b.colors).length,
      colors: Object.entries(b.colors).map(([color, qty]) => ({ color, qty })),
      variantCount: b.variantCount, itemsLeft: b.itemsLeft, lowStock: b.lowStock,
    }))
    .sort((a, b) => b.itemsLeft - a.itemsLeft)

  res.json(result)
}

export async function getCategorySales(_req: AuthRequest, res: Response) {
  // Combine online order items with offline sales for per-type revenue.
  const rows = await query<{ type: string; revenue: number; count: number }>(
    `SELECT type, SUM(revenue) AS revenue, SUM(cnt) AS count FROM (
       SELECT ISNULL(p.type, 'unknown') AS type, oi.quantity * oi.unit_price AS revenue, oi.quantity AS cnt
       FROM dbo.order_items oi LEFT JOIN dbo.products p ON p.id = oi.product_id
       UNION ALL
       SELECT ISNULL(p.type, 'unknown') AS type, os.quantity * os.unit_price AS revenue, os.quantity AS cnt
       FROM dbo.offline_sales os LEFT JOIN dbo.products p ON p.id = os.product_id
     ) t GROUP BY type ORDER BY revenue DESC`
  )
  res.json(rows.map((g) => ({ type: g.type, revenue: Number(g.revenue), count: Number(g.count) })))
}
