import { randomUUID } from 'crypto'
import sharp from 'sharp'
import { BlobServiceClient } from '@azure/storage-blob'

// Image storage on Azure Blob. Configure with AZURE_STORAGE_CONNECTION_STRING.
// Until that is set, uploads fail with a clear, actionable error (the rest of
// the app builds and runs; only image upload is gated).
//
// Container names mirror the old Supabase bucket ids so existing image URLs and
// calling code stay unchanged.
const CONN = process.env.AZURE_STORAGE_CONNECTION_STRING

let blobService: BlobServiceClient | null = null
function getService(): BlobServiceClient {
  if (!CONN) {
    throw new Error(
      'Image storage is not configured. Set AZURE_STORAGE_CONNECTION_STRING in the backend .env to enable uploads.'
    )
  }
  if (!blobService) blobService = BlobServiceClient.fromConnectionString(CONN)
  return blobService
}

export async function uploadImage(
  buffer: Buffer,
  originalName: string,
  bucket: 'product-images' | 'category-images'
): Promise<string> {
  const stem = originalName.replace(/\s+/g, '-').replace(/\.[^.]+$/, '') || 'image'
  const filename = `${Date.now()}-${stem}-${randomUUID()}.webp`

  const pipeline = sharp(buffer)
  const optimized =
    bucket === 'product-images'
      ? await pipeline.resize(1200, 1600, { fit: 'cover', position: 'centre' }).webp({ quality: 85 }).toBuffer()
      : await pipeline.resize({ width: 1200, withoutEnlargement: true }).webp({ quality: 85 }).toBuffer()

  const container = getService().getContainerClient(bucket)
  // Public read access so image URLs work directly, mirroring the old buckets.
  await container.createIfNotExists({ access: 'blob' })
  const blob = container.getBlockBlobClient(filename)
  await blob.uploadData(optimized, { blobHTTPHeaders: { blobContentType: 'image/webp' } })

  return blob.url
}

export async function deleteImage(bucket: string, filename: string): Promise<void> {
  const container = getService().getContainerClient(bucket)
  await container.deleteBlob(filename).catch(() => {})
}
