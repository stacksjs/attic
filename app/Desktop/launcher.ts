/* eslint-disable no-console */
/**
 * `Attic.app/Contents/MacOS/Attic`, compiled by `buddy build:desktop`.
 *
 * One process owns everything that needs a permission. It reads Messages and
 * Contacts (Full Disk Access is granted to Attic.app, and this is its
 * executable), keeps the archive, and opens conversations in Messages. The
 * Craft runtime beside it draws the window and talks back to this process
 * over 127.0.0.1.
 *
 * Run from source for development with `bun run app`, which builds the UI
 * first; Craft then comes from CRAFT_BIN or PATH (pantry installs it).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { format } from 'node:util'
import pkg from '../../package.json'
import { startAgent } from '../Attic/agent'
import { stopMessagesControl } from '../Attic/messages-app'
import { DATA_DIR, LOCK_FILE, LOG_FILE } from '../Attic/paths'

const IN_APP_BUNDLE = process.execPath.includes('.app/Contents/MacOS/')

// Launched from Finder there is no terminal, so keep a log where Console.app
// looks for one. From a terminal the developer keeps stderr.
if (!process.stdout.isTTY) {
  mkdirSync(dirname(LOG_FILE), { recursive: true })
  for (const level of ['log', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => {
      try {
        appendFileSync(LOG_FILE, `${new Date().toISOString()} ${format(...args)}\n`)
      }
      catch {}
    }
  }
}

/** True if another live Attic holds the lock; otherwise takes it. */
function acquireSingleInstance(): boolean {
  mkdirSync(DATA_DIR, { recursive: true })
  if (existsSync(LOCK_FILE)) {
    const pid = Number(readFileSync(LOCK_FILE, 'utf8'))
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0)
        return false
      }
      catch {
        // A stale lock from a crash.
      }
    }
  }
  writeFileSync(LOCK_FILE, String(process.pid))
  return true
}

function releaseSingleInstance(): void {
  try {
    if (readFileSync(LOCK_FILE, 'utf8') === String(process.pid))
      rmSync(LOCK_FILE)
  }
  catch {}
}

function craftRuntime(): string {
  const bundled = join(dirname(process.execPath), 'craft-runtime')
  if (existsSync(bundled))
    return bundled
  const found = process.env.CRAFT_BIN || join(import.meta.dir, '../../storage/attic/native/craft-native-macos')
  if (!existsSync(found))
    throw new Error('Craft AppKit runtime not found: run `bun run build:native` or set CRAFT_BIN.')
  return found
}

/** The built UI: inside the bundle, or `bun run build:ui` output in a checkout. */
function webRoot(): string {
  if (process.env.ATTIC_WEB_ROOT)
    return process.env.ATTIC_WEB_ROOT
  if (IN_APP_BUNDLE)
    return join(dirname(dirname(process.execPath)), 'Resources', 'web')
  return join(import.meta.dir, '..', '..', 'storage', 'attic', 'web')
}

if (!acquireSingleInstance()) {
  console.log('[attic] already running')
  process.exit(0)
}

const root = webRoot()
if (!existsSync(join(root, 'index.html'))) {
  console.error(`[attic] no UI at ${root}: run \`bun run build:ui\` first.`)
  releaseSingleInstance()
  process.exit(1)
}

const agent = await startAgent({ webRoot: root, version: pkg.version }).catch((error: unknown) => {
  console.error(`[attic] could not start: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  releaseSingleInstance()
  return process.exit(1)
})
console.log(`[attic] ${pkg.version} serving on 127.0.0.1:${agent.port}`)

const runtime = craftRuntime()
const nativeBundle = IN_APP_BUNDLE
  ? join(dirname(dirname(process.execPath)), 'Resources', 'native-screen.js')
  : join(import.meta.dir, '../../storage/attic/native/native-screen.js')
if (!existsSync(nativeBundle)) {
  console.error('[attic] native UI is missing: run `bun run build:native` first.')
  agent.stop(); releaseSingleInstance(); process.exit(1)
}
const flags = [
  '--api-url', `http://127.0.0.1:${agent.port}`,
  '--native-bundle', nativeBundle,
  '--title',
  'Attic',
  '--titlebar-style', 'transparent',
  '--width', '1280',
  '--height', '800',
  '--min-width', '900',
  '--min-height', '560',
]
// Native control automation is available only for an explicitly isolated fixture.
if (process.env.ATTIC_MESSAGES_DB && process.env.ATTIC_NATIVE_TEST_DIR)
  flags.push('--test-dir', process.env.ATTIC_NATIVE_TEST_DIR)

const craft = Bun.spawn([runtime, ...flags], { stdio: ['ignore', 'ignore', 'pipe'] })
void new Response(craft.stderr).text().then((stderr) => {
  const lines = stderr.split('\n').filter(line => line.trim() && !line.startsWith('[ContextMenu]'))
  if (lines.length > 0)
    console.error(`[craft] ${lines.join('\n')}`)
})

let stopping = false
function shutdown(code: number): never {
  if (!stopping) {
    stopping = true
    stopMessagesControl()
    craft.kill()
    agent.stop()
    releaseSingleInstance()
  }
  process.exit(code)
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
  process.on(signal, () => shutdown(0))

const exitCode = await craft.exited
console.log(`[attic] window closed (${exitCode})`)
shutdown(0)
