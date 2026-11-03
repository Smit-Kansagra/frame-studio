import { parentPort, workerData } from 'node:worker_threads'
import sharp from 'sharp'

const port = parentPort
async function run() {
  const buffer = Buffer.from(workerData.bytes as Uint8Array)
  const options = { limitInputPixels: workerData.maxPixels as number, failOn: 'warning' as const, sequentialRead: true }
  const metadata = await sharp(buffer, options).metadata()
  if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '')) return { ok: false, code: 'UNSUPPORTED_IMAGE', message: 'Choose a JPG, PNG, or WebP image.' }
  if ((metadata.pages ?? 1) !== 1) return { ok: false, code: 'UNSUPPORTED_IMAGE', message: 'Animated and multi-page images are not supported. Choose a single still image.' }
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  if (width < 1 || height < 1 || width * height > workerData.maxPixels) return { ok: false, code: 'IMAGE_TOO_LARGE', message: 'Choose an image with no more than 40 million pixels.' }
  const { data, info } = await sharp(buffer, options).rotate().resize(512, 512, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true })
  return { ok: true, format: metadata.format, width, height, orientation: metadata.orientation ?? 1, thumbnail: data, thumbnailWidth: info.width, thumbnailHeight: info.height }
}

void run().then(result => port?.postMessage(result)).catch((error: Error) => {
  const pixels = /pixel limit/i.test(error.message)
  port?.postMessage({ ok: false, code: pixels ? 'IMAGE_TOO_LARGE' : 'INVALID_IMAGE', message: pixels ? 'Choose an image with no more than 40 million pixels.' : 'This image is damaged or cannot be decoded. Try another JPG, PNG, or WebP file.' })
}).finally(() => port?.close())
