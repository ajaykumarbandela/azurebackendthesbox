import { Router, Request, Response } from 'express'
import { body, validationResult } from 'express-validator'
import { randomUUID } from 'crypto'
import { query, queryOne, uuidParam } from '../db'
import { hashPassword, verifyPassword } from '../auth/password'
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../auth/jwt'
import { authenticate, AuthRequest } from '../middleware/auth'
import { authLimiter } from '../middleware/rateLimiter'

const router = Router()

interface ProfileRow {
  id: string
  name: string
  phone: string | null
  role: string
  employee_status: string | null
  email: string | null
}

function publicUser(p: ProfileRow) {
  return { id: p.id, name: p.name, phone: p.phone, role: p.role, employee_status: p.employee_status, email: p.email }
}

function issueTokens(p: ProfileRow) {
  return {
    token: signAccessToken({ sub: p.id, email: p.email ?? '', role: p.role }),
    refreshToken: signRefreshToken(p.id),
  }
}

router.post(
  '/register',
  authLimiter,
  [
    body('email').isEmail(),
    body('password').isLength({ min: 8 }),
    body('name').trim().notEmpty(),
    body('role').optional().isIn(['customer', 'employee']),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() })

    const { email, password, name, phone, role = 'customer' } = req.body

    const existing = await queryOne<{ id: string }>(
      'SELECT id FROM dbo.profiles WHERE email = @email',
      { email }
    )
    if (existing) return res.status(400).json({ error: 'A user with this email already exists' })

    const id = randomUUID()
    const passwordHash = await hashPassword(password)
    const employeeStatus = role === 'employee' ? 'pending' : null

    await query(
      `INSERT INTO dbo.profiles (id, name, phone, role, employee_status, email, password_hash, created_at, updated_at)
       VALUES (@id, @name, @phone, @role, @employee_status, @email, @password_hash, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET())`,
      {
        id: uuidParam(id),
        name,
        phone: phone ?? null,
        role,
        employee_status: employeeStatus,
        email,
        password_hash: passwordHash,
      }
    )

    const profile: ProfileRow = { id, name, phone: phone ?? null, role, employee_status: employeeStatus, email }

    // Customers get a session immediately; employees stay pending until approved
    // (mirrors the old behaviour — but tokens are issued either way, route guards
    // enforce the pending gate).
    const tokens = issueTokens(profile)
    res.status(201).json({ user: publicUser(profile), ...tokens })
  }
)

router.post(
  '/login',
  authLimiter,
  [body('email').isEmail(), body('password').notEmpty()],
  async (req: Request, res: Response) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() })

    const { email, password } = req.body

    const profile = await queryOne<ProfileRow & { password_hash: string | null; active: boolean }>(
      'SELECT id, name, phone, role, employee_status, email, password_hash, active FROM dbo.profiles WHERE email = @email',
      { email }
    )

    if (!profile) return res.status(401).json({ error: 'Invalid email or password' })
    if (!profile.active) return res.status(403).json({ error: 'This account has been deactivated.' })
    if (!profile.password_hash) {
      // Migrated user whose password was never set (Supabase hashes were not
      // exportable). They must set a password via the reset flow.
      return res.status(403).json({ error: 'Password not set for this account. Please reset your password.', needsPasswordReset: true })
    }

    const ok = await verifyPassword(password, profile.password_hash)
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' })

    const tokens = issueTokens(profile)
    res.json({
      ...tokens,
      user: { id: profile.id, name: profile.name, role: profile.role, employee_status: profile.employee_status, phone: profile.phone, email: profile.email },
    })
  }
)

// Exchange a refresh token for a fresh access + refresh token pair.
router.post(
  '/refresh',
  authLimiter,
  [body('refreshToken').notEmpty()],
  async (req: Request, res: Response) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() })

    let userId: string
    try {
      userId = verifyRefreshToken(req.body.refreshToken).sub
    } catch {
      return res.status(401).json({ error: 'Could not refresh session' })
    }

    const profile = await queryOne<ProfileRow>(
      'SELECT id, name, phone, role, employee_status, email FROM dbo.profiles WHERE id = @id',
      { id: uuidParam(userId) }
    )
    if (!profile) return res.status(401).json({ error: 'Could not refresh session' })

    res.json(issueTokens(profile))
  }
)

// Stateless JWTs: logout is a client-side token discard. Kept for API parity.
router.post('/logout', authenticate, async (_req: AuthRequest, res: Response) => {
  res.json({ success: true })
})

router.get('/me', authenticate, async (req: AuthRequest, res: Response) => {
  const profile = await queryOne(
    'SELECT id, name, phone, role, employee_status, fcm_token, whatsapp, email, created_at, updated_at FROM dbo.profiles WHERE id = @id',
    { id: uuidParam(req.user!.id) }
  )
  res.json(profile)
})

router.patch('/me', authenticate, async (req: AuthRequest, res: Response) => {
  const { name, phone, whatsapp } = req.body
  const sets: string[] = []
  const params: Record<string, unknown> = { id: uuidParam(req.user!.id) }
  if (name) { sets.push('name = @name'); params.name = name }
  if (phone !== undefined) { sets.push('phone = @phone'); params.phone = phone }
  if (whatsapp !== undefined) { sets.push('whatsapp = @whatsapp'); params.whatsapp = whatsapp }
  sets.push('updated_at = SYSDATETIMEOFFSET()')

  const updated = await queryOne(
    `UPDATE dbo.profiles SET ${sets.join(', ')}
     OUTPUT inserted.id, inserted.name, inserted.phone, inserted.role, inserted.employee_status, inserted.fcm_token, inserted.whatsapp, inserted.email
     WHERE id = @id`,
    params
  )
  res.json(updated)
})

router.patch('/push-token', authenticate, async (req: AuthRequest, res: Response) => {
  const { fcmToken } = req.body
  if (!fcmToken) return res.status(400).json({ error: 'fcmToken required' })

  await query(
    'UPDATE dbo.profiles SET fcm_token = @t, updated_at = SYSDATETIMEOFFSET() WHERE id = @id',
    { t: fcmToken, id: uuidParam(req.user!.id) }
  )
  res.json({ success: true })
})

export default router
