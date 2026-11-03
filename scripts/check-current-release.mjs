import assert from 'node:assert/strict'
import {readFile,stat} from 'node:fs/promises'
import path from 'node:path'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url),asar=require('@electron/asar')
const version=JSON.parse(await readFile('package.json','utf8')).version
const root=path.resolve('release',version)
const resources=path.join(root,'win-unpacked/resources')
const archive=path.join(resources,'app.asar')
assert.equal(JSON.parse(asar.extractFile(archive,'package.json').toString()).version,version)
for(const file of ['background.js','content.js','result-download.js','manifest.json','README.md']){
 assert.deepEqual(await readFile(path.join(resources,'flow-companion',file)),await readFile(path.join('extension',file)),file)
}
assert.deepEqual(asar.extractFile(archive,path.join('dist-electron','flow-companion.cjs')),await readFile('dist-electron/flow-companion.cjs'))
for(const file of ['gemini-logo.cjs','gemini-masks.cjs','logo-worker.cjs','logo-queue.cjs','logo-inpaint.cjs'])assert.deepEqual(asar.extractFile(archive,path.join('dist-electron','media',file)),await readFile(path.join('dist-electron','media',file)))
for(const file of ['preload.cjs','main.cjs','workspace-manager.cjs','flow-coordinator.cjs','storage/database.cjs','storage/generations.cjs','storage/exports.cjs','storage/themes.cjs','storage/projects.cjs','storage/prompt-core.mjs'])assert.deepEqual(asar.extractFile(archive,path.join('dist-electron',file)),await readFile(path.join('dist-electron',file)))
assert.deepEqual(asar.extractFile(archive,path.join('third-party','gemini-watermark','LICENSE.txt')),await readFile('third-party/gemini-watermark/LICENSE.txt'))
for(const file of ['migan_pipeline_v2.onnx','LICENSE.txt','LICENSE-WEIGHTS.txt','README.txt','model.json'])assert.deepEqual(asar.extractFile(archive,path.join('third-party','migan',file)),await readFile(path.join('third-party','migan',file)))
assert.ok((await stat(path.join(resources,'app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node'))).size>100_000)
const html=await readFile('dist/index.html','utf8')
for(const asset of [...html.matchAll(/(?:src|href)="\.?(\/assets\/[^"?]+)/g)].map(m=>m[1].slice(1))){
 assert.deepEqual(asar.extractFile(archive,path.join('dist',asset)),await readFile(path.join('dist',asset)))
}
const installer=path.join(root,`Frame-Studio-${version}-x64-Setup.exe`)
assert.ok((await stat(installer)).size>100_000_000)
console.log('PASS installer',version,'fast.22 extension, compiled companion, logo masks/processor, MIT license and UI match source; installer bytes:',(await stat(installer)).size)
