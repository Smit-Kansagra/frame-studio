// Chrome-only regression checks. All Flow URLs are intercepted locally; no
// Google account, network generation, Frame Studio DB or user profile is used.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const content = await readFile('extension/content.js', 'utf8')
const uploadMain=(await readFile('extension/upload-main.js','utf8')).replace('export function uploadInPage','function uploadInPage')
const editorMain=(await readFile('extension/editor-main.js','utf8')).replaceAll('export ','')
const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, ignoreDefaultArgs: ['--unsafely-disable-devtools-self-xss-warnings'] })
const url = 'https://flow.google.com/project/extension-regression'
const fixture = `<!doctype html><style>
  [hidden]{display:none!important} flow-base-prompt-box{display:block;padding:20px}
  mat-icon{display:inline-block} button{padding:6px} textarea{display:block}
</style><main><button>Oct 25 - 11:57</button>
<flow-base-prompt-box><div id="composer"><div><flow-rich-text-editor><div><textarea aria-label="Prompt"></textarea></div></flow-rich-text-editor></div>
<div style="display:contents"><button id="add" aria-label="Reference menu"><mat-icon class="add-menu-icon google-symbols" aria-hidden="true">add</mat-icon></button></div>
<button>Agent</button><button id="summary" aria-expanded="false"><mat-icon aria-hidden="true">crop_square</mat-icon>Nano Banana 2.1 x1</button>
<button id="generate" aria-label="Run generation"><mat-icon aria-hidden="true">arrow_forward</mat-icon></button>
<div id="attachments"></div></div></flow-base-prompt-box></main>
<script>
window.fixture={submissions:0,uploadClicks:0,changes:0,selectedRatio:null,selectedOutputs:null,settingsClicks:0};
const add=document.querySelector('#add'), summary=document.querySelector('#summary');
function closePicker(){document.querySelector('#picker')?.remove();add.querySelector('mat-icon').textContent='add'}
function openPicker(){
 closePicker();add.querySelector('mat-icon').textContent='close';
 const picker=document.createElement('section');picker.id='picker';picker.setAttribute('role','dialog');
 picker.innerHTML='<button>Oct 25 - 11:57</button><input placeholder="Search assets"><button>All</button><button>Images</button><button>Videos</button><p>No assets found</p><button id="upload"><mat-icon aria-hidden="true">upload</mat-icon>Upload media</button>';
 document.body.append(picker);
 picker.querySelector('#upload').onclick=()=>{
  window.fixture.uploadClicks++;
  setTimeout(()=>{
   const input=document.createElement('input');input.type='file';input.accept='image/*';input.multiple=true;input.hidden=true;
   input.onchange=()=>{window.fixture.changes++;for(const file of input.files){
    if(window.fixture.uploadingGroup){const group=document.createElement('div');group.setAttribute('role','group');group.setAttribute('aria-label',file.name);group.innerHTML='<span role="progressbar">0%</span>';document.querySelector('#attachments').append(group);setTimeout(()=>group.remove(),250)}
    const image=document.createElement('img');image.alt=file.name;image.width=16;image.height=16;
    image.src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    if(window.fixture.librarySelection){
     image.alt='';image.src='https://flow-content.google/image/11111111-1111-4111-8111-111111111111?Expires=1';
     if(window.fixture.delayedStableThumbnail){image.src='blob:https://flow.google.com/local-upload-preview';setTimeout(()=>image.src='https://flow-content.google/image/11111111-1111-4111-8111-111111111111?Expires=1',500)}
     const card=document.createElement('button');card.setAttribute('role','option');
     const title=document.createElement('span');title.className='asset-title';title.textContent=file.name;
     card.append(image,title);picker.append(card);
     if(window.fixture.duplicateMetadata)card.title=file.name;
     card.onclick=()=>{
      const attach=()=>{
       image.alt='Ingredient image';image.src=window.fixture.staleThumbnail?'https://flow-content.google/image/22222222-2222-4222-8222-222222222222?Expires=2':'https://flow-content.google/image/11111111-1111-4111-8111-111111111111?Expires=2';
       const chip=document.createElement('button');chip.setAttribute('aria-label','Ingredient');chip.setAttribute('aria-busy','false');chip.append(image);
       const cancel=document.createElement('mat-icon');cancel.setAttribute('aria-hidden','true');cancel.textContent='cancel';chip.append(cancel);chip.onclick=()=>chip.remove();
       document.querySelector('#attachments').append(chip);closePicker();
      };
      if(window.fixture.requiresConfirm){const confirm=document.createElement('button');confirm.textContent='Add to prompt';confirm.onclick=attach;picker.append(confirm)}else attach();
     };
    }else document.querySelector('#attachments').append(image);
   } if(!window.fixture.librarySelection)closePicker()};
   document.body.append(input);
  },100);
 };
}
add.onclick=()=>document.querySelector('#picker')?closePicker():openPicker();
summary.onclick=()=>{
 const existing=document.querySelector('#settings');
 if(existing){existing.remove();summary.setAttribute('aria-expanded','false');return}
 window.fixture.settingsClicks++;
 const panel=document.createElement('section');panel.id='settings';if(!window.fixture.rolelessSettings)panel.setAttribute('role','dialog');
 panel.innerHTML='<button aria-selected="true">Image</button><button>Video</button>'+
 ['16:9','4:3','1:1','3:4','9:16'].map(r=>'<button data-ratio="'+r+'">'+r+'</button>').join('')+
 [1,2,3,4].map(n=>'<button data-output="'+n+'">x'+n+'</button>').join('');
 panel.querySelectorAll('[data-ratio]').forEach(button=>button.onclick=()=>window.fixture.selectedRatio=button.dataset.ratio);
 panel.querySelectorAll('[data-output]').forEach(button=>button.onclick=()=>window.fixture.selectedOutputs=Number(button.dataset.output));
 document.body.append(panel);summary.setAttribute('aria-expanded','true');
 if(window.fixture.pickerAlongsideSettings)openPicker();
};
document.querySelector('#generate').onclick=()=>{
 window.fixture.submissions++;
 if(window.fixture.ignoreSubmit)return;
 if(window.fixture.rejectSubmit){const alert=document.createElement('div');alert.setAttribute('role','alert');alert.textContent='Too many reference images. Please reduce the number of images.';document.body.append(alert);return}
 const editor=document.querySelector('textarea,[contenteditable="true"]');
 if(editor.isContentEditable && !window.fixture.editorModel)return;
 if(window.fixture.keepPrompt){const progress=document.createElement('div');progress.setAttribute('role','progressbar');progress.textContent='Generating';document.body.append(progress);return}
 if(editor.isContentEditable)editor.replaceChildren();else editor.value='';
};
window.openPicker=openPicker;
window.chrome={runtime:{id:'local-extension-fixture',onMessage:{addListener:listener=>window.extensionListener=listener},sendMessage:async message=>{try{let value;if(message.type==='frame-flow-edit-prompt')value=await window.editPromptInPage(message.prompt,message.nonce);else value=window.uploadInPage(message.file,message.nonce);return {ok:true,value}}catch(error){return {ok:false,error:error.message}}}}};
</script>`

async function command(page, action, payload = {}, id = crypto.randomUUID()) {
  // Simulate the host's native-submit handshake on this isolated fixture.
  // Production uses Windows UI Automation, not an injected JavaScript click.
  if(action==='submit') {
    let requests=submitRequests.get(page);if(!requests){requests=new Map();submitRequests.set(page,requests)}
    if(!requests.has(id)) requests.set(id,(async()=>{
      const armed=await command(page,'armSubmit',payload,`${id}:arm`)
      if(!armed.ok)return armed
      await page.locator('#generate').click()
      return command(page,'confirmSubmit',{...payload,nonce:armed.value.nonce},`${id}:confirm`)
    })())
    return requests.get(id)
  }
  return page.evaluate(({action,payload,id}) => new Promise(resolve => {
    window.extensionListener({type:'frame-flow-command',id,action,payload},{id:chrome.runtime.id},resolve)
  }), {action,payload,id})
}
const submitRequests=new WeakMap()
async function check(name, run) {
  if(process.argv[2] && !new RegExp(process.argv[2],'i').test(name)) return
  const page = await browser.newPage()
  // Abort all other network requests, including images. The fixture uses only
  // inline/data resources and cannot contact Google.
  await page.route('**/*', route => route.request().url() === url
    ? route.fulfill({ contentType: 'text/html', body: fixture }) : route.abort())
  try {
    await page.goto(url)
    await page.addScriptTag({content:uploadMain+';window.uploadInPage=uploadInPage'})
    await page.addScriptTag({content:editorMain+';window.editPromptInPage=editPromptInPage'})
    await page.addScriptTag({ content })
    await run(page)
    console.log(`PASS ${name}`)
  } finally { await page.close() }
}
const request = {url,outputType:'post',preset:'post-square',prompt:'Local extension regression prompt.',outputs:1}
const photo = {name:'local-product.png',type:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='}
try {
  await check('baseline waits for Flow capacity before arming a submission', async page => {
    const ready=await command(page,'prepare',request);assert.equal(ready.ok,true,ready.error)
    await page.evaluate(()=>{const button=document.querySelector('#generate');button.disabled=true;setTimeout(()=>button.disabled=false,350)})
    const baseline=await command(page,'baseline',{references:0,startFrame:false})
    assert.equal(baseline.ok,true,baseline.error)
    assert.equal(await page.locator('#generate').isEnabled(),true)
    assert.equal(await page.evaluate(()=>window.fixture.submissions),0,'Waiting for capacity cannot submit')
    const submitted=await command(page,'submit')
    assert.equal(submitted.ok,true,submitted.error)
    assert.equal(await page.evaluate(()=>window.fixture.submissions),1)
  })
  await check('project naming uses the software name without preparing or submitting', async page => {
    await page.evaluate(() => {
      window.fixture.nameSaves=0;window.fixture.nameCancels=0
      const decoy=document.createElement('button');decoy.setAttribute('aria-label','Done');decoy.onclick=()=>{throw new Error('Unrelated Done clicked')};document.body.append(decoy)
      const render=(saved,draft=saved)=>{
        const old=document.querySelector('.header-title'),header=document.createElement('span');header.className='header-title'
        header.innerHTML='<span role="heading"></span><flow-editable-text><input aria-label="Editable text"></flow-editable-text>'
        header.querySelector('[role="heading"]').setAttribute('aria-label',saved)
        const input=header.querySelector('input');input.value=draft;let committing=false
        input.onclick=()=>{
          if(header.querySelector('button'))return
          const done=document.createElement('button');done.setAttribute('aria-label','Done');done.textContent='done';done.style.visibility='hidden'
          done.onclick=()=>{committing=true;window.fixture.savedName=input.value;window.fixture.nameSaves++;render(input.value)}
          header.querySelector('flow-editable-text').append(done)
        }
        // Match the live UI: focus alone does not enter edit mode. A click is
        // required. Blur cancels, Enter alone never saves. Saving
        // replaces the header node, so confirmation must query the current DOM.
        input.onblur=()=>{if(input.isConnected&&!committing){window.fixture.nameCancels++;input.value=saved;header.querySelector('button')?.remove()}}
        if(old)old.replaceWith(header);else document.querySelector('main').prepend(header)
      }
      render('Oct 25 - 23:21','Final test 6')
    })
    const result=await command(page,'nameProject',{url,name:'Final test 6'})
    assert.equal(result.ok,true,result.error);assert.deepEqual(result.value,{name:'Final test 6'})
    assert.equal(await page.evaluate(()=>window.fixture.savedName),'Final test 6')
    assert.equal(await page.evaluate(()=>window.fixture.nameSaves),1)
    assert.equal(await page.evaluate(()=>window.fixture.nameCancels),0)
    assert.equal(await page.locator('textarea').inputValue(),'')
    assert.equal(await page.evaluate(()=>window.fixture.uploadClicks+window.fixture.submissions),0)
    assert.equal((await command(page,'nameProject',{url,name:'Final test 6'})).ok,true,'Already-correct name needs no edit')
    assert.equal(await page.evaluate(()=>window.fixture.nameSaves),1)
    const wrong=await command(page,'nameProject',{url:url+'-other-project',name:'Wrong target'})
    assert.equal(wrong.ok,false);assert.match(wrong.error,/Selected Flow project changed/)
    assert.equal(await page.locator('.header-title input').inputValue(),'Final test 6')
  })
  await check('leftover picker / Images-Videos navigation / 11:57 are not settings', async page => {
    await page.evaluate(() => window.openPicker())
    const result = await command(page,'prepare',request)
    assert.equal(result.ok,true,result.error)
    assert.deepEqual(result.value,{sourceRatio:'1:1',targetRatio:'1:1',automaticCrop:false})
    const state = await page.evaluate(() => window.fixture)
    assert.equal(state.selectedRatio,'1:1')
    assert.equal(state.selectedOutputs,1)
    assert.equal(state.submissions,0)
    assert.equal(await page.locator('#picker').count(),0)
  })
  await check('Material add icon / delayed external file input / attachment / one submission', async page => {
    const ready = await command(page,'prepare',request);assert.equal(ready.ok,true,ready.error)
    const attached = await command(page,'attach',{file:photo,kind:'reference'});assert.equal(attached.ok,true,attached.error)
    assert.equal(await page.locator('#attachments img').getAttribute('alt'),photo.name)
    const state = await page.evaluate(() => window.fixture)
    assert.equal(state.uploadClicks,1);assert.equal(state.changes,1);assert.equal(state.submissions,0)
    const baseline = await command(page,'baseline',{references:1,startFrame:false});assert.equal(baseline.ok,true,baseline.error)
    const id=crypto.randomUUID()
    assert.equal((await command(page,'submit',{},id)).ok,true)
    assert.equal((await command(page,'submit',{},id)).ok,true)
    assert.equal(await page.evaluate(() => window.fixture.submissions),1,'A duplicate message cannot click Generate again')
    assert.equal((await command(page,'submit')).ok,false)
    assert.equal(await page.evaluate(() => window.fixture.submissions),1)
  })
  await check('4:5 uses supported 3:4 source with automatic crop', async page => {
    const result=await command(page,'prepare',{...request,preset:'post-portrait'})
    assert.equal(result.ok,true,result.error)
    assert.deepEqual(result.value,{sourceRatio:'3:4',targetRatio:'4:5',automaticCrop:true})
    assert.equal(await page.evaluate(() => window.fixture.submissions),0)
  })
  await check('missing reference prevents submission', async page => {
    assert.equal((await command(page,'prepare',request)).ok,true)
    assert.equal((await command(page,'attach',{file:photo,kind:'reference'})).ok,true)
    await page.locator('#attachments').evaluate(element=>element.replaceChildren())
    const result=await command(page,'submit')
    assert.equal(result.ok,false)
    assert.match(result.error,/reference is no longer attached/)
    assert.equal(await page.evaluate(() => window.fixture.submissions),0)
  })
  await check('regenerate replaces a changed prompt and accepts an identical existing prompt without duplicate insertion', async page => {
    await page.evaluate(()=>{
      const editor=document.createElement('div');editor.contentEditable='true';editor.setAttribute('role','textbox');editor.setAttribute('aria-label','What do you want to create?');editor.textContent='Old prepared prompt'
      editor.addEventListener('input',()=>window.fixture.editorModel=editor.textContent)
      document.querySelector('textarea').replaceWith(editor)
    })
    assert.equal((await command(page,'prepare',request)).ok,true)
    await page.evaluate(()=>document.execCommand=()=>false)
    const same=await command(page,'prepare',request);assert.equal(same.ok,true,same.error)
    assert.equal(await page.locator('[contenteditable="true"]').textContent(),request.prompt)
    assert.equal(await page.evaluate(()=>window.fixture.submissions),0)
  })
  await check('100 percent upload still waits for completed processing beyond the former one minute timeout', async page => {
    assert.equal((await command(page,'prepare',request)).ok,true)
    await page.evaluate(name=>{
      const tile=document.createElement('flow-grid-tile-container');tile.style.display='block';tile.setAttribute('aria-label',name)
      tile.innerHTML='<img width="16" height="16" data-media-id="11111111-1111-4111-8111-111111111111"><button aria-label="More options">more_vert</button>'
      tile.querySelector('button').onclick=()=>{
        const menu=document.createElement('div');menu.innerHTML='<button role="menuitem">Add to prompt</button>';document.body.append(menu)
        menu.querySelector('button').onclick=()=>{
          window.fixture.attachClicks=(window.fixture.attachClicks||0)+1
          const chip=document.createElement('button');chip.setAttribute('aria-label','Ingredient');chip.setAttribute('aria-busy','true');chip.innerHTML='<img width="16" height="16" src="https://flow-content.google/image/11111111-1111-4111-8111-111111111111"><span role="progressbar">100%</span>';document.querySelector('#attachments').append(chip);menu.remove()
          const realNow=Date.now;setTimeout(()=>Date.now=()=>realNow()+65000,250)
          setTimeout(()=>{chip.setAttribute('aria-busy','false');chip.querySelector('span').remove();window.fixture.processingComplete=true},900)
        }
      };document.body.append(tile)
    },photo.name)
    const attached=await command(page,'attach',{file:photo,kind:'reference'});assert.equal(attached.ok,true,attached.error)
    assert.equal(await page.evaluate(()=>window.fixture.processingComplete),true)
    assert.equal(await page.evaluate(()=>window.fixture.attachClicks),1)
    assert.equal(await page.evaluate(()=>window.fixture.submissions),0)
  })
  await check('native-submit ticket arms without clicking, is single use and confirms the real browser click', async page => {
    assert.equal((await command(page,'prepare',request)).ok,true)
    const ticket=await command(page,'armSubmit');assert.equal(ticket.ok,true,ticket.error)
    assert.equal(await page.evaluate(()=>window.fixture.submissions),0)
    assert.equal((await command(page,'armSubmit')).ok,false)
    await page.locator('#generate').click()
    const result=await command(page,'confirmSubmit',{nonce:ticket.value.nonce});assert.equal(result.ok,true,result.error)
    assert.deepEqual(result.value,{accepted:true,evidence:'prompt-cleared'})
    assert.equal((await command(page,'confirmSubmit',{nonce:ticket.value.nonce})).ok,false)
    assert.equal(await page.evaluate(()=>window.fixture.submissions),1)
  })
  await check('ProseMirror-style editor receives native editing input and named Start generation is acknowledged', async page => {
    await page.evaluate(()=>{
      const editor=document.createElement('div');editor.contentEditable='true';editor.setAttribute('role','textbox');editor.setAttribute('aria-label','What do you want to create?')
      editor.addEventListener('input',()=>window.fixture.editorModel=editor.textContent)
      document.querySelector('textarea').replaceWith(editor)
      const generate=document.querySelector('#generate');generate.setAttribute('aria-label','Start generation');generate.replaceChildren()
    })
    const ready=await command(page,'prepare',request);assert.equal(ready.ok,true,ready.error)
    assert.equal(await page.evaluate(()=>window.fixture.editorModel),request.prompt)
    const result=await command(page,'submit');assert.equal(result.ok,true,result.error)
    assert.deepEqual(result.value,{accepted:true,evidence:'prompt-cleared'})
    assert.equal(await page.evaluate(()=>window.fixture.submissions),1)
  })
  await check('ignored click becomes uncertain instead of reporting results pending or clicking twice', async page => {
    assert.equal((await command(page,'prepare',request)).ok,true)
    await page.evaluate(()=>window.fixture.ignoreSubmit=true)
    const id=crypto.randomUUID(), result=await command(page,'submit',{},id)
    assert.equal(result.ok,false);assert.match(result.error,/did not acknowledge Start generation/)
    assert.deepEqual(await command(page,'submit',{},id),result)
    assert.equal((await command(page,'submit')).ok,false)
    assert.equal(await page.evaluate(()=>window.fixture.submissions),1)
  })
  await check('Flow reference-limit warning stops submission confirmation immediately', async page => {
    assert.equal((await command(page,'prepare',request)).ok,true)
    await page.evaluate(()=>window.fixture.rejectSubmit=true)
    const result=await command(page,'submit');assert.equal(result.ok,false);assert.match(result.error,/Too many reference images/)
    assert.equal(await page.evaluate(()=>window.fixture.submissions),1)
  })
  await check('generation progress acknowledges a submission even when Flow retains the prompt', async page => {
    assert.equal((await command(page,'prepare',request)).ok,true)
    await page.evaluate(()=>window.fixture.keepPrompt=true)
    const result=await command(page,'submit');assert.equal(result.ok,true,result.error)
    assert.deepEqual(result.value,{accepted:true,evidence:'generation-progress'})
    assert.equal(await page.evaluate(()=>window.fixture.submissions),1)
  })
  await check('roleless settings panel resolves through actual ratio/output controls', async page => {
    await page.evaluate(() => window.fixture.rolelessSettings=true)
    const result=await command(page,'prepare',request)
    assert.equal(result.ok,true,result.error)
    assert.equal(result.value.sourceRatio,'1:1')
    assert.equal(await page.evaluate(() => window.fixture.selectedOutputs),1)
    assert.equal(await page.evaluate(() => window.fixture.submissions),0)
  })
  await check('asset picker alongside settings is not a second settings panel', async page => {
    await page.evaluate(() => window.fixture.pickerAlongsideSettings=true)
    const result=await command(page,'prepare',request)
    assert.equal(result.ok,true,result.error)
    assert.equal(result.value.sourceRatio,'1:1')
    assert.equal(await page.evaluate(() => window.fixture.selectedOutputs),1)
    assert.equal(await page.evaluate(() => window.fixture.submissions),0)
  })
  await check('multiple unrelated image inputs cannot be selected arbitrarily', async page => {
    assert.equal((await command(page,'prepare',request)).ok,true)
    await page.evaluate(() => {
      for(let i=0;i<2;i++) {const input=document.createElement('input');input.type='file';input.accept='image/*';input.hidden=true;document.body.append(input)}
    })
    const result=await command(page,'attach',{file:photo,kind:'reference'})
    assert.equal(result.ok,false)
    assert.match(result.error,/Upload media image input/)
    assert.equal(await page.evaluate(() => window.fixture.changes),0)
    assert.equal(await page.evaluate(() => window.fixture.submissions),0)
  })
  await check('live Flow asset-title selection and generic Ingredient chip match stable asset ID', async page => {
    await page.evaluate(()=>{window.fixture.librarySelection=true;window.fixture.duplicateMetadata=true})
    assert.equal((await command(page,'prepare',request)).ok,true)
    const result=await command(page,'attach',{file:photo,kind:'reference'})
    assert.equal(result.ok,true,result.error)
    assert.equal(await page.locator('#attachments img').getAttribute('alt'),'Ingredient image')
    assert.equal((await command(page,'baseline',{references:1,startFrame:false})).ok,true)
    assert.equal(await page.evaluate(()=>window.fixture.submissions),0)
  })
  await check('upload-only live check supports explicit Add to prompt and cannot leave Generate prepared', async page => {
    await page.evaluate(()=>{window.fixture.librarySelection=true;window.fixture.requiresConfirm=true;window.fixture.uploadingGroup=true;window.fixture.delayedStableThumbnail=true;window.fixture.staleThumbnail=true})
    const result=await command(page,'checkReference',{file:photo,kind:'reference'})
    assert.equal(result.ok,true,result.error)
    assert.deepEqual(result.value,{attached:true,assetMatched:true})
    assert.equal((await command(page,'submit')).ok,false)
    assert.equal(await page.evaluate(()=>window.fixture.submissions),0)
  })
  await check('prepare removes the witnessed Ingredient/cancel chip without deleting library assets', async page => {
    await page.evaluate(()=>window.fixture.librarySelection=true)
    assert.equal((await command(page,'checkReference',{file:photo,kind:'reference'})).ok,true)
    assert.equal(await page.locator('#attachments img').count(),1)
    const result=await command(page,'prepare',request)
    assert.equal(result.ok,true,result.error)
    assert.equal(await page.locator('#attachments img').count(),0)
    assert.equal(await page.evaluate(()=>window.fixture.submissions),0)
  })
  await check('uploaded library photo attaches through its own Add to prompt menu, closes picker, matches stable ID', async page => {
    assert.equal((await command(page,'prepare',request)).ok,true)
    await page.evaluate(name=>{
      const tile=document.createElement('flow-grid-tile-container');tile.style.display='block';tile.setAttribute('aria-label',name)
      tile.innerHTML='<img width="16" height="16" data-media-id="11111111-1111-4111-8111-111111111111" src="https://flow.google.com/asb/opaque-thumbnail"><button aria-label="More options">more_vert</button>'
      tile.querySelector('button').onclick=()=>{
        const menu=document.createElement('div');menu.innerHTML='<button role="menuitem"><mat-icon>add_2</mat-icon>Add to prompt</button>';document.body.append(menu)
        menu.querySelector('button').onclick=()=>{
          const chip=document.createElement('button');chip.setAttribute('aria-label','Ingredient');chip.setAttribute('aria-busy','false')
          chip.innerHTML='<img width="16" height="16" alt="Ingredient image" src="https://flow-content.google/image/11111111-1111-4111-8111-111111111111?Expires=2">';document.querySelector('#attachments').append(chip);menu.remove()
        }
      };document.body.append(tile);window.openPicker()
    },photo.name)
    const result=await command(page,'attach',{file:photo,kind:'reference'});assert.equal(result.ok,true,result.error)
    assert.equal(await page.locator('#picker').count(),0)
    assert.equal(await page.locator('#attachments img').count(),1)
    assert.equal(await page.evaluate(()=>window.fixture.uploadClicks),0)
    // An already completed chip is reused by identity, never toggled off.
    assert.equal((await command(page,'attach',{file:photo,kind:'reference'})).ok,true)
    assert.equal(await page.locator('#attachments img').count(),1)
    assert.equal(await page.evaluate(()=>window.fixture.submissions),0)
  })
  await check('ambiguous duplicate library filenames stop before upload or attachment', async page => {
    assert.equal((await command(page,'prepare',request)).ok,true)
    await page.evaluate(name=>{
      for(let i=0;i<2;i++){const tile=document.createElement('flow-grid-tile-container');tile.style.display='block';tile.textContent=name;tile.setAttribute('aria-label',name);document.body.append(tile)}
    },photo.name)
    const result=await command(page,'attach',{file:photo,kind:'reference'});assert.equal(result.ok,false);assert.match(result.error,/Multiple Flow library assets/)
    assert.equal(await page.evaluate(()=>window.fixture.uploadClicks),0);assert.equal(await page.evaluate(()=>window.fixture.submissions),0)
  })
  await check('current Flow tiles match full prompts, exclude uploads/baseline, download Original size only', async page => {
    await page.evaluate(() => {
      window.fixture.originalDownloads=0;window.fixture.upscales=0
      const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
      for(const [id,prompt,generated] of [['upload','exact prompt',false],['old','exact prompt',true],['wrong','exact prompt with extra words',true],['new','exact prompt',true]]) {
        const tile=document.createElement('flow-grid-tile-container');tile.style.display='block'
        tile.innerHTML=`<img width="16" height="16" data-media-id="${id}" src="${image}"><button class="footer-left" aria-expanded="false">A short title</button>${generated?'<button aria-label="Reuse prompt">redo</button>':''}<button aria-label="More options">more_vert</button>`
        tile.querySelector('.footer-left').onclick=e=>{
          const open=e.currentTarget.getAttribute('aria-expanded')==='true'
          document.querySelector('flow-info-panel')?.remove();e.currentTarget.setAttribute('aria-expanded',String(!open))
          if(!open){const panel=document.createElement('flow-info-panel');panel.innerHTML='<div class="prompt-text"></div>';panel.querySelector('div').textContent=prompt;document.body.append(panel)}
        }
        tile.querySelector('[aria-label="More options"]').onclick=()=>{
          const menu=document.createElement('div');menu.innerHTML='<button role="menuitem"><mat-icon>download</mat-icon>Download</button>';document.body.append(menu)
          menu.querySelector('button').onclick=()=>{
            menu.innerHTML='<button role="menuitem">1K Original size</button><button role="menuitem">2K Upscaled</button>'
            menu.querySelectorAll('button')[0].onclick=()=>{window.fixture.originalDownloads++;menu.remove()}
            menu.querySelectorAll('button')[1].onclick=()=>window.fixture.upscales++
          }
        }
        document.body.append(tile)
      }
    })
    await page.locator('flow-grid-tile-container img').last().evaluate(image=>image.decode())
    const result=await command(page,'results',{url,prompt:'exact prompt',outputType:'post',baseline:['old']})
    assert.equal(result.ok,true,result.error);assert.deepEqual(result.value.map(item=>item.id),['new'])
    assert.equal(await page.locator('flow-info-panel').count(),0)
    assert.deepEqual((await command(page,'downloadLink',{url,result:result.value[0]})).value,{mode:'native-menu',title:''})
    const downloaded=await command(page,'downloadOriginal',{url,result:result.value[0]})
    assert.equal(downloaded.ok,true,downloaded.error)
    const state=await page.evaluate(()=>window.fixture)
    assert.equal(state.originalDownloads,1);assert.equal(state.upscales,0);assert.equal(state.submissions,0)
  })
  await check('result panels without aria-expanded close between products and recover a stale panel', async page => {
    await page.evaluate(() => {
      const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
      const stale=document.createElement('flow-info-panel');stale.innerHTML='<button aria-label="Close">close</button><div class="prompt-text">old unrelated prompt</div>';stale.querySelector('button').onclick=()=>stale.remove();document.body.append(stale)
      for (const id of ['first','second','third']) {
        const tile=document.createElement('flow-grid-tile-container');tile.style.display='block'
        tile.innerHTML=`<img width="16" height="16" data-media-id="${id}" src="${image}"><button class="footer-left">Result</button><button aria-label="Reuse prompt">redo</button>`
        tile.querySelector('.footer-left').onclick=()=>{
          const previous=document.querySelector('flow-info-panel');if(previous){previous.remove();return}
          const panel=document.createElement('flow-info-panel');panel.innerHTML='<div class="prompt-text"></div>';panel.querySelector('div').textContent=`product ${id}`;document.body.append(panel)
        }
        document.body.append(tile)
      }
    })
    await page.locator('flow-grid-tile-container img').last().evaluate(image=>image.decode())
    for(const id of ['first','second','third']) {
      const result=await command(page,'results',{url,prompt:`product ${id}`,outputType:'post',baseline:[]})
      assert.equal(result.ok,true,result.error);assert.deepEqual(result.value.map(item=>item.id),[id])
      assert.equal(await page.locator('flow-info-panel').count(),0)
    }
    assert.equal(await page.evaluate(()=>window.fixture.submissions),0)
  })
  await check('current result popovers close through outside click and hidden retained panels do not delay matching', async page => {
    await page.evaluate(() => {
      const header=document.createElement('span');header.className='header-title';header.textContent='Project';document.body.append(header)
      let outsideDown=false
      header.onpointerdown=()=>outsideDown=true
      header.onclick=()=>{if(outsideDown){document.querySelectorAll('flow-info-panel').forEach(p=>p.style.display='none');outsideDown=false}}
      const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
      for(const id of ['first','second','third']) {
        const tile=document.createElement('flow-grid-tile-container');tile.style.display='block'
        tile.innerHTML=`<img data-media-id="${id}" src="${image}" width="16" height="16"><button class="footer-left">Result</button><button aria-label="Reuse prompt">redo</button>`
        tile.querySelector('.footer-left').onclick=()=>{
          document.querySelectorAll('flow-info-panel').forEach(p=>p.style.display='none')
          const panel=document.createElement('flow-info-panel');panel.innerHTML='<div class="prompt-text"></div>';panel.querySelector('div').textContent=`prompt ${id}`;document.body.append(panel)
        }
        document.body.append(tile)
      }
    })
    await page.locator('flow-grid-tile-container img').last().evaluate(image=>image.decode())
    const result=await command(page,'results',{url,prompt:'prompt third',outputType:'post',baseline:[]})
    assert.equal(result.ok,true,result.error);assert.deepEqual(result.value.map(x=>x.id),['third'])
    assert.equal(await page.locator('flow-info-panel .prompt-text').filter({visible:true}).count(),0)
    assert.equal(await page.locator('flow-info-panel').count(),3,'Closed Angular panels may remain in DOM without blocking another result')
    assert.equal(await page.evaluate(()=>window.fixture.submissions),0)
  })
  console.log('Chrome extension DOM regressions passed. Live signed-in Flow and Frame Studio were not tested.')
} finally { await browser.close() }
