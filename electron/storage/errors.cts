import type { AppResult, ErrorCode } from '../contracts.cjs'

export class StorageError extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(message); this.name = 'StorageError' }
}

export class FlowNotSubmittedError extends StorageError {
  constructor(message:string){super('INVALID_REQUEST',message);this.name='FlowNotSubmittedError'}
}

export function failure(error: unknown, fallback: ErrorCode = 'STORAGE_UNAVAILABLE'): AppResult<never> {
  if (error instanceof StorageError) return { ok: false, error: { code: error.code, message: error.message } }
  const messages: Partial<Record<ErrorCode, string>> = {
    IMPORT_FAILED: 'The image could not be saved. Check free disk space and permission to write to the workspace, then try again.',
    STORAGE_UNAVAILABLE: 'Local storage could not be opened. Check free disk space and permission to write to the application-data folder, then retry.',
  }
  return { ok: false, error: { code: fallback, message: messages[fallback] ?? 'This operation could not be completed. Please try again.' } }
}
