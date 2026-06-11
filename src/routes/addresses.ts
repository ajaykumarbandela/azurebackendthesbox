import { Router, Response } from 'express'
import { body, validationResult } from 'express-validator'
import { randomUUID } from 'crypto'
import { query, queryOne, uuidParam } from '../db'
import { authenticate, AuthRequest } from '../middleware/auth'

const router = Router()

router.use(authenticate)

router.get('/', async (req: AuthRequest, res: Response) => {
  const data = await query(
    'SELECT * FROM dbo.addresses WHERE user_id = @uid ORDER BY is_default DESC',
    { uid: uuidParam(req.user!.id) }
  )
  res.json({ data })
})

router.post(
  '/',
  [
    body('line1').trim().notEmpty(),
    body('city').trim().notEmpty(),
    body('state').trim().notEmpty(),
    body('pincode').trim().notEmpty(),
  ],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() })

    const { line1, line2, city, state, pincode, country = 'India', is_default = false } = req.body

    if (is_default) {
      await query('UPDATE dbo.addresses SET is_default = 0 WHERE user_id = @uid', { uid: uuidParam(req.user!.id) })
    }

    try {
      const data = await queryOne(
        `INSERT INTO dbo.addresses (id, user_id, line1, line2, city, state, pincode, country, is_default, created_at)
         OUTPUT inserted.*
         VALUES (@id, @uid, @line1, @line2, @city, @state, @pincode, @country, @is_default, SYSDATETIMEOFFSET())`,
        { id: uuidParam(randomUUID()), uid: uuidParam(req.user!.id), line1, line2: line2 ?? null, city, state, pincode, country, is_default: is_default ? 1 : 0 }
      )
      res.status(201).json(data)
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Create failed' })
    }
  }
)

router.patch('/:id', async (req: AuthRequest, res: Response) => {
  const { line1, line2, city, state, pincode, country, is_default } = req.body
  const sets: string[] = []
  const params: Record<string, unknown> = { id: uuidParam(req.params.id), uid: uuidParam(req.user!.id) }
  if (line1) { sets.push('line1 = @line1'); params.line1 = line1 }
  if (line2 !== undefined) { sets.push('line2 = @line2'); params.line2 = line2 }
  if (city) { sets.push('city = @city'); params.city = city }
  if (state) { sets.push('state = @state'); params.state = state }
  if (pincode) { sets.push('pincode = @pincode'); params.pincode = pincode }
  if (country) { sets.push('country = @country'); params.country = country }

  if (is_default) {
    await query('UPDATE dbo.addresses SET is_default = 0 WHERE user_id = @uid', { uid: uuidParam(req.user!.id) })
    sets.push('is_default = 1')
  }
  if (sets.length === 0) return res.status(400).json({ error: 'No updates provided' })

  try {
    const data = await queryOne(
      `UPDATE dbo.addresses SET ${sets.join(', ')} OUTPUT inserted.* WHERE id = @id AND user_id = @uid`,
      params
    )
    if (!data) return res.status(404).json({ error: 'Address not found' })
    res.json(data)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Update failed' })
  }
})

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  await query(
    'DELETE FROM dbo.addresses WHERE id = @id AND user_id = @uid',
    { id: uuidParam(req.params.id), uid: uuidParam(req.user!.id) }
  )
  res.json({ success: true })
})

export default router
