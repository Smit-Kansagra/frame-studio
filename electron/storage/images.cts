import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { open, lstat } from 'node:fs/promises'
import type { ErrorCode, ImageFormat, ImageTransform } from '../contracts.cjs'
import { StorageError } from './errors.cjs'

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_IMAGE_PIXELS = 40_000_000
export type DecodedImage = { format: ImageFormat; width: number; height: number; orientation: number; thumbnail: Uint8Array; thumbnailWidth: number; thumbnailHeight: number }

export function validateImageTransform(value: unknown): ImageTransform {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StorageError('INVALID_REQUEST', 'The image edit is invalid.')
  const edit = value as Record<string, unknown>
  const crop = edit.crop as Record<string, unknown> | undefined
  if (Object.keys(edit).some(key => !['rotation', 'crop'].includes(key)) || ![0, 90, 180, 270].includes(edit.rotation as number) || !crop || typeof crop !== 'object' || Array.isArray(crop) || Object.keys(crop).some(key => !['x', 'y', 'width', 'height'].includes(key)) || ['x', 'y', 'width', 'height'].some(key => typeof crop[key] !== 'number' || !Number.isFinite(crop[key]))) throw new StorageError('INVALID_REQUEST', 'Choose a quarter-turn rotation and a valid crop rectangle.')
  const { x, y, width, height } = crop as ImageTransform['crop']
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.00000001 || y + height > 1.00000001) throw new StorageError('INVALID_REQUEST', 'The crop must fit within the rotated image.')
  return { rotation: edit.rotation as ImageTransform['rotation'], crop: { x, y, width, height } }
}

export function transformImage(bytes: Buffer, edit: ImageTransform): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let received = false
    const worker = new Worker(path.join(__dirname, 'transform-worker.cjs'), { workerData: { bytes, edit, maxPixels: MAX_IMAGE_PIXELS }, resourceLimits: { maxOldGenerationSizeMb: 128 } })
    const timer = setTimeout(() => { void worker.terminate(); reject(new StorageError('IMAGE_PROCESSING_FAILED', 'The image edit took too long. Try a smaller image.')) }, 30_000)
    worker.once('message', (result: { ok: boolean; bytes?: Uint8Array }) => { received = true; clearTimeout(timer); if (result.ok && result.bytes) resolve(Buffer.from(result.bytes)); else reject(new StorageError('IMAGE_PROCESSING_FAILED', 'This image could not be edited. Check the crop or replace the image.')) })
    worker.once('error', () => { clearTimeout(timer); reject(new StorageError('IMAGE_PROCESSING_FAILED', 'Image editing tools could not start. Reinstall dependencies and retry.')) })
    worker.once('exit', code => { clearTimeout(timer); if (!received || code !== 0) reject(new StorageError('IMAGE_PROCESSING_FAILED', 'Image editing stopped unexpectedly. Try again.')) })
  })
}

function signature(buffer: Buffer): ImageFormat | undefined {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png'
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'jpeg'
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp'
}

export async function readImageSource(filename: string): Promise<Buffer> {
  if (!path.isAbsolute(filename) || filename.includes('\0')) throw new StorageError('INVALID_REQUEST', 'Choose an image using the file picker.')
  try {
    const stat = await lstat(filename)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new StorageError('FILE_UNREADABLE', 'Choose a regular image file, not a folder or shortcut.')
    const file = await open(filename, 'r')
    try {
      const info = await file.stat()
      if (!info.isFile()) throw new StorageError('FILE_UNREADABLE', 'Choose a regular image file.')
      if (info.size > MAX_IMAGE_BYTES) throw new StorageError('IMAGE_TOO_LARGE', 'Choose an image smaller than or equal to 20 MB.')
      const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_IMAGE_BYTES + 1))
      let offset = 0
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      // One additional byte detects files growing after the initial stat.
      if (offset > info.size || offset > MAX_IMAGE_BYTES) throw new StorageError('IMAGE_TOO_LARGE', 'This file changed while being read. Choose it again after it finishes saving.')
      const bytes = buffer.subarray(0, offset)
      const format = signature(bytes)
      if (!format) throw new StorageError('UNSUPPORTED_IMAGE', 'The file contents are not a JPG, PNG, or WebP image. Renaming a file does not change its format.')
      // Sharp reads APNG as a single PNG frame, so inspect its animation marker.
      if (format === 'png') {
        let chunk = 8
        while (chunk + 12 <= bytes.length) {
          const length = bytes.readUInt32BE(chunk)
          if (length > bytes.length - chunk - 12) break
          if (bytes.toString('ascii', chunk + 4, chunk + 8) === 'acTL') throw new StorageError('UNSUPPORTED_IMAGE', 'Animated PNG images are not supported. Choose a single still image.')
          chunk += length + 12
        }
      }
      return bytes
    } finally { await file.close() }
  } catch (error) {
    if (error instanceof StorageError) throw error
    throw new StorageError('FILE_UNREADABLE', 'The image could not be read. Check that it still exists and that you have permission to open it.')
  }
}

export function decodeImage(bytes: Buffer): Promise<DecodedImage> {
  return new Promise((resolve, reject) => {
    let received = false
    const worker = new Worker(path.join(__dirname, 'image-worker.cjs'), { workerData: { bytes, maxPixels: MAX_IMAGE_PIXELS }, resourceLimits: { maxOldGenerationSizeMb: 128 } })
    const timer = setTimeout(() => { void worker.terminate(); reject(new StorageError('IMAGE_PROCESSING_FAILED', 'The image took too long to process. Try a smaller image.')) }, 30_000)
    worker.once('message', (result: DecodedImage & { ok: boolean; code: ErrorCode; message: string }) => {
      received = true
      clearTimeout(timer)
      if (!result.ok) reject(new StorageError(result.code, result.message))
      else if (result.format !== signature(bytes)) reject(new StorageError('INVALID_IMAGE', 'The image contents do not match its detected format.'))
      else resolve(result)
    })
    worker.once('error', () => { clearTimeout(timer); reject(new StorageError('IMAGE_PROCESSING_FAILED', 'Image tools could not start. Reinstall the application dependencies, then retry.')) })
    worker.once('exit', code => { clearTimeout(timer); if (!received || code !== 0) reject(new StorageError('IMAGE_PROCESSING_FAILED', 'Image processing stopped unexpectedly. Try another image.')) })
  })
}
