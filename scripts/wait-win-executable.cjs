// Windows can briefly hold a freshly extracted executable while inspecting it.
// Give the normal file lock time to clear before Electron edits its resources.
// No process, scanner or security setting is changed.
const { open } = require('node:fs/promises')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
module.exports = async context => {
  if (context.electronPlatformName !== 'win32') return
  const executable = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`)
  await delay(4000)
  for (let count = 0; ; count++) {
    try { const file = await open(executable, 'r+'); await file.close(); return }
    catch (error) { if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code) || count >= 20) throw error; await delay(1000) }
  }
}
