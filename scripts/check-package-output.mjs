import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import asar from '@electron/asar'

const root = path.resolve('release')
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const archive = path.join(root, 'win-unpacked/resources/app.asar')
const files = asar.listPackage(archive).map(file => file.replaceAll('\\', '/'))
for (const entry of ['/dist/index.html', '/dist-electron/main.cjs', '/dist-electron/preload.cjs', '/dist-electron/storage/prompt-core.mjs', '/node_modules/sharp/lib/index.js']) {
  assert.ok(files.includes(entry), `Missing packaged file: ${entry}`)
}
assert.ok(!files.some(file => /^\/(src|electron|scripts|artifacts|\.verification|README)(\/|\.|$)/.test(file)), 'Development sources or fixtures entered the packaged app.')
const nativeModule = path.join(root, 'win-unpacked/resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node')
assert.ok((await stat(nativeModule)).size > 100_000, 'Sharp native module is missing from ASAR unpacked resources.')
const executable = path.join(root, 'win-unpacked/Frame Studio.exe')
const installer = path.join(root, `Frame-Studio-${pkg.version}-x64-Setup.exe`)
assert.ok((await stat(executable)).size > 100_000_000, 'Packaged Electron executable is incomplete.')
assert.ok((await stat(installer)).size > 50_000_000, 'Windows setup executable is incomplete.')
console.log(`PASS Windows installer and unpacked app: ${files.length} packaged entries, local assets and Sharp present, development fixtures excluded.`)
