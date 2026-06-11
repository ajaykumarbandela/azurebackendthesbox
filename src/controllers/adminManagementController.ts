import { Response } from 'express'
import { randomUUID } from 'crypto'
import { query, queryOne, uuidParam } from '../db'
import { hashPassword } from '../auth/password'
import { AuthRequest } from '../middleware/auth'

// Email + active now live on profiles directly (Supabase auth.users is gone).
const adminCols = 'id, name, phone, role, email, active, created_at, updated_at'

export async function listAdmins(_req: AuthRequest, res: Response) {
  const data = await query(
    `SELECT ${adminCols} FROM dbo.profiles WHERE role = 'admin' ORDER BY created_at DESC`
  )
  res.json({ data })
}

export async function getAdmin(req: AuthRequest, res: Response) {
  const profile = await queryOne(
    `SELECT ${adminCols} FROM dbo.profiles WHERE id = @id AND role = 'admin'`,
    { id: uuidParam(req.params.id) }
  )
  if (!profile) return res.status(404).json({ error: 'Admin not found' })
  res.json(profile)
}

export async function createAdmin(req: AuthRequest, res: Response) {
  const { name, email, password, phone } = req.body

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password are required' })
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' })
  }

  const existing = await queryOne<{ id: string }>('SELECT id FROM dbo.profiles WHERE email = @email', { email })
  if (existing) return res.status(400).json({ error: 'A user with this email already exists' })

  const id = randomUUID()
  const passwordHash = await hashPassword(password)
  const profile = await queryOne(
    `INSERT INTO dbo.profiles (id, name, phone, role, employee_status, email, password_hash, active, created_at, updated_at)
     OUTPUT inserted.id, inserted.name, inserted.phone, inserted.role, inserted.email, inserted.active, inserted.created_at, inserted.updated_at
     VALUES (@id, @name, @phone, 'admin', NULL, @email, @hash, 1, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET())`,
    { id: uuidParam(id), name, phone: phone ?? null, email, hash: passwordHash }
  )

  res.status(201).json({
    admin: profile,
    credentials: { email, password },
    message: 'Admin created. Share these credentials securely with the store admin.',
  })
}

export async function updateAdmin(req: AuthRequest, res: Response) {
  const { id } = req.params
  const { name, phone, email } = req.body

  const existing = await queryOne<{ id: string }>(
    "SELECT id FROM dbo.profiles WHERE id = @id AND role = 'admin'",
    { id: uuidParam(id) }
  )
  if (!existing) return res.status(404).json({ error: 'Admin not found' })

  const sets: string[] = ['updated_at = SYSDATETIMEOFFSET()']
  const params: Record<string, unknown> = { id: uuidParam(id) }
  if (name !== undefined) { sets.push('name = @name'); params.name = name }
  if (phone !== undefined) { sets.push('phone = @phone'); params.phone = phone }
  if (email !== undefined) { sets.push('email = @email'); params.email = email }

  const profile = await queryOne(
    `UPDATE dbo.profiles SET ${sets.join(', ')}
     OUTPUT inserted.id, inserted.name, inserted.phone, inserted.role, inserted.email, inserted.active, inserted.created_at, inserted.updated_at
     WHERE id = @id`,
    params
  )
  res.json(profile)
}

export async function resetAdminPassword(req: AuthRequest, res: Response) {
  const { id } = req.params
  const { password } = req.body

  const profile = await queryOne<{ id: string }>(
    "SELECT id FROM dbo.profiles WHERE id = @id AND role = 'admin'",
    { id: uuidParam(id) }
  )
  if (!profile) return res.status(404).json({ error: 'Admin not found' })
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' })
  }

  await query('UPDATE dbo.profiles SET password_hash = @h, updated_at = SYSDATETIMEOFFSET() WHERE id = @id', {
    h: await hashPassword(password),
    id: uuidParam(id),
  })
  res.json({ success: true, message: 'Admin password updated' })
}

export async function setAdminActive(req: AuthRequest, res: Response) {
  const { id } = req.params
  const { active } = req.body

  if (typeof active !== 'boolean') {
    return res.status(400).json({ error: 'active must be a boolean' })
  }
  if (id === req.user!.id) {
    return res.status(400).json({ error: 'You cannot deactivate your own account' })
  }

  const profile = await queryOne<{ id: string }>(
    "SELECT id FROM dbo.profiles WHERE id = @id AND role = 'admin'",
    { id: uuidParam(id) }
  )
  if (!profile) return res.status(404).json({ error: 'Admin not found' })

  await query('UPDATE dbo.profiles SET active = @a, updated_at = SYSDATETIMEOFFSET() WHERE id = @id', {
    a: active ? 1 : 0,
    id: uuidParam(id),
  })
  res.json({ success: true, active })
}

export async function deleteAdmin(req: AuthRequest, res: Response) {
  const { id } = req.params

  if (id === req.user!.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' })
  }

  const profile = await queryOne<{ id: string }>(
    "SELECT id FROM dbo.profiles WHERE id = @id AND role = 'admin'",
    { id: uuidParam(id) }
  )
  if (!profile) return res.status(404).json({ error: 'Admin not found' })

  try {
    await query('DELETE FROM dbo.profiles WHERE id = @id', { id: uuidParam(id) })
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    return res.status(400).json({
      error: /REFERENCE|FOREIGN KEY|conflicted/i.test(msg)
        ? 'This admin has linked records and cannot be deleted.'
        : msg,
    })
  }
  res.json({ success: true })
}
