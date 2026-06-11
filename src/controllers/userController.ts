import { Response } from 'express'
import { randomUUID } from 'crypto'
import { query, queryOne, uuidParam } from '../db'
import { hashPassword } from '../auth/password'
import { AuthRequest } from '../middleware/auth'

const VALID_ROLES = ['customer', 'employee', 'admin']

// List users by role (admin only). Includes per-user order stats (customers)
// so the Customers screen can show spend at a glance. Email/active are columns
// now, joined in directly rather than merged from Supabase auth.
export async function listUsers(req: AuthRequest, res: Response) {
  const { role = 'customer', search, page = '1', limit = '20' } = req.query

  if (role === 'superadmin' || role === 'admin') {
    return res.status(403).json({ error: 'Forbidden' })
  }

  const offset = (+page - 1) * +limit
  const params: Record<string, unknown> = { role, limit: +limit, offset }
  let where = 'WHERE p.role = @role'
  if (search) { where += ' AND p.name LIKE @search'; params.search = `%${search}%` }

  // order stats aggregated per user in a correlated subquery
  const rows = await query(
    `SELECT p.id, p.name, p.phone, p.role, p.employee_status, p.email, p.active, p.created_at,
            ISNULL(s.orderCount, 0) AS orderCount, ISNULL(s.totalSpent, 0) AS totalSpent
     FROM dbo.profiles p
     OUTER APPLY (
       SELECT COUNT(*) AS orderCount, SUM(o.total_amount) AS totalSpent
       FROM dbo.orders o WHERE o.user_id = p.id AND o.status <> 'cancelled'
     ) s
     ${where}
     ORDER BY p.created_at DESC
     OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
    params
  )
  const countRow = await queryOne<{ total: number }>(
    `SELECT COUNT(*) AS total FROM dbo.profiles p ${where}`,
    params
  )

  res.json({ data: rows, count: countRow?.total ?? 0, page: +page, limit: +limit })
}

export async function getUser(req: AuthRequest, res: Response) {
  const profile = await queryOne<{ role: string }>(
    'SELECT * FROM dbo.profiles WHERE id = @id',
    { id: uuidParam(req.params.id) }
  )
  if (!profile) return res.status(404).json({ error: 'User not found' })
  if (profile.role === 'superadmin' || profile.role === 'admin') {
    return res.status(404).json({ error: 'User not found' })
  }
  res.json(profile)
}

// Create a user with any role (admin only). Admin-created employees are
// auto-approved — they skip the pending/approval flow self-registration uses.
export async function createUser(req: AuthRequest, res: Response) {
  const { name, email, password, phone, role = 'customer' } = req.body

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password are required' })
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' })
  }
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: 'role must be customer, employee or admin' })
  }
  if (role === 'admin') {
    return res.status(403).json({ error: 'Only super admins can create admin accounts' })
  }

  const existing = await queryOne<{ id: string }>('SELECT id FROM dbo.profiles WHERE email = @email', { email })
  if (existing) return res.status(400).json({ error: 'A user with this email already exists' })

  const id = randomUUID()
  const employee_status = role === 'employee' ? 'approved' : null
  const profile = await queryOne(
    `INSERT INTO dbo.profiles (id, name, phone, role, employee_status, email, password_hash, active, created_at, updated_at)
     OUTPUT inserted.*
     VALUES (@id, @name, @phone, @role, @es, @email, @hash, 1, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET())`,
    { id: uuidParam(id), name, phone: phone ?? null, role, es: employee_status, email, hash: await hashPassword(password) }
  )

  res.status(201).json(profile)
}

// Permanently delete a user account (admin only). Fails gracefully if the user
// still has linked records (FK blocks it).
export async function deleteUser(req: AuthRequest, res: Response) {
  const { id } = req.params
  if (id === req.user!.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' })
  }

  const profile = await queryOne<{ role: string }>('SELECT role FROM dbo.profiles WHERE id = @id', { id: uuidParam(id) })
  if (profile?.role === 'superadmin') {
    return res.status(404).json({ error: 'User not found' })
  }

  try {
    await query('DELETE FROM dbo.profiles WHERE id = @id', { id: uuidParam(id) })
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    return res.status(400).json({
      error: /REFERENCE|FOREIGN KEY|conflicted/i.test(msg)
        ? 'This account has orders or sales linked to it and cannot be deleted.'
        : msg,
    })
  }
  res.json({ success: true })
}

// Admin sets a new password for a user.
export async function resetUserPassword(req: AuthRequest, res: Response) {
  const { id } = req.params
  const { password } = req.body

  const profile = await queryOne<{ role: string }>('SELECT role FROM dbo.profiles WHERE id = @id', { id: uuidParam(id) })
  if (profile?.role === 'superadmin') {
    return res.status(404).json({ error: 'User not found' })
  }
  if (profile?.role === 'admin') {
    return res.status(403).json({ error: 'Only super admins can reset admin passwords' })
  }
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' })
  }

  await query('UPDATE dbo.profiles SET password_hash = @h, updated_at = SYSDATETIMEOFFSET() WHERE id = @id', {
    h: await hashPassword(password),
    id: uuidParam(id),
  })
  res.json({ success: true })
}

// Activate / deactivate a user. Sets the active flag (reversible), keeping all
// their records intact. Inactive users are blocked at login.
export async function setUserActive(req: AuthRequest, res: Response) {
  const { id } = req.params
  const { active } = req.body

  if (typeof active !== 'boolean') {
    return res.status(400).json({ error: 'active must be a boolean' })
  }
  if (id === req.user!.id && !active) {
    return res.status(400).json({ error: 'You cannot deactivate your own account' })
  }

  const profile = await queryOne<{ role: string }>('SELECT role FROM dbo.profiles WHERE id = @id', { id: uuidParam(id) })
  if (profile?.role === 'superadmin') {
    return res.status(404).json({ error: 'User not found' })
  }

  await query('UPDATE dbo.profiles SET active = @a, updated_at = SYSDATETIMEOFFSET() WHERE id = @id', {
    a: active ? 1 : 0,
    id: uuidParam(id),
  })
  res.json({ success: true, active })
}
