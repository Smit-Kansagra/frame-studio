import { lstatSync } from 'node:fs'
import path from 'node:path'

/** Prefer the app's shipped tools without changing the user's PATH. */
export function mediaTool(name: 'ffmpeg' | 'ffprobe'): string {
  if (process.platform !== 'win32') return name
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const folders = [
    ...(resources ? [path.join(resources, 'media-tools')] : []),
    path.resolve(__dirname, '../../.verification/ffmpeg-9.0.2-essentials_build/bin'),
  ]
  for (const folder of folders) {
    const filename = path.join(folder, `${name}.exe`)
    try { const info = lstatSync(filename); if (info.isFile() && !info.isSymbolicLink()) return filename } catch { /* Try the next supported location. */ }
  }
  return name
}
