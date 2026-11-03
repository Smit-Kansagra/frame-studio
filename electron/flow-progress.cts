import type { FlowActivity, FlowActivityUpdate, ProjectInfo } from './contracts.cjs'

export type FlowReporter = (update: FlowActivityUpdate) => void

export function recordActivity(items: FlowActivity[] = [], update: FlowActivityUpdate): FlowActivity[] {
  const previous = items.find(item => item.id === update.id)
  if (previous && previous.state === update.state && previous.detail === update.detail && previous.label === update.label) return items
  const next = { ...update, updatedAt: new Date().toISOString() }
  return previous ? items.map(item => item.id === update.id ? next : item) : [...items, next].slice(-150)
}

export function interruptActivity(items: FlowActivity[] = [], detail: string): FlowActivity[] {
  return items.map(item => item.state === 'running' ? { ...item, state: item.id === 'submit' ? 'uncertain' : 'error', detail, updatedAt: new Date().toISOString() } : item)
}

export function referenceLabels(project: ProjectInfo, ids: string[]): string[] {
  return ids.map((id, index) => {
    const roles: string[] = []
    const product = project.snapshot.product.photos.find(photo => photo.id === id)
    const theme = project.snapshot.theme.images.find(photo => photo.id === id)
    const character = project.snapshot.character?.photos.find(photo => photo.id === id)
    if (product) roles.push('Product')
    if (theme) roles.push('Theme')
    if (character) roles.push('Character')
    return `${roles.join(' / ') || 'Reference'} photo ${index + 1}: ${(product ?? theme ?? character)?.originalName ?? 'Saved reference'}`
  })
}

export function planPreparation(labels: string[], startFrame: boolean, report: FlowReporter) {
  report({ id: 'prompt-settings', label: 'Flow prompt and settings', state: 'pending', detail: 'Not yet confirmed in the selected Flow project.' })
  if (startFrame) report({ id: 'start-frame', label: 'Previous approved scene: start frame', state: 'pending', detail: 'Not attached yet.' })
  labels.forEach((label, index) => report({ id: `reference-${index}`, label, state: 'pending', detail: 'Not attached yet.' }))
  report({ id: 'verify', label: 'Final prompt and reference check', state: 'pending', detail: 'Waiting for preparation.' })
}
