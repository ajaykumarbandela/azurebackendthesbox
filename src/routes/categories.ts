import { Router, Request, Response } from 'express'
import { body, validationResult } from 'express-validator'
import { randomUUID } from 'crypto'
import { query, queryOne, uuidParam } from '../db'
import { authenticate, requireApprovedEmployee } from '../middleware/auth'
import { uploadImage } from '../services/storageService'
import multer from 'multer'

const router = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

// List categories. ?topLevel=true → roots only; ?parentId=<id> → that parent's children.
router.get('/', async (req: Request, res: Response) => {
  let where = ''
  const params: Record<string, unknown> = {}
  if (req.query.parentId) { where = 'WHERE parent_id = @pid'; params.pid = uuidParam(req.query.parentId as string) }
  else if (req.query.topLevel === 'true') { where = 'WHERE parent_id IS NULL' }

  const data = await query(`SELECT * FROM dbo.categories ${where} ORDER BY name`, params)
  res.json(data)
})

router.get('/:slug', async (req: Request, res: Response) => {
  const data = await queryOne('SELECT * FROM dbo.categories WHERE slug = @slug', { slug: req.params.slug })
  if (!data) return res.status(404).json({ error: 'Category not found' })
  res.json(data)
})

router.post(
  '/',
  authenticate,
  requireApprovedEmployee,
  upload.single('image'),
  [body('name').trim().notEmpty()],
  async (req: Request, res: Response) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() })

    const { name, description, parent_id } = req.body
    const slug = req.body.slug?.trim() || slugify(name)

    let image_url: string | null = req.body.image_url || null
    try {
      if (req.file) image_url = await uploadImage(req.file.buffer, req.file.originalname, 'category-images')
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : 'Image upload failed' })
    }

    try {
      const data = await queryOne(
        `INSERT INTO dbo.categories (id, name, slug, description, image_url, parent_id, created_at)
         OUTPUT inserted.*
         VALUES (@id, @name, @slug, @description, @image_url, @parent_id, SYSDATETIMEOFFSET())`,
        { id: uuidParam(randomUUID()), name, slug, description: description ?? null, image_url, parent_id: uuidParam(parent_id || null) }
      )
      res.status(201).json(data)
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Create failed' })
    }
  }
)

router.patch(
  '/:id',
  authenticate,
  requireApprovedEmployee,
  upload.single('image'),
  async (req: Request, res: Response) => {
    const { name, slug, description, parent_id } = req.body
    const sets: string[] = []
    const params: Record<string, unknown> = { id: uuidParam(req.params.id) }
    if (name) { sets.push('name = @name'); params.name = name }
    if (slug) { sets.push('slug = @slug'); params.slug = slug }
    if (description !== undefined) { sets.push('description = @description'); params.description = description }

    if (parent_id !== undefined) {
      if (parent_id === req.params.id) return res.status(400).json({ error: 'A category cannot be its own parent' })
      sets.push('parent_id = @parent_id'); params.parent_id = uuidParam(parent_id || null)
    }

    try {
      if (req.file) { sets.push('image_url = @image_url'); params.image_url = await uploadImage(req.file.buffer, req.file.originalname, 'category-images') }
      else if (req.body.image_url !== undefined) { sets.push('image_url = @image_url'); params.image_url = req.body.image_url || null }
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : 'Image upload failed' })
    }

    if (sets.length === 0) return res.status(400).json({ error: 'No updates provided' })

    try {
      const data = await queryOne(`UPDATE dbo.categories SET ${sets.join(', ')} OUTPUT inserted.* WHERE id = @id`, params)
      if (!data) return res.status(404).json({ error: 'Category not found' })
      res.json(data)
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Update failed' })
    }
  }
)

router.delete('/:id', authenticate, requireApprovedEmployee, async (req: Request, res: Response) => {
  try {
    await query('DELETE FROM dbo.categories WHERE id = @id', { id: uuidParam(req.params.id) })
    res.json({ success: true })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Delete failed' })
  }
})

export default router
