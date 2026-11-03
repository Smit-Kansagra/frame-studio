export const FLOW_HOME = 'https://labs.google/fx/tools/flow'

export function allowedFlowPage(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (url.hostname === 'flow.google.com' || (url.hostname === 'labs.google' && /^\/fx\/(?:[a-z-]+\/)?tools\/flow(?:\/|$)/i.test(url.pathname)))
  } catch { return false }
}

export function isFlowProject(value: string): boolean {
  if (!allowedFlowPage(value)) return false
  const url = new URL(value)
  return (url.hostname === 'flow.google.com'
    ? /^\/project\/[a-zA-Z0-9_-]+\/?$/
    : /^\/fx\/(?:[a-z-]+\/)?tools\/flow\/project\/[a-zA-Z0-9_-]+\/?$/i).test(url.pathname)
}
