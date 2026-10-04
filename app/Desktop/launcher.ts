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
  const found = process.env.CRAFT_BIN || Bun.which('craft')
  if (!found)
    throw new Error('Craft runtime not found: set CRAFT_BIN or run `pantry install`.')
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

/**
 * Whether the runtime takes a flag, read from its option table rather than
 * from its version: an unsigned local build reports 0.0.0, and an older
 * runtime given an unknown flag ignores it silently anyway.
 */
function supports(runtime: string, flag: string): boolean {
  return Bun.spawnSync(['grep', '-qa', '--', flag, runtime]).exitCode === 0
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
const flags = [
  `http://127.0.0.1:${agent.port}/`,
  '--title',
  'Attic',
  '--width',
  '1120',
  '--height',
  '740',
]
// The sidebar look: the window buttons over the page's own sidebar, on the
// system's translucent material, the way Mail and Notes are drawn.
if (supports(runtime, '--titlebar-hidden'))
  flags.push('--titlebar-hidden')
if (supports(runtime, '--web-window-material'))
  flags.push('--web-window-material')
// Keep what the page stores (the last selected conversation) across launches.
if (supports(runtime, '--persistent-storage'))
  flags.push('--persistent-storage')
if (supports(runtime, '--frame-autosave'))
  flags.push('--frame-autosave', 'AtticMain')
if (IN_APP_BUNDLE)
  flags.push('--no-devtools')

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
