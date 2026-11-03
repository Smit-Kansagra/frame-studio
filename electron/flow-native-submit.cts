import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { StorageError } from './storage/errors.cjs'
import { isFlowProject } from './flow-urls.cjs'

export function nativeFlowSubmit(script: string) {
  return async (projectUrl: string, title: string): Promise<void> => {
    if (process.platform !== 'win32' || !isFlowProject(projectUrl)) throw new StorageError('INVALID_REQUEST', 'Native Flow submission requires Windows and the paired Flow project.')
    const source = await readFile(script, 'utf8')
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    await new Promise<void>((resolve, reject) => {
      execFile(powershell, ['-NoProfile', '-NonInteractive', '-STA', '-Command', source], {
        windowsHide: true, timeout: 25000, maxBuffer: 32 * 1024,
        env: { ...process.env, FRAME_FLOW_PROJECT_URL: projectUrl, FRAME_FLOW_WINDOW_TITLE: title },
      }, (error, stdout) => {
        let result: {activated?: boolean, error?: string} = {}
        try { result = JSON.parse(stdout.trim()) } catch {}
        if (error || result.activated !== true) reject(new StorageError('INVALID_REQUEST', result.error || 'Windows could not activate the selected Chrome Flow button. Submission is uncertain; no second click was made.'))
        else resolve()
      })
    })
  }
}
