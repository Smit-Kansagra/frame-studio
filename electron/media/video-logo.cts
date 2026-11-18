import { Worker } from 'node:worker_threads'
import path from 'node:path'

export type VideoLogoRegion = { left: number; top: number; width: number; height: number }

/** Keep the bounded image-pattern search off the desktop main thread. */
export function findVideoLogo(frames: string[]): Promise<VideoLogoRegion | undefined> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'video-logo-worker.cjs'), { workerData: { frames }, resourceLimits: { maxOldGenerationSizeMb: 192 } })
    let settled = false
    const finish = (error?: Error, region?: VideoLogoRegion) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      void worker.terminate().catch(() => {}).then(() => error ? reject(error) : resolve(region))
    }
    const timer = setTimeout(() => finish(new Error('Video logo detection timed out. The original download is preserved.')), 120_000)
    worker.on('message', (value: { region?: VideoLogoRegion; error?: string }) => finish(value.error ? new Error(value.error) : undefined, value.region))
    worker.once('error', error => finish(error instanceof Error ? error : new Error('The video logo worker could not finish.')))
    worker.once('exit', () => { if (!settled) finish(new Error('Video logo detection was interrupted. The original download is preserved.')) })
  })
}
