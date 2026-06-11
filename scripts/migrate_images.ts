// Copy product/category image files from Supabase Storage URLs into Azure Blob,
// then rewrite the DB URLs to the new Blob URLs. Idempotent: rows already on
// the Azure Blob host are skipped.
import 'dotenv/config'
import { BlobServiceClient } from '@azure/storage-blob'
import { query, uuidParam } from '../src/db'

const svc = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING!)

async function ensureContainer(name: string) {
  const c = svc.getContainerClient(name)
  await c.createIfNotExists({ access: 'blob' })
  return c
}

// Derive a stable blob name from the original Supabase URL's filename.
function blobNameFromUrl(url: string): string {
  const clean = url.split('?')[0]
  return clean.substring(clean.lastIndexOf('/') + 1) || `img-${Date.now()}`
}

async function uploadFromUrl(container: ReturnType<typeof svc.getContainerClient>, url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const contentType = res.headers.get('content-type') || 'image/webp'
  const name = blobNameFromUrl(url)
  const blob = container.getBlockBlobClient(name)
  await blob.uploadData(buf, { blobHTTPHeaders: { blobContentType: contentType } })
  return blob.url
}

;(async () => {
  const productContainer = await ensureContainer('product-images')
  const categoryContainer = await ensureContainer('category-images')

  // ---- product_images ----
  const pImgs = await query<{ id: string; url: string }>(
    "SELECT id, url FROM dbo.product_images WHERE url LIKE '%supabase%'"
  )
  console.log(`product_images to migrate: ${pImgs.length}`)
  let pOk = 0
  for (const row of pImgs) {
    try {
      const newUrl = await uploadFromUrl(productContainer, row.url)
      await query('UPDATE dbo.product_images SET url = @u WHERE id = @id', { u: newUrl, id: uuidParam(row.id) })
      pOk++
      process.stdout.write('.')
    } catch (e) {
      console.error(`\n  FAILED ${row.id}: ${(e as Error).message}`)
    }
  }
  console.log(`\n  migrated ${pOk}/${pImgs.length} product images`)

  // ---- categories.image_url ----
  const cImgs = await query<{ id: string; image_url: string }>(
    "SELECT id, image_url FROM dbo.categories WHERE image_url LIKE '%supabase%'"
  )
  console.log(`category images to migrate: ${cImgs.length}`)
  let cOk = 0
  for (const row of cImgs) {
    try {
      const newUrl = await uploadFromUrl(categoryContainer, row.image_url)
      await query('UPDATE dbo.categories SET image_url = @u WHERE id = @id', { u: newUrl, id: uuidParam(row.id) })
      cOk++
    } catch (e) {
      console.error(`  FAILED ${row.id}: ${(e as Error).message}`)
    }
  }
  console.log(`  migrated ${cOk}/${cImgs.length} category images`)

  // ---- verify ----
  const remP = await query<{ c: number }>("SELECT COUNT(*) c FROM dbo.product_images WHERE url LIKE '%supabase%'")
  const remC = await query<{ c: number }>("SELECT COUNT(*) c FROM dbo.categories WHERE image_url LIKE '%supabase%'")
  console.log(`\nremaining supabase refs -> product_images: ${remP[0].c}, categories: ${remC[0].c}`)
  process.exit(0)
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })
