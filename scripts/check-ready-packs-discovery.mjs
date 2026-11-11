// Labelled fixtures only. No account or merchant licence is fabricated for live discovery.
import assert from 'node:assert/strict'
import { candidate, defaultSettings } from '../dist-electron/ready-packs-core.cjs'
import { parseListingHtml, retailerAnchors, classify, flipkartProducts } from '../dist-electron/ready-packs-providers.cjs'
import { applyLicences, validateLicence } from '../dist-electron/ready-packs-licences.cjs'
import { parseShopifyProduct, libasProvider } from '../dist-electron/ready-packs-libas.cjs'
import { exportZip } from '../dist-electron/ready-packs-export.cjs'
const url='https://meesho.com/fixture/p/fixture'
const anchors=retailerAnchors(`<a href="${url}">Fixture</a><a href="${url}">Duplicate</a><a href="https://127.0.0.1/secret">Private</a><script>location='https://meesho.com/script/p/not-an-anchor'</script>`,'https://wishlink.com/fixture')
assert.equal(anchors.length,1);assert.equal(anchors[0].url,url)
const product={'@type':'https://schema.org/Product',name:'FIXTURE short kurti',color:'Blue',offers:[{url,price:'499',priceCurrency:'INR'}],image:'https://images.example.com/fixture.jpg'}
const p=parseListingHtml(candidate(url),'<script type="application/ld+json">'+JSON.stringify(product)+'</script>');assert.equal(p.match,'exact');assert.equal(p.price,499);assert.equal(p.stock,'unknown');classify(p,defaultSettings().categories);assert.equal(p.category,'0')
const unknown=parseListingHtml(candidate(url),'<script type="application/ld+json">'+JSON.stringify({...product,color:undefined,offers:{url}})+'</script>');assert.equal(unknown.price,null);assert.equal(unknown.currency,null);assert.equal(unknown.stock,'unknown');assert.equal(unknown.match,'unknown')
const image='https://cdn.shopify.com/s/files/1/0341/4805/7228/files/FIXTURE.jpg'
const grant={id:'fixture-grant',provider:'libas',account:'FIXTURE merchant grant',reference:'TEST FIXTURE ONLY; NOT A LIVE LICENCE',grantedAt:'2020-01-01T00:00:00Z',expiresAt:null,uses:['catalogue-research','instagram-commercial','image-export'],productHosts:['www.libas.in'],imageHosts:['cdn.shopify.com'],imagePathPrefixes:['/s/files/1/0341/4805/7228/']}
validateLicence(grant);assert.throws(()=>validateLicence({...grant,imagePathPrefixes:undefined}),/merchant-specific/)
const raw={id:123,handle:'fixture-short-kurti',title:'FIXTURE short kurti',featured_image:image,options:[{name:'Size'}],variants:[{id:11,title:'S',options:['S'],price:49900,available:false},{id:12,title:'M',options:['M'],price:54900,available:true}]}
const parsed=parseShopifyProduct(raw,'https://www.libas.in/products/fixture-short-kurti','INR',[grant]);assert.equal(parsed.price,549);assert.equal(parsed.color,'');assert.equal(parsed.variant,'M');assert.equal(parsed.match,'exact');assert.ok(parsed.url.endsWith('?variant=12'));assert.deepEqual(parsed.sizes,['M']);assert.equal(parsed.images[0].permission,'permitted')
const same=candidate('https://www.libas.in/products/fixture-short-kurti?variant=11');assert.equal(same.id,parsed.id);assert.equal(parseShopifyProduct(raw,same.url,'INR',[]).stock,'out-of-stock')
assert.equal(parseShopifyProduct(raw,same.url,null,[]).currency,null)
assert.equal(libasProvider([]).search,undefined)
for(const modified of [{...grant,expiresAt:'2021-01-01T00:00:00Z'},{...grant,uses:['catalogue-research']},{...grant,imagePathPrefixes:['/another-merchant/']},{...grant,productHosts:['another.example.com']}]){const changed=applyLicences(structuredClone(parsed),[modified]);assert.equal(changed.images[0].permission,'unknown')}
assert.equal(applyLicences(structuredClone(parsed),[]).images[0].permission,'unknown')
classify(parsed,defaultSettings().categories);parsed.photoObservation={url:parsed.images[0].url,at:new Date().toISOString()};const pack={id:'fixture',theme:'FIXTURE',productIds:[parsed.id],category:'0',subcategory:'short kurtis',min:200,max:1000,requested:4,state:'drafted',createdAt:new Date().toISOString(),reasons:[],performance:[],references:[]};await assert.rejects(exportZip(pack,[parsed],async()=>{throw new Error('Should not download with revoked rights')}),/permission/)
const fk=flipkartProducts({productInfoList:[{productBaseInfoV1:{productUrl:'https://flipkart.com/fixture/p/itmfixture?pid=fixture',color:'Blue',imageUrls:{primary:'https://images.example.com/fixture.jpg'}}}]},{flipkartId:'fixture',flipkartToken:'fixture',imagePermission:'Legacy free text is insufficient'})[0];assert.equal(fk.images[0].permission,'unknown')
console.log('PASS fixtures: public hub anchors, no script execution, expanded JSON-LD type, offer-array identity, unknown facts, variant/size mapping, price units, licence inheritance/scope/expiry/revocation, no unlicensed downloads, no automatic Libas access, no legacy blanket rights.')
