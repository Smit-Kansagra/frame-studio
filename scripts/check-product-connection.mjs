// Isolated regression fixtures: no retailer traffic, Chrome profile or model calls.
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PackRepository, emptyStore, validateSelection, budgetMaximum, candidate, assemble } from '../dist-electron/ready-packs-core.cjs'
import { PackService } from '../dist-electron/ready-packs-service.cjs'

const folder = await mkdtemp(path.join(os.tmpdir(), 'frame-connection-fixtures-'))
const repo = new PackRepository(folder), initial = emptyStore()
initial.settings.ai = {provider:'none',model:'',effort:'medium'}
initial.preferences = {category:'auto',min:200,max:1000,extraBudgetInr:100,maxStorePriority:4,size:5,stores:[],storeMode:'auto',mode:'auto'}
initial.settings.storeRanks = {meesho:2,flipkart:5}
initial.actionableError = {code:'source-setup',message:'FIXTURE old disconnected status',action:'Pair'}
initial.job = {state:'error',message:'Product source setup required',dueAt:new Date().toISOString(),attempts:0}
await repo.save(initial)
let connected = false, settled = false, started
const entered = new Promise(resolve => { started = resolve })
const provider = () => ({status:{id:'meesho',name:'Meesho',status:'FIXTURE',readiness:connected?'configured-unverified':'needs-access',capabilities:{search:true,details:true,images:true}},details:async p=>p,search:async(_category,_query,signal)=>{started();try{await new Promise((resolve,reject)=>{if(signal.aborted)return reject(signal.reason);signal.addEventListener('abort',()=>reject(signal.reason),{once:true})})}finally{await new Promise(resolve=>setTimeout(resolve,15));settled=true}}})
const service = new PackService(repo,async()=>[provider()]);await service.ready
assert.ok((await service.connectionStatus()).actionableError)
connected=true
assert.equal((await service.connectionStatus()).actionableError,undefined)
assert.equal((await service.connectionStatus()).job.state,'idle')
assert.ok(service.state.actionableError,'Historical persisted failure remains intact')
service.state.preferences.maxStorePriority=1
assert.ok((await service.connectionStatus()).actionableError,'Pairing cannot override rank cutoff')
service.state.preferences.maxStorePriority=4
await service.find(service.state.preferences);await entered
await assert.rejects(service.mutate(async()=>{}),/search is running/i)
await assert.rejects(service.find(service.state.preferences),/still running/)
await service.cancel();assert.ok(settled);assert.equal(service.busy,false);assert.equal(service.state.job.state,'cancelled');assert.equal(service.state.packs.length,0)
const selection=validateSelection(initial.preferences,initial.settings)
assert.equal(budgetMaximum(selection),1100)
assert.throws(()=>validateSelection({...selection,extraBudgetInr:-1},initial.settings))
assert.throws(()=>validateSelection({...selection,maxStorePriority:0},initial.settings))
const inventory=emptyStore();inventory.selection=selection;inventory.settings.storeRanks={meesho:2,flipkart:5}
inventory.products=Array.from({length:6},(_,i)=>{
 const url=i<3?`https://meesho.com/fixture/p/test${i}`:`https://flipkart.com/fixture/p/itmtest${i}?pid=TEST${i}`
 const image=`https://images.example.com/fixture${i}.jpg`,at=new Date().toISOString()
 return {...candidate(url),title:`FIXTURE ${['floral','striped','woven','lace','printed','plain'][i]} short kurti`,category:'0',subcategory:'short kurtis',variant:'Listing fixture '+i,color:String(i),price:i<3?1050:950,currency:'INR',observedAt:at,match:'exact',images:[{url:image,source:url,variant:'Listing fixture '+i,permission:'unknown',permissionNote:'',exportedAt:null}],photoObservation:{url:image,at}}
})
inventory.selection={...selection,stores:['meesho','flipkart'],storeRanks:inventory.settings.storeRanks}
const pack=assemble(inventory,inventory.plan[0]);assert.equal(pack.max,1100);assert.equal(pack.productIds.length,5);assert.ok(pack.productIds.slice(0,3).every(id=>inventory.products.find(p=>p.id===id).retailer==='meesho'))

const script=await readFile('extension-product-finder/popup.js','utf8'),grants=new Set(),permissionAdded=[],permissionRemoved=[]
let requests=[],connections=0,connection=true
function popup(){
 const elements=new Map(),intervals=[]
 const element=id=>{if(!elements.has(id))elements.set(id,{textContent:'',value:'',hidden:false,disabled:false,events:{},addEventListener(type,handler){this.events[type]=handler}});return elements.get(id)}
 const chrome={permissions:{contains:async({origins})=>origins.every(origin=>grants.has(origin)),request:async({origins})=>{requests.push(origins);origins.forEach(origin=>grants.add(origin));return true},onAdded:{addListener:fn=>permissionAdded.push(fn)},onRemoved:{addListener:fn=>permissionRemoved.push(fn)}},runtime:{getManifest:()=>({version:'FIXTURE'}),sendMessage:async message=>{if(message.type==='products:status')return{connected:connection,running:false};if(message.type==='products:connect'){connections++;return{ok:true,message:'FIXTURE connected'}};return{ok:true}}}}
 vm.runInNewContext(script,{chrome,document:{querySelector:element},window:{addEventListener(){}},setInterval:fn=>{intervals.push(fn);return intervals.length},clearInterval(){}})
 return{element,intervals}
}
const flush=()=>new Promise(resolve=>setImmediate(resolve))
let ui=popup();await flush();assert.equal(ui.element('#product-connect').disabled,true)
await ui.element('#allow-sites').events.click();assert.equal(requests.length,1);assert.equal(requests[0].length,5)
ui.element('#product-code').value='12345.'+'a'.repeat(64);await ui.element('#product-connect').events.click();assert.equal(connections,1);assert.equal(requests.length,1)
ui=popup();await flush();assert.equal(ui.element('#allow-sites').hidden,true);ui.element('#product-code').value='12345.'+'b'.repeat(64);await ui.element('#product-connect').events.click();assert.equal(requests.length,1);assert.equal(connections,2)
connection=false;ui.intervals[0]();await flush();assert.match(ui.element('#connection-status').textContent,/Not connected/)
grants.delete('https://www.meesho.com/*');permissionRemoved.at(-1)();await flush();await ui.element('#allow-sites').events.click();assert.deepEqual(Array.from(requests[1]),['https://www.meesho.com/*'])
const html=await readFile('extension-product-finder/popup.html','utf8');assert.ok(!html.includes('type="checkbox"'));assert.ok(html.includes('<details><summary>Help</summary>'))
console.log('PASS fixtures: current connection vs stale notice, rank cutoff, cancellation drains workers, edit/overlap lock, explicit price allowance and priority, saved site grants across popup reopen/pairing, missing-only permission request, disconnect status, compact popup.')

if(process.argv.includes('--browser')) {
 const {chromium}=await import('playwright')
 const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true,ignoreDefaultArgs:['--unsafely-disable-devtools-self-xss-warnings']})
 try {
  const page=await browser.newPage({viewport:{width:390,height:720}})
  await page.route('**/*',async route=>{
   const name=new URL(route.request().url()).pathname.slice(1)
   const allowed=['popup.html','popup.js','popup.css','icons/icon-48.png','icons/icon-32.png']
   if(!allowed.includes(name))return route.abort()
   return route.fulfill({body:await readFile(path.join('extension-product-finder',name)),contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html'})
  })
  await page.addInitScript(()=>{
   const grants=new Set();window.fixture={requests:0,connects:0,connected:false}
   window.chrome={permissions:{contains:async p=>p.origins.every(o=>grants.has(o)),request:async p=>{window.fixture.requests++;p.origins.forEach(o=>grants.add(o));return true},onAdded:{addListener(){}},onRemoved:{addListener(){}}},runtime:{getManifest:()=>({version:'FIXTURE'}),sendMessage:async m=>{if(m.type==='products:status')return{connected:window.fixture.connected,running:false};if(m.type==='products:connect'){window.fixture.connects++;window.fixture.connected=true;return{ok:true,message:'FIXTURE paired'}};return{ok:true}}}}
  })
  await page.goto('https://extension-fixture.invalid/popup.html')
  await page.getByRole('button',{name:'Allow shopping sites once',exact:true}).click()
  await page.locator('#product-code').fill('12345.'+'c'.repeat(64))
  await page.getByRole('button',{name:'Connect',exact:true}).click()
  await page.waitForFunction(()=>window.fixture.connects===1)
  await page.locator('#product-code').fill('12345.'+'d'.repeat(64))
  await page.getByRole('button',{name:'Connect',exact:true}).click()
  assert.equal(await page.evaluate(()=>window.fixture.requests),1)
  assert.equal(await page.getByRole('checkbox').count(),0)
  assert.equal(await page.locator('details').getAttribute('open'),null)
  await page.waitForFunction(()=>document.querySelector('#connection-status').textContent.includes('Connected to Frame Studio'))
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
  await page.getByRole('button',{name:'Disconnect',exact:true}).waitFor()
  console.log('PASS isolated Chrome popup: one-time permission approval, repeated Connect without permission prompt, current connection, no duplicate store choices, collapsed Help, no horizontal overflow. All Chrome APIs and network responses are fixtures.')
 } finally {await browser.close()}
}
