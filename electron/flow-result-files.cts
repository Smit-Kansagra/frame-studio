import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { StorageError } from './storage/errors.cjs'

const formats = ['jpg','jpeg','png','webp','mp4','mov','webm']
const fail = (message: string): never => { throw new StorageError('INVALID_REQUEST', message) }
export class FlowResultFiles {
  private readonly key: string
  constructor(private readonly directory: string, url: string, resultId: string) {
    this.key = createHash('sha256').update(url).update('\0').update(resultId).digest('hex')
  }
  private async checkDirectory() {
    if (!path.isAbsolute(this.directory)) fail('The project result directory must be absolute.')
    const info = await lstat(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(this.directory)).toLowerCase() !== path.resolve(this.directory).toLowerCase()) fail('The project result directory is redirected. Nothing was imported.')
  }
  private async validFile(filename: string) {
    const info = await lstat(filename)
    if (!info.isFile() || info.isSymbolicLink() || info.size < 16 || info.size > 2_000_000_000 || (await realpath(filename)).toLowerCase() !== path.resolve(filename).toLowerCase()) fail('The saved project result is not a supported regular file.')
    return info
  }
  async existing(): Promise<string | undefined> {
    await this.checkDirectory()
    const matches: string[] = []
    for (const extension of formats) {
      const filename = path.join(this.directory, `flow-original-${this.key}.${extension}`)
      try { await this.validFile(filename); matches.push(filename) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    if (matches.length > 1) fail('Multiple saved originals exist for this Flow result. Existing files were preserved.')
    return matches[0]
  }
  async store(source: string): Promise<string> {
    await this.checkDirectory()
    const extension = path.extname(source).slice(1).toLowerCase()
    if (!formats.includes(extension)) fail('Unsupported Flow original file format.')
    const before = await this.validFile(source)
    const existing = await this.existing()
    if (existing) return existing
    const destination = path.join(this.directory, `flow-original-${this.key}.${extension}`)
    const partial = path.join(this.directory, `.flow-download-${randomUUID()}.partial`)
    try {
      // Usually the download and workspace share a disk: rename moves the bytes
      // without a second full copy. Cross-disk installs use an atomic copy first.
      try { await rename(source, partial) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error; await copyFile(source, partial, constants.COPYFILE_EXCL) }
      if ((await this.validFile(partial)).size !== before.size) fail('The original was not completely copied into this project.')
      await rename(partial, destination)
    } catch (error) {
      // If the move failed after taking ownership, restore the staging original.
      try { await lstat(source) } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') await rename(partial, source).catch(() => {}) }
      throw error
    }
    // The caller supplies only a completed, nonce-owned Chrome staging file.
    // Its project copy is complete before removing that temporary duplicate.
    await unlink(source).catch(() => {})
    return destination
  }
}
