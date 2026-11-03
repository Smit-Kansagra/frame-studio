import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'vite'

const require = createRequire(import.meta.url)
const compile = spawn(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.electron.json'], { stdio: 'inherit' })
const compileCode = await new Promise((resolve, reject) => {
  compile.once('error', reject)
  compile.once('exit', resolve)
})
if (compileCode !== 0) process.exit(compileCode ?? 1)

const server = await createServer()
await server.listen()
const electronEnvironment = { ...process.env, FRAME_STUDIO_DEV_URL: 'http://127.0.0.1:5173' }
delete electronEnvironment.ELECTRON_RUN_AS_NODE
const desktop = spawn(require('electron'), ['.'], { stdio: 'inherit', env: electronEnvironment })
let closing = false
async function close(code = 0) {
  if (closing) return
  closing = true
  desktop.kill()
  await server.close()
  process.exit(code)
}
desktop.once('error', (error) => { console.error(error); void close(1) })
desktop.once('exit', (code) => { void close(code ?? 0) })
process.once('SIGINT', () => { void close() })
process.once('SIGTERM', () => { void close() })
console.log('Frame Studio is opening. Close its window or press Ctrl+C to stop.')
