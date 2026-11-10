import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const config = pkg.build
assert.equal(config.appId, 'local.frame-studio')
assert.equal(config.productName, 'Frame Studio')
assert.equal(config.allowMissingDependencies, false)
assert.deepEqual(config.files.filter(value => !value.startsWith('!')), ['dist/**/*', 'dist-electron/**/*', 'package.json', 'third-party/**/*', 'node_modules/**/*'])
assert.equal(config.nsis.deleteAppDataOnUninstall, false)
assert.equal(config.nsis.perMachine, false)
assert.ok(config.asarUnpack.includes('node_modules/sharp/**'))
assert.ok(config.asarUnpack.includes('node_modules/@img/**'))
assert.ok(config.asarUnpack.includes('node_modules/onnxruntime-node/**'))
assert.deepEqual(config.extraResources, [
  { from: 'extension', to: 'flow-companion', filter: ['*.json', '*.js', '*.html', '*.css', 'icons/*.png', 'icon.svg', 'README.md'] },
  { from: 'extension-product-finder', to: 'product-finder', filter: ['*.json', '*.js', '*.html', '*.css', 'icons/*.png', 'icon.svg', 'README.md'] },
  { from: 'electron/flow-native-submit.ps1', to: 'flow-native-submit.ps1' },
])
assert.ok(!config.extraFiles)
const icon = await readFile(path.join(root, 'build/icon.ico'))
assert.equal(icon.readUInt16LE(2), 1)
assert.ok(icon.readUInt16LE(4) >= 4)

if (!process.argv.includes('--config-only')) {
  for (const relative of [
    'dist/index.html', 'dist-electron/main.cjs', 'dist-electron/preload.cjs',
    'dist-electron/storage/image-worker.cjs', 'dist-electron/storage/transform-worker.cjs',
    'node_modules/sharp/package.json', 'node_modules/@img',
  ]) await access(path.join(root, relative))
  const html = await readFile(path.join(root, 'dist/index.html'), 'utf8')
  assert.match(html, /assets\/[^"']+\.js/)
  assert.doesNotMatch(html, /https?:\/\//)
}
console.log(process.argv.includes('--config-only') ? 'Installer configuration and icon are ready.' : 'Installer inputs are ready; development fixtures are excluded by the file list.')
