import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { publicHttps } from './product-find-data.cjs'
// Reject private and reserved addresses before every external fetch, including redirects.
export async function publicTarget(raw:string) {
  const url = new URL(publicHttps(raw))
  if (isIP(url.hostname)) throw new Error('Literal IP addresses are not allowed.')
  const addresses = await lookup(url.hostname,{all:true})
  if (!addresses.length || addresses.some(({address:a}) => (a.includes(':') && (/^(::|fc|fd|fe[89ab]|ff)/i.test(a) || a.includes('.'))) || /^(0|10|127|169|192|22[4-9]|2[3-5]\d)\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a))) throw new Error('Private or unsupported network target.')
  return url.href
}
export async function bytes(url:string, signal:AbortSignal, limit=3_000_000):Promise<{data:Buffer;type:string}> {
  for(let n=0;n<5;n++) {
    const response = await fetch(await publicTarget(url),{redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])})
    if(response.status>=300 && response.status<400) { const next=response.headers.get('location');if(!next)throw new Error('Missing redirect.');url=new URL(next,url).href;continue }
    if(!response.ok)throw new Error(`Source returned HTTP ${response.status}.`)
    if(Number(response.headers.get('content-length'))>limit)throw new Error('Source is too large.')
    const reader=response.body!.getReader();const chunks:Uint8Array[]=[];let size=0
    try { while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>limit)throw new Error('Source is too large.');chunks.push(part.value)} } finally {await reader.cancel()}
    return {data:Buffer.concat(chunks),type:response.headers.get('content-type')??''}
  }
  throw new Error('Too many redirects.')
}
