// Native Windows driver test in an isolated, routed Chrome window. No user
// profile, real Flow requests, credentials or credits are used.
import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'
import { nativeFlowSubmit } from '../dist-electron/flow-native-submit.cjs'
import {FlowNotSubmittedError} from '../dist-electron/storage/errors.cjs'
const url='https://flow.google.com/project/frame-native-submit-fixture'
const browser=await chromium.launch({channel:'chrome',headless:false,chromiumSandbox:true,ignoreDefaultArgs:['--unsafely-disable-devtools-self-xss-warnings']})
try {
  const page=await browser.newPage()
  await page.route('**/*',route=>route.request().url()===url?route.fulfill({contentType:'text/html',body:'<!doctype html><title>Frame Studio native submit test</title><button aria-label="Start generation">Start generation</button><script>window.clicks=0;document.querySelector("button").onclick=e=>{window.clicks++;window.trusted=e.isTrusted}</script>'}):route.abort())
  await page.goto(url);await page.bringToFront()
  const submit=nativeFlowSubmit(path.resolve('electron/flow-native-submit.ps1'))
  await assert.rejects(()=>submit(url+'-wrong-project','Frame Studio native submit test'),error=>error instanceof FlowNotSubmittedError&&/not displaying the paired/.test(error.message))
  assert.equal(await page.evaluate(()=>window.clicks),0)
  await submit(url,'Frame Studio native submit test')
  await page.waitForFunction(()=>window.clicks===1)
  assert.deepEqual(await page.evaluate(()=>({clicks:window.clicks,trusted:window.trusted})),{clicks:1,trusted:true})
  await page.locator('button').evaluate(button=>button.disabled=true)
  await assert.rejects(()=>submit(url,'Frame Studio native submit test'),error=>error instanceof FlowNotSubmittedError&&/not uniquely visible/.test(error.message))
  assert.equal(await page.evaluate(()=>window.clicks),1)
  console.log('PASS Windows native Chrome activation: trusted click, exact project URL, disabled-button refusal, one activation. No live generation or credits.')
}finally{await browser.close()}
