import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

// The SVGs are the editable sources; Chrome uses the bundled PNG variants.
for (const folder of ['extension', 'extension-product-finder']) {
  const source = await readFile(path.join(folder, 'icon.svg'))
  await mkdir(path.join(folder, 'icons'), { recursive: true })
  for (const size of [16, 32, 48, 128]) {
    const png = await sharp(source).resize(size, size).png().toBuffer()
    await writeFile(path.join(folder, 'icons', `icon-${size}.png`), png)
  }
  console.log(`Created Chrome icons for ${folder}.`)
}
