import path from 'node:path'
import { lstat, open } from 'node:fs/promises'
import { StorageError } from './errors.cjs'

export async function readPromptFile(filename: string): Promise<{ name: string; text: string }> {
  const invalid = (message: string): never => { throw new StorageError('INVALID_PROMPT_FILE', message) }
  if (!path.isAbsolute(filename) || path.extname(filename).toLowerCase() !== '.txt') invalid('Choose a UTF-8 .txt prompt file.')
  try {
    const info = await lstat(filename)
    if (!info.isFile() || info.isSymbolicLink()) invalid('Choose a regular .txt file, not a folder or shortcut.')
    const file = await open(filename, 'r')
    try {
      const bytes = Buffer.alloc(80_001)
      let offset = 0
      while (offset < bytes.length) { const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) break; offset += bytesRead }
      if (offset > 80_000) invalid('Choose a prompt file no larger than 80 KB (20,000 text characters).')
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)) } catch { return invalid('This file is not valid UTF-8. Save it as UTF-8 text, then import again.') }
      if (!text.trim()) invalid('This prompt file is empty. Choose another file or type a master prompt.')
      if (text.length > 20000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) invalid('Use plain UTF-8 text with no binary control characters, up to 20,000 characters.')
      return { name: path.basename(filename), text: text.replace(/\r\n?/g, '\n') }
    } finally { await file.close() }
  } catch (error) { if (error instanceof StorageError) throw error; throw new StorageError('FILE_UNREADABLE', 'The prompt file could not be read. Check its location and permissions.') }
}
