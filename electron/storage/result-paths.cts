import { UUID_PATTERN } from './paths.cjs'

const extensions = '(?:jpe?g|png|webp|mp4|mov|webm)'
export function resultFolder(projectId: string, name: string): string {
  let safe = name.normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 60)
  if (!safe || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = `Project-${safe || 'untitled'}`
  return `Final Projects/${safe}--${projectId}`
}
export function validResultPath(projectId: string, attemptId: string, relative: string): boolean {
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(attemptId)) return false
  if (new RegExp(`^projects/attempts/${attemptId}\\.${extensions}$`).test(relative)) return true
  const parts = relative.split('/')
  return parts.length === 3 && parts[0] === 'Final Projects' && parts[1].endsWith(`--${projectId}`) &&
    !/[<>:"\\|?*\x00-\x1f]/.test(parts[1]) && new RegExp(`^${attemptId}\\.${extensions}$`).test(parts[2])
}
