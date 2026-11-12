import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const version = pkg.devDependencies.electron
const localZip = path.resolve('.verification', `electron-v${version}-win32-x64.zip`)
const officialHashes = new Map([['45.0.0', 'ae53887a23bb640369c93dbd38c408a2af5c0deb86f2fa76c6c244cb444b7f47']])
const args = [path.resolve('node_modules/electron-builder/out/cli/cli.js'), '--win', 'nsis', '--x64', '--publish', 'never']
if (process.platform === 'win32') args.unshift('--require', path.resolve('scripts/retry-packaging-write.cjs'))
// Build-only handoffs use a versioned directory so an owner's open unpacked
// app cannot lock an executable that this build needs to rewrite.
if (process.argv.includes('--isolated-output')) args.push(`--config.directories.output=${path.resolve('release', pkg.version)}`)
if (officialHashes.has(version) && await stat(localZip).catch(() => null)) {
  const hash = createHash('sha256')
  for await (const data of createReadStream(localZip)) hash.update(data)
  if (hash.digest('hex') !== officialHashes.get(version)) throw new Error('The cached Electron ZIP checksum does not match the official release. Remove the bad cache file before packaging.')
  args.push(`--config.electronDist=${localZip}`)
  console.log(`Using checksum-verified local Electron ${version} archive.`)
}
const child = spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true })
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
if (code !== 0) process.exitCode = typeof code === 'number' ? code : 1
