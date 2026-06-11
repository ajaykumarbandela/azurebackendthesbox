import jwt, { Secret, SignOptions } from 'jsonwebtoken'

// Self-hosted JWT replacing Supabase Auth tokens. Access tokens are short-lived;
// refresh tokens are long-lived and exchanged at /auth/refresh. Both are signed
// with their own secret so a leaked access token can't mint refresh tokens.
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || (ACCESS_SECRET ? ACCESS_SECRET + ':refresh' : undefined)
const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '1h'
const REFRESH_TTL = process.env.JWT_REFRESH_TTL || '30d'

if (!ACCESS_SECRET) {
  throw new Error('Missing JWT_ACCESS_SECRET (or JWT_SECRET) — required to sign auth tokens.')
}

export interface AccessClaims {
  sub: string // user id
  email: string
  role: string
}

const accessOpts: SignOptions = { expiresIn: ACCESS_TTL as SignOptions['expiresIn'] }
const refreshOpts: SignOptions = { expiresIn: REFRESH_TTL as SignOptions['expiresIn'] }

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, ACCESS_SECRET as Secret, accessOpts)
}

export function signRefreshToken(userId: string): string {
  return jwt.sign({ sub: userId, typ: 'refresh' }, REFRESH_SECRET as Secret, refreshOpts)
}

export function verifyAccessToken(token: string): AccessClaims {
  return jwt.verify(token, ACCESS_SECRET as Secret) as AccessClaims
}

export function verifyRefreshToken(token: string): { sub: string } {
  const decoded = jwt.verify(token, REFRESH_SECRET as Secret) as { sub: string; typ?: string }
  if (decoded.typ !== 'refresh') throw new Error('Not a refresh token')
  return decoded
}
