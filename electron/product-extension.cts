import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Keep Chrome's unpacked-extension path stable across versioned app updates.
// Only these bundled extension assets can be updated; no user data is copied.
const assets = [
  'product-browser.js', 'product-page.js', 'popup.js', 'popup.html', 'popup.css',
  'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png',
  'icon.svg', 'README.md', 'manifest.json',
]

async function directory(folder: string) {
  await mkdir(folder, { recursive: true })
  const info = await lstat(folder)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Product Finder folder must be a regular directory.')
}

async function existing(file: string) {
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!info) return null
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) throw new Error('Product Finder asset is not a supported regular file.')
  return readFile(file)
}

export async function prepareProductExtension(profile: string, source: string): Promise<string> {
  const root = path.join(profile, 'browser-extensions')
  const destination = path.join(root, 'product-finder')
  await directory(root)
  await directory(destination)
  await directory(path.join(destination, 'icons'))
  const updates: { file: string; temporary: string; previous: Buffer | null; written: boolean }[] = []
  try {
    // Stage the entire bundle before replacing anything. Commit manifest last.
    for (const asset of assets) {
      const bytes = await readFile(path.join(source, asset))
      if (bytes.length > 1_000_000) throw new Error('Bundled Product Finder asset exceeds its size limit.')
      const file = path.join(destination, asset)
      const previous = await existing(file)
      if (previous?.equals(bytes)) continue
      const temporary = file + '.' + randomUUID() + '.update'
      updates.push({ file, temporary, previous, written: false })
      await writeFile(temporary, bytes, { flag: 'wx' })
    }
    for (const update of updates) {
      await rename(update.temporary, update.file)
      update.written = true
    }
    return destination
  } catch (error) {
    let restored = true
    for (const update of [...updates].reverse()) {
      if (!update.written) continue
      try {
        if (update.previous) {
          await writeFile(update.temporary, update.previous, { flag: 'wx' })
          await rename(update.temporary, update.file)
        } else await unlink(update.file)
      } catch { restored = false }
    }
    throw new Error(`Product Finder files could not be updated. ${restored ? 'Existing files were preserved.' : 'Restart the app to finish repairing its extension files before reloading Chrome.'} ${error instanceof Error ? error.message : 'Local file access failed.'}`)
  } finally {
    for (const update of updates) await unlink(update.temporary).catch(() => {})
  }
}
