import { Response } from 'express'
import { query, queryOne, uuidParam } from '../db'
import { AuthRequest } from '../middleware/auth'
import { notifyEmployeeApproval } from '../services/notificationService'

export async function getEmployees(req: AuthRequest, res: Response) {
  const { status, page = '1', limit = '20' } = req.query

  const offset = (+page - 1) * +limit
  const params: Record<string, unknown> = { limit: +limit, offset }
  let where = "WHERE role = 'employee'"
  if (status) { where += ' AND employee_status = @status'; params.status = status }

  const data = await query(
    `SELECT id, name, phone, employee_status, email, active, created_at, updated_at
     FROM dbo.profiles ${where}
     ORDER BY created_at DESC
     OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
    params
  )
  const countRow = await queryOne<{ total: number }>(
    `SELECT COUNT(*) AS total FROM dbo.profiles ${where}`,
    params
  )

  res.json({ data, count: countRow?.total ?? 0, page: +page, limit: +limit })
}

export async function approveOrRejectEmployee(req: AuthRequest, res: Response) {
  const { action } = req.body
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'action must be "approve" or "reject"' })
  }

  const status = action === 'approve' ? 'approved' : 'rejected'

  const data = await queryOne(
    `UPDATE dbo.profiles SET employee_status = @status, updated_at = SYSDATETIMEOFFSET()
     OUTPUT inserted.*
     WHERE id = @id AND role = 'employee'`,
    { status, id: uuidParam(req.params.id) }
  )
  if (!data) return res.status(400).json({ error: 'Employee not found' })

  notifyEmployeeApproval(req.params.id, action === 'approve')
  res.json(data)
}

export async function removeEmployee(req: AuthRequest, res: Response) {
  await query(
    `UPDATE dbo.profiles SET role = 'customer', employee_status = NULL, updated_at = SYSDATETIMEOFFSET()
     WHERE id = @id`,
    { id: uuidParam(req.params.id) }
  )
  res.json({ success: true })
}
