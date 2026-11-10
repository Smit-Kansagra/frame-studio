// Runs only in an explicitly permitted retailer tab, in Chrome's isolated world.
// Reads rendered listing facts; never reads cookies, storage, account data or private APIs.
export function readProductPage(mode) {
  const text = (document.body?.innerText ?? '').slice(0, 16000)
  const title = document.title.slice(0, 500)
  const blocked = /access denied|request blocked|verify (?:that )?you are (?:a )?human|robot check|unusual traffic|captcha|sign in to continue|login to continue/i.exec(title + '\n' + text.slice(0, 5000))
  if (blocked) return { url: location.href, blocked: 'Retailer page requires attention: ' + blocked[0] }
  const links = [...(document.querySelector('main') ?? document).querySelectorAll('a[href]')].map(a => a.href).filter(url => {
    try { const u = new URL(url); return u.origin === location.origin && (/\/\d+\/buy\/?$/.test(u.pathname) || /\/p\//.test(u.pathname) || /\/(?:dp|gp\/product)\/[A-Z0-9]{10}(?:\/|$)/i.test(u.pathname)) } catch { return false }
  })
  const schemas = []
  let remaining = 180000
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    if (script.textContent.length > remaining) continue
    try { schemas.push(JSON.parse(script.textContent)); remaining -= script.textContent.length } catch { /* Other valid structured blocks remain usable. */ }
  }
  const canonical = document.querySelector('link[rel="canonical"]')?.href ?? ''
  const value = selector => document.querySelector(selector)?.textContent?.trim().slice(0, 500) ?? ''
  const attributes = Object.fromEntries([...document.querySelectorAll('.index-row')].slice(0, 30).flatMap(row => {
    const key = row.querySelector('.index-rowKey')?.textContent?.trim(), value = row.querySelector('.index-rowValue')?.textContent?.trim()
    return key && value && key.length < 100 && value.length < 200 ? [[key, value]] : []
  }))
  // Public specification tables only. Do not collect delivery/account fields.
  const tableAttributes = Object.fromEntries([...(document.querySelector('main') ?? document).querySelectorAll('tr')].slice(0, 180).flatMap(row => {
    const cells = [...row.querySelectorAll(':scope > td, :scope > th')]
    if (cells.length !== 2) return []
    const key = cells[0].innerText?.trim(), value = cells[1].innerText?.trim()
    return /^(?:Length Type|Length|Type|Ideal For|Gender|Color|Colour|Pattern|Style Code|Sleeve Length|Shape)$/i.test(key ?? '') && value && value.length < 200 ? [[key, value]] : []
  }))
  // Myntra has one style/colour identity per /<style-id>/buy listing. Do not read
  // recommendation images or assign a colour from visual similarity.
  const myntra = location.hostname === 'www.myntra.com' && /\/\d+\/buy\/?$/.test(location.pathname) ? {
    brand: value('h1.pdp-title'), name: value('h1.pdp-name'), price: value('.pdp-price strong') || value('.pdp-price'),
    code: value('.pdp-product-code'),
    images: [...document.querySelectorAll('.image-grid-container .image-grid-image')].slice(0, 4).flatMap(image => {
      const match = getComputedStyle(image).backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)
      return match ? [match[1]] : []
    }),
    attributes, outOfStock: !!document.querySelector('.pdp-out-of-stock')?.getClientRects().length
  } : null
  return { url: location.href, title, canonical, schemas, myntra, attributes: tableAttributes, links: [...new Set(links)].slice(0, 100), mode }
}
