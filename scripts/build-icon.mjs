import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import './build-extension-icons.mjs'

const mark = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
<rect width="256" height="256" rx="56" fill="#244c3c"/>
<rect x="50" y="47" width="119" height="137" rx="20" fill="#d8e0d3" stroke="#f8f6ee" stroke-width="8"/>
<rect x="87" y="80" width="119" height="137" rx="20" fill="#eeede7" stroke="#f8f6ee" stroke-width="8"/>
<path d="M112 117h56M112 117v60" fill="none" stroke="#244c3c" stroke-width="10" stroke-linecap="round"/>
</svg>`
const sizes = [16, 24, 32, 48, 64, 128, 256]
const images = await Promise.all(sizes.map(size => sharp(Buffer.from(mark)).resize(size, size).png().toBuffer()))
const header = Buffer.alloc(6 + sizes.length * 16)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
let offset = header.length
images.forEach((data, index) => {
  const size = sizes[index], entry = 6 + index * 16
  header.writeUInt8(size === 256 ? 0 : size, entry)
  header.writeUInt8(size === 256 ? 0 : size, entry + 1)
  header.writeUInt16LE(1, entry + 4)
  header.writeUInt16LE(32, entry + 6)
  header.writeUInt32LE(data.length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  offset += data.length
})
const destination = path.resolve('build/icon.ico')
await mkdir(path.dirname(destination), { recursive: true })
await writeFile(destination, Buffer.concat([header, ...images]))
console.log(`Created ${destination} with ${sizes.length} icon sizes.`)
