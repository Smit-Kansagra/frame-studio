export function isTrustedRendererUrl(value: string, devUrl?: string): boolean {
  try {
    const url = new URL(value)
    if (url.username || url.password || url.search) return false
    if (devUrl) return url.origin === devUrl && url.pathname === '/'
    return url.protocol === 'frame-studio:' && url.host === 'app' && url.pathname === '/index.html'
  } catch { return false }
}
