import path from 'node:path'
import { lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { StorageError } from './errors.cjs'

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const FOLDERS = ['library/originals', 'library/edits', 'library/thumbnails', 'projects/snapshots', 'projects/attempts', 'temp/imports', 'trash'] as const

export function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export class ManagedPaths {
  private constructor(readonly root: string) {}

  static async create(folder: string): Promise<ManagedPaths> {
    await mkdir(folder, { recursive: true })
    if ((await lstat(folder)).isSymbolicLink()) throw new StorageError('STORAGE_UNAVAILABLE', 'The workspace folder must be a regular local folder, not a link.')
    const paths = new ManagedPaths(await realpath(folder))
    for (const relative of FOLDERS) await paths.directory(relative)
    return paths
  }

  resolve(relative: string): string {
    if (!relative || relative.includes('\\') || relative.includes(':') || relative.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new StorageError('INVALID_REQUEST', 'The managed media path is invalid.')
    }
    const resolved = path.resolve(this.root, relative)
    if (!inside(this.root, resolved)) throw new StorageError('INVALID_REQUEST', 'The file is outside this workspace.')
    return resolved
  }

  async directory(relative: string): Promise<string> {
    const parts = relative.split('/')
    for (let index = 1; index <= parts.length; index++) {
      const target = this.resolve(parts.slice(0, index).join('/'))
      await mkdir(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
      const stat = await lstat(target)
      if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(this.root, await realpath(target))) {
        throw new StorageError('STORAGE_UNAVAILABLE', 'A managed storage folder is unavailable or has been replaced with a link.')
      }
    }
    return this.resolve(relative)
  }

  async regularFile(relative: string): Promise<string> {
    const target = this.resolve(relative)
    const stat = await lstat(target)
    if (!stat.isFile() || stat.isSymbolicLink() || !inside(this.root, await realpath(target))) {
      throw new StorageError('FILE_UNREADABLE', 'This managed file is unavailable or has been replaced with a link.')
    }
    return target
  }

  async removeImportStage(id: string): Promise<void> {
    if (!UUID_PATTERN.test(id)) throw new StorageError('INVALID_REQUEST', 'The import identifier is invalid.')
    const relative = `temp/imports/${id}`
    const target = this.resolve(relative)
    const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!stat) return
    if (stat.isSymbolicLink() || !stat.isDirectory() || !inside(this.root, await realpath(target))) {
      throw new StorageError('STORAGE_UNAVAILABLE', 'An interrupted import needs attention. Its folder was preserved.')
    }
    // UUID stage folders contain only this application's disposable import copies.
    await rm(target, { recursive: true })
  }
  async removeFlowStage(id: string): Promise<void> {
    if (!UUID_PATTERN.test(id)) throw new StorageError('INVALID_REQUEST', 'Invalid Flow stage identifier.')
    const target = this.resolve(`temp/flow/${id}`)
    const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!stat) return
    const resolved = await realpath(target)
    if (stat.isSymbolicLink() || !stat.isDirectory() || !inside(this.root, resolved) || path.relative(this.root, resolved).replaceAll('\\', '/') !== `temp/flow/${id}`) throw new StorageError('STORAGE_UNAVAILABLE', 'The Flow stage path is redirected; it was preserved.')
    await rm(target, { recursive: true })
  }
}
