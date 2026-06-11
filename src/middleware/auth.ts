import { Request, Response, NextFunction } from 'express'
import { queryOne, uuidParam } from '../db'
import { verifyAccessToken } from '../auth/jwt'

export interface AuthRequest extends Request {
  user?: {
    id: string
    email: string
    role: string
    employeeStatus?: string
  }
}

export async function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'No token provided' })

  let claims
  try {
    claims = verifyAccessToken(token)
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }

  // Role/status are read fresh from the DB so an admin demotion or employee
  // approval takes effect on the next request without re-issuing the token.
  const profile = await queryOne<{ role: string; employee_status: string | null }>(
    'SELECT role, employee_status FROM dbo.profiles WHERE id = @id',
    { id: uuidParam(claims.sub) }
  )

  req.user = {
    id: claims.sub,
    email: claims.email,
    role: profile?.role ?? claims.role ?? 'customer',
    employeeStatus: profile?.employee_status ?? undefined,
  }
  next()
}

export function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    next()
  }
}

export function requireApprovedEmployee(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' })
  if (req.user.role === 'superadmin') return res.status(403).json({ error: 'Forbidden' })
  if (req.user.role === 'admin') return next()
  if (req.user.role === 'employee' && req.user.employeeStatus === 'approved') return next()
  return res.status(403).json({ error: 'Employee account pending approval' })
}

export function requireSuperAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Forbidden' })
  }
  next()
}
