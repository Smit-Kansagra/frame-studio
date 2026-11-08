import type { FoundProduct } from './contracts.cjs'
export function publicHttps(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Expected an HTTPS URL.')
  const url = new URL(value)
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !host.includes('.') ||
      host.includes(':') || /^[\d.]+$/.test(host) || /(^|\.)(localhost|local|internal|test|invalid)$/.test(host)) {
    throw new Error('Use a public HTTPS product or image URL.')
  }
  url.hash = ''
  return url.href
}

export function parseProducts(text: string): FoundProduct[] {
  const rows: unknown = JSON.parse(text)
  if (!Array.isArray(rows) || rows.length > 500) throw new Error('Results must be a JSON array with at most 500 products.')
  const unique = new Map<string, FoundProduct>()
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== 'object') throw new Error(`Invalid product at row ${index + 1}.`)
    try {
      const product_url = publicHttps(row.product_url)
      const image_url = publicHttps(row.image_url)
      unique.set(product_url, { product_url, image_url })
    } catch { throw new Error(`Row ${index + 1}: both product_url and image_url must be public HTTPS URLs.`) }
  }
  return [...unique.values()]
}

