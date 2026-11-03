import { parentPort, workerData } from 'node:worker_threads'
import sharp from 'sharp'
import type { ImageTransform } from '../contracts.cjs'

async function run() {
  const edit = workerData.edit as ImageTransform
  const options = { limitInputPixels: workerData.maxPixels as number, failOn: 'warning' as const }
  // Separate pipelines ensure EXIF orientation, quarter-turn, then crop occur in that order.
  const upright = await sharp(Buffer.from(workerData.bytes as Uint8Array), options).autoOrient().png().toBuffer()
  const rotated = await sharp(upright, options).rotate(edit.rotation).png().toBuffer({ resolveWithObject: true })
  const left = Math.min(rotated.info.width - 1, Math.floor(edit.crop.x * rotated.info.width))
  const top = Math.min(rotated.info.height - 1, Math.floor(edit.crop.y * rotated.info.height))
  const width = Math.max(1, Math.min(rotated.info.width - left, Math.round(edit.crop.width * rotated.info.width)))
  const height = Math.max(1, Math.min(rotated.info.height - top, Math.round(edit.crop.height * rotated.info.height)))
  const bytes = await sharp(rotated.data, options).extract({ left, top, width, height }).png().toBuffer()
  if (bytes.length > 20 * 1024 * 1024) throw new Error('Edited image exceeds import limit')
  return bytes
}
void run().then(bytes => parentPort?.postMessage({ ok: true, bytes })).catch(() => parentPort?.postMessage({ ok: false })).finally(() => parentPort?.close())
