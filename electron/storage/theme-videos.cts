import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, open, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ThemeVideo } from '../contracts.cjs'
import { ManagedPaths, UUID_PATTERN } from './paths.cjs'
import { StorageError } from './errors.cjs'

const types = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' } as const
type Extension = keyof typeof types
type Record = { originalName: string; byteSize: number; extension: Extension }
const invalid = (message: string): never => { throw new StorageError('INVALID_THEME', message) }

export class ThemeVideos {
  constructor(private readonly paths: ManagedPaths) {}

  async import(source: string): Promise<ThemeVideo> {
    const extension = path.extname(source).toLowerCase() as Extension
    if (!Object.hasOwn(types, extension)) invalid('Choose an MP4, MOV or WebM reference video.')
    const info = await lstat(source)
    if (!info.isFile() || info.isSymbolicLink() || info.size < 16 || info.size > 2_000_000_000) invalid('Choose a regular local video under 2 GB.')
    const file = await open(source, 'r'), header = Buffer.alloc(16)
    try { await file.read(header, 0, header.length, 0) } finally { await file.close() }
    const valid = extension === '.webm' ? header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) : header.toString('ascii', 4, 8) === 'ftyp'
    if (!valid) invalid('The selected file does not match a supported video container.')
    const id = randomUUID(), folder = `library/theme-videos/${id}`
    await this.paths.directory(folder)
    await copyFile(source, this.paths.resolve(`${folder}/original${extension}`), constants.COPYFILE_EXCL)
    const record: Record = { originalName: path.basename(source), byteSize: info.size, extension }
    await writeFile(this.paths.resolve(`${folder}/info.json`), JSON.stringify(record), { flag: 'wx' })
    return this.get(id)
  }

  private async record(id: string): Promise<Record> {
    if (!UUID_PATTERN.test(id)) invalid('Choose a valid reference video.')
    const record = JSON.parse(await readFile(await this.paths.regularFile(`library/theme-videos/${id}/info.json`), 'utf8')) as Record
    if (!Object.hasOwn(types, record.extension) || typeof record.originalName !== 'string' || !Number.isSafeInteger(record.byteSize) || record.byteSize < 16) invalid('The reference video record is invalid.')
    return record
  }

  async file(id: string) {
    const record = await this.record(id)
    return { path: await this.paths.regularFile(`library/theme-videos/${id}/original${record.extension}`), mediaType: types[record.extension] }
  }

  async get(id: string): Promise<ThemeVideo> {
    const record = await this.record(id)
    const available = await this.file(id).then(async file => (await lstat(file.path)).size === record.byteSize).catch(() => false)
    return { id, originalName: record.originalName, byteSize: record.byteSize, originalUrl: `frame-media://theme-video/${id}`, available }
  }
}
