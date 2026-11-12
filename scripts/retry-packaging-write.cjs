// Build-process-only retry for transient Windows locks on the output executable.
// Keep integrity generation intact; retry only the same failed write, with the
// original bytes/options. No process, scanner, permission or app setting changes.
const fs = require('node:fs/promises')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const writeFile = fs.writeFile
const release = path.resolve('release') + path.sep
fs.writeFile = async function (file, ...args) {
  const target = typeof file === 'string' ? path.resolve(file) : ''
  const retry = process.platform === 'win32' && target.startsWith(release) && path.basename(path.dirname(target)) === 'win-unpacked' && path.basename(target) === 'Frame Studio.exe'
  const deadline = Date.now() + 90000
  let reported = false
  for (;;) {
    try { return await writeFile.call(fs, file, ...args) }
    catch (error) {
      if (!retry || error.code !== 'EBUSY' || Date.now() >= deadline) throw error
      if (!reported) { console.log('Waiting for Windows to release the packaging executable; integrity bytes are preserved.'); reported = true }
      await delay(1000)
    }
  }
}
