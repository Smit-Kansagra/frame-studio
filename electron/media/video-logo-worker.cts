import { parentPort, workerData } from 'node:worker_threads'
import sharp from 'sharp'
import { busyBackgroundLogo, cleanGeminiLogo } from './gemini-logo.cjs'
import type { VideoLogoRegion } from './video-logo.cjs'

sharp.concurrency(1)
void (async () => {
  const frames = (workerData as { frames: string[] }).frames
  const matches: Array<{ left: number; top: number; size: number }> = []
  let width = 0, height = 0
  for (const frame of frames) {
    const cleaned = await cleanGeminiLogo(frame)
    width = cleaned.width; height = cleaned.height
    const region = cleaned.region ?? (await busyBackgroundLogo(cleaned.data, width, height))?.region
    if (region) matches.push(region)
  }
  // A stationary, known Gemini star must agree in two different sample frames.
  // A weak or unknown mark never causes an arbitrary corner to be blurred.
  const group = matches.map(anchor => matches.filter(region => Math.abs(region.left - anchor.left) <= 5 && Math.abs(region.top - anchor.top) <= 5 && Math.abs(region.size - anchor.size) <= 5)).sort((a, b) => b.length - a.length)[0]
  if (!group || group.length < 2) return undefined
  const left = Math.max(1, Math.min(...group.map(region => region.left)) - 3)
  const top = Math.max(1, Math.min(...group.map(region => region.top)) - 3)
  const right = Math.min(width - 2, Math.max(...group.map(region => region.left + region.size)) + 3)
  const bottom = Math.min(height - 2, Math.max(...group.map(region => region.top + region.size)) + 3)
  return { left, top, width: right - left, height: bottom - top } satisfies VideoLogoRegion
})().then(region => parentPort?.postMessage({ region })).catch((error: Error) => parentPort?.postMessage({ error: error.message })).finally(() => parentPort?.close())
