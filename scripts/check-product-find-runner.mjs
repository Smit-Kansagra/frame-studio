import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ProductFindRunner } from '../dist-electron/product-find-runner.cjs'
const root = await mkdtemp(path.join(os.tmpdir(), 'product-runner-check-'))
const fixture = path.join(root, 'fixture.cjs')
await writeFile(fixture, `const mode = process.argv[2];
const row = {product_url:'https://www.meesho.com/example/p/123',image_url:'https://images.example.com/product.png'};
if (mode==='hang') setInterval(()=>{},1000);
else if(mode==='invalid') console.log('not json');
else if(mode==='auth') {console.error('authentication required');process.exitCode=1;}
else if(mode==='unsafe') console.log(JSON.stringify({status:'SUCCESS',structured_output:{products:[{...row,product_url:'javascript:alert(1)'}],note:''}}));
else if(mode==='error') console.log(JSON.stringify({status:'ERROR',response:''}));
else { console.log(JSON.stringify({status:'SUCCESS',structured_output:{products:mode==='empty'?[]:[row,row],note:'Fixture result'}})); }
`)
function runner(mode, timeoutMs=5000) {
  return new ProductFindRunner(root, { resolveCLI: async()=>process.execPath, prefixArgs:[fixture,mode], timeoutMs })
}
async function done(instance) {
  const end=Date.now()+10000
  while(instance.status().state==='running' && Date.now()<end) await new Promise(resolve=>setTimeout(resolve,25))
  assert.notEqual(instance.status().state,'running')
  return instance.status()
}
const missing=new ProductFindRunner(root,{resolveCLI:async()=>null})
await assert.rejects(missing.start('bags'), /CLI is missing/)
assert.equal(missing.status().state,'error')
const good=runner('good')
await good.start('bags " ; & $()')
assert.equal((await done(good)).state,'complete')
const saved=await readFile(path.join(root,'products.json'),'utf8')
assert.equal(JSON.parse(saved).length,1)
for(const mode of ['invalid','auth','unsafe','error','empty']) {
  const current=runner(mode)
  await current.start('bags')
  assert.equal((await done(current)).state, mode==='empty'?'complete':'error')
  assert.equal(await readFile(path.join(root,'products.json'),'utf8'),saved)
}
const cancel=runner('hang')
await cancel.start('bags')
await assert.rejects(cancel.start('duplicate'),/already running/)
cancel.cancel()
assert.equal(cancel.status().state,'cancelled')
const timeout=runner('hang',100)
await timeout.start('bags')
assert.equal((await done(timeout)).state,'error')
assert.match(timeout.status().message,/timed out/)
await new Promise(resolve=>setTimeout(resolve,500))
assert.equal(await readFile(path.join(root,'products.json'),'utf8'),saved)
console.log('PASS: child execution, missing CLI, deduplication, invalid/unsafe/error/empty preservation, authentication failure, duplicate start, cancellation and timeout.')
