// All products and provider responses in this check are labelled fixtures, never live results.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { emptyStore, candidate, canonical, assemble, eligible, selectProducts, PackRepository, planSeventhSlot } from '../dist-electron/ready-packs-core.cjs'
import { PackService } from '../dist-electron/ready-packs-service.cjs'
import { parseCsv, importProducts, flipkartProducts } from '../dist-electron/ready-packs-providers.cjs'
import { manifest, textEntries, exportZip } from '../dist-electron/ready-packs-export.cjs'
const folder=await mkdtemp(path.join(os.tmpdir(),'frame-ready-packs-fixtures-'))
const store=emptyStore();store.settings.ai={provider:'none',model:'',effort:'medium'}
function fixture(i,category='0',sub='short kurtis') {return {...candidate(`https://www.meesho.com/fixture-garment-${i}/p/fixture${i}`),title:`FIXTURE ${['floral','striped','plain','embroidered','printed','woven','lace','denim'][i%8]} short kurti`,category,subcategory:sub,variant:'blue',color:String(i),price:499,currency:'INR',observedAt:new Date().toISOString(),match:'exact',photoObservation:{url:`https://images.example.com/fixture${i}.png`,at:new Date().toISOString()},images:[{url:`https://images.example.com/fixture${i}.png`,source:`https://www.meesho.com/fixture-garment-${i}/p/fixture${i}`,variant:'blue',permission:'permitted',permissionNote:'TEST FIXTURE only',exportedAt:null}]}}
assert.equal(store.plan.length,56)
assert.equal(new Set(store.plan.filter(p=>p.week<=4&&p.day<=5).map(p=>p.category)).size,20)
assert.deepEqual(store.plan.filter(p=>p.day===6).map(p=>p.category),['20','21','22','23','20','21','22','23'])
assert.equal(store.plan[28].variation,'Budget variation: maximum 20% lower; same subcategory')
store.products=Array.from({length:8},(_,i)=>fixture(i))
const theme={category:'0',subcategory:'short kurtis',min:200,max:1000}
for(const patch of [{price:null},{currency:null},{price:1001},{price:199},{category:'1'},{subcategory:'tops'},{match:'unknown'},{stock:'out-of-stock'},{observedAt:null}])assert.equal(eligible({...fixture(90),...patch},theme,store),false)
assert.equal(eligible({...fixture(90),stock:'unknown'},theme,store),true)
assert.equal(canonical('https://www.amazon.in/title/dp/B012345678?tag=tracking').id,canonical('https://amazon.in/dp/B012345678').id)
const a=fixture(0),b={...fixture(1),garmentId:'same'},c={...fixture(2),garmentId:'same'},d={...fixture(3),images:a.images}
assert.equal(selectProducts([a,b,c,d],5).length,2)
const pack=assemble(store,store.plan[0]);assert.equal(pack.productIds.length,5)
assert.equal(eligible(store.products[0],theme,store),false)
const seventh=structuredClone(store.plan[6]);planSeventhSlot(store,seventh);assert.notEqual(seventh.category,'0');assert.match(seventh.reason,/least-covered/);const varied=emptyStore();varied.products=Array.from({length:6},(_,i)=>({...fixture(i),price:900}));assert.equal(assemble(varied,varied.plan[28]).productIds.length,5);
const measured=emptyStore();for(let theme=0;theme<2;theme++)for(let i=0;i<2;i++){measured.packs.push({...pack,id:'measured-'+theme+'-'+i,category:String(theme),subcategory:theme?'tops':'short kurtis',state:'posted',performance:[1,2].map(day=>({postUrl:'',publishedAt:'2026-11-01',source:'Manual Insights',window:'First 7 days',observedAt:'2026-11-0'+day+'T12:00:00Z',reach:1000,saves:theme?10:50,shares:null,clicks:null,orders:null,commission:null}))})}const repeated=measured.plan[6];planSeventhSlot(measured,repeated);assert.equal(repeated.category,'0');assert.match(repeated.reason,/Repeat supported/);
const repo=new PackRepository(folder);await writeFile(path.join(folder,'library.json'),'LEGACY DATA UNCHANGED');await writeFile(path.join(folder,'keys.bin'),'LEGACY SECRET UNCHANGED');await repo.save(store);await repo.save(store)
assert.equal((await repo.load()).packs.length,1)
assert.equal(await readFile(path.join(folder,'library.json'),'utf8'),'LEGACY DATA UNCHANGED')
assert.equal(await readFile(path.join(folder,'keys.bin'),'utf8'),'LEGACY SECRET UNCHANGED')
assert.equal(JSON.parse(await readFile(path.join(folder,'ready-packs-v1.json.bak'),'utf8')).version,1)
const svc=new PackService(repo,async()=>[]);await svc.ready;await svc.replace(pack.id,pack.productIds[0]);assert.equal(svc.state.packs[0].productIds.length,5)
assert.notDeepEqual(svc.state.packs[0].productIds,pack.productIds)
await svc.skip(pack.id);assert.equal(svc.queue().length,0)
assert.equal(eligible(svc.state.products.find(p=>p.id===pack.productIds[0]),theme,svc.state),false)
const parsed=parseCsv('url,title\r\n"https://meesho.com/fixture/p/a","FIXTURE, blue"');assert.equal(parsed[0].title,'FIXTURE, blue')
assert.throws(()=>importProducts('[{"url":"http://127.0.0.1/p/x"}]',store.settings.categories))
const unknown=importProducts('[{"url":"https://meesho.com/fixture/p/a"}]',store.settings.categories)[0];assert.equal(unknown.price,null);assert.equal(unknown.stock,'unknown');assert.equal(unknown.match,'unknown');const classified=importProducts(JSON.stringify([{url:'https://meesho.com/fixture/p/classified',title:'FIXTURE short kurti'}]),store.settings.categories)[0];assert.equal(classified.category,'0')
const fk=flipkartProducts({productInfoList:[{productBaseInfoV1:{title:'FIXTURE short kurti',productUrl:'https://flipkart.com/fixture/p/itmfixture?pid=FIXTUREID&affid=fixture',flipkartSellingPrice:{amount:450,currency:'INR'},attributes:{color:'Blue',size:'M'},inStock:false,imageUrls:{original:'https://images.example.com/fixture.png'}}}]},{imagePermission:'',flipkartId:'fixture',flipkartToken:'fixture'})[0]
assert.equal(fk.price,450);assert.equal(fk.variant,'Blue');assert.equal(fk.stock,'out-of-stock');assert.equal(fk.images[0].permission,'unknown');assert.ok(fk.affiliateUrl);assert.ok(!fk.url.includes('affid'))
const exportStore=emptyStore();exportStore.products=Array.from({length:5},(_,i)=>fixture(i));const exportPack=assemble(exportStore,exportStore.plan[0]);const data=manifest(exportPack,[...exportStore.products].reverse());assert.equal(data.products[0].id,exportPack.productIds[0]);assert.equal(data.products[0].primaryFile,'01_primary.jpg')
exportStore.products[0].title='=FIXTURE <script>alert(1)</script>'
const texts=textEntries(exportPack,exportStore.products);assert.ok(!texts.find(e=>e.name==='preview.html').data.toString().includes('<script>'));assert.ok(texts.find(e=>e.name==='links.csv').data.toString().includes("'=FIXTURE"))
const png=await sharp({create:{width:4,height:4,channels:3,background:'blue'}}).png().toBuffer();let downloads=0
const archive=await exportZip(exportPack,exportStore.products,async()=>{downloads++;return{data:png,type:'image/png'}});assert.equal(downloads,5);assert.equal(archive.readUInt32LE(),0x04034b50);await writeFile(path.join(folder,'fixture-pack.zip'),archive)
const denied=structuredClone(exportStore.products);denied[0].images[0].permission='unknown';await assert.rejects(exportZip(exportPack,denied),/permission/)
const newer=structuredClone(store);newer.version=99;await writeFile(path.join(folder,'ready-packs-v1.json'),JSON.stringify(newer));await assert.rejects(repo.load(),/Unsupported/)
// Restart recovers a running job and never duplicates already committed slots.
const jobsFolder=await mkdtemp(path.join(os.tmpdir(),'frame-ready-job-fixtures-'));const jobsRepo=new PackRepository(jobsFolder);const jobs=emptyStore();jobs.settings.ai={provider:'none',model:'',effort:'medium'};jobs.job.state='running';await jobsRepo.save(jobs)
let searches=0;const provider={status:{id:'meesho',status:'FIXTURE',readiness:'configured-unverified',capabilities:{search:true,details:true,images:true}},details:async p=>p,search:async(c,sub)=>{searches++;await new Promise(r=>setTimeout(r,10));return Array.from({length:8},(_,i)=>fixture(searches*10+i,c.id,sub))}}
const runner=new PackService(jobsRepo,async()=>[provider]);await runner.ready;assert.equal(runner.state.job.state,'idle');await runner.generate();await assert.rejects(runner.generate(),/running/)
while(runner.busy)await new Promise(r=>setTimeout(r,10))
assert.equal(runner.queue().length,1);assert.equal(searches,1);assert.equal(new Set(runner.state.packs.map(p=>p.slotId)).size,1)
const restarted=new PackService(jobsRepo,async()=>[provider]);await restarted.ready;await restarted.tick();assert.equal(searches,1);assert.equal(restarted.state.packs.length,1)
console.log('PASS: planner, strict filters, unknowns, deduplication, coherence, replacement, cooldown, persistence, preservation, version refusal, restart, overlap, ZIP mapping, JPEG conversion, escaping, and permissions.')
console.log('Fixture ZIP for independent inspection: '+path.join(folder,'fixture-pack.zip'))
