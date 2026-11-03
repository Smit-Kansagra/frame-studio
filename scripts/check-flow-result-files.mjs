// Focused downloaded-result transport check. No app UI or user workspace.
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,lstat,readFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import {FlowResultFiles} from '../dist-electron/flow-result-files.cjs'
const root=await mkdtemp(path.join(os.tmpdir(),'frame-result-check-')),directory=path.join(root,'project')
await mkdir(directory)
const original=await sharp({create:{width:64,height:96,channels:3,background:'#36995f'}}).jpeg().toBuffer()
const source=path.join(root,'11111111-1111-4111-8111-111111111111.jpg');await writeFile(source,original)
const files=new FlowResultFiles(directory,'https://flow.google.com/project/test','result-1')
assert.equal(await files.existing(),undefined)
const saved=await files.store(source)
assert.equal(path.dirname(saved),directory);assert.deepEqual(await readFile(saved),original)
await assert.rejects(()=>lstat(source),{code:'ENOENT'})
assert.equal(await files.existing(),saved)
assert.equal((await sharp(saved).metadata()).width,64)
assert.equal(await new FlowResultFiles(directory,'https://flow.google.com/project/test','result-2').existing(),undefined)
await assert.rejects(()=>new FlowResultFiles('relative-path','url','id').existing(),/must be absolute/)
const invalid=path.join(root,'unsupported.txt');await writeFile(invalid,original)
await assert.rejects(()=>files.store(invalid),/Unsupported/)
assert.ok(await lstat(invalid),'An unrelated source is preserved')
console.log('PASS result moved intact into its project directory, Chrome staging removed, retry cache reused, different result excluded, invalid source preserved.')
