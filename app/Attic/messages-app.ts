import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'

/**
 * Messages' own Delete and Recover, and WhatsApp's own Archive and Unarchive,
 * driven through `attic-messages` (app/Desktop/messages-control.swift), which
 * acts on the row found by name in the app's accessibility tree. It runs as a
 * child of Attic, so macOS charges it to Attic's Accessibility permission.
 */

export interface ControlOutcome {
  ok: boolean
  /** 0 ok, 2 not permitted, 3 not found, 4 not responding, 5 deferred, -1 unavailable. */
  code: number
  detail: string
}

// Keep the policy with the async operation: a simultaneous Archive click
// must not inherit a background sync's restrictions (or the other way round).
const backgroundControl = new AsyncLocalStorage<boolean>()
let pending: Promise<unknown> = Promise.resolve()
const active = new Set<ReturnType<typeof Bun.spawn>>()
let stopped = false

export class MessagesControlDeferred extends Error {}

export function withBackgroundMessages<T>(task: () => Promise<T>): Promise<T> {
  return backgroundControl.run(true, task)
}

/** The driver's unnamed-group fallback must obey the same policy as the helper. */
export function openMessagesUrl(url: string): void {
  if (backgroundControl.getStore())
    throw new MessagesControlDeferred('Opening a conversation waits for an explicit archive.')
  if (!stopped)
    Bun.spawn(['/usr/bin/open', url], { stdio: ['ignore', 'ignore', 'ignore'] })
}

/** Cancel native automation before closing the archive and exiting Attic. */
export function stopMessagesControl(): void {
  stopped = true
  for (const child of active)
    child.kill()
}

process.once('exit', stopMessagesControl)

export function helperPath(): string | null {
  const candidates = [
    process.env.ATTIC_MESSAGES_HELPER,
    join(dirname(process.execPath), 'attic-messages'),
    join(import.meta.dir, '..', '..', 'storage', 'attic', 'bin', 'attic-messages'),
  ]
  return candidates.find(path => !!path && existsSync(path)) ?? null
}

async function execute(args: string[], background: boolean): Promise<ControlOutcome> {
  if (stopped)
    return { ok: false, code: -1, detail: 'Chatfold is closing.' }
  const helper = helperPath()
  if (!helper)
    return { ok: false, code: -1, detail: 'The Messages helper is missing from this build.' }
  const child = Bun.spawn([helper, ...args, ...(background ? ['--background'] : [])], { stdio: ['ignore', 'pipe', 'pipe'] })
  active.add(child)
  const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000)
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (background && code === 5)
      throw new MessagesControlDeferred(err.trim())
    return { ok: code === 0, code, detail: (code === 0 ? out : err).trim() }
  }
  finally {
    clearTimeout(timeout)
    active.delete(child)
  }
}

function run(args: string[]): Promise<ControlOutcome> {
  const background = !!backgroundControl.getStore()
  // Accessibility actions change shared app state. Concurrent callers must
  // never press each other's confirmation buttons or switch each other's view.
  const result = pending.then(() => execute(args, background))
  pending = result.catch(() => {})
  return result
}

/** Whether Attic may drive Messages; `prompt` raises macOS' own request. */
export async function accessibilityTrusted(prompt = false): Promise<boolean> {
  // Status reads never drive another app and must not wait on its UI.
  return (await (prompt ? run(['trusted', '--prompt']) : execute(['trusted'], false))).ok
}

export function removeFromMessages(names: string[], url: string | null, confirm: boolean): Promise<ControlOutcome> {
  return run(['delete', ...names.flatMap(name => ['--name', name]), ...(url ? ['--url', url] : []), ...(confirm ? ['--confirm'] : [])])
}

export function recoverInMessages(names: string[]): Promise<ControlOutcome> {
  return run(['recover', ...names.flatMap(name => ['--name', name])])
}

export function archiveInWhatsApp(names: string[]): Promise<ControlOutcome> {
  return run(['whatsapp-archive', ...names.flatMap(name => ['--name', name])])
}

export function unarchiveInWhatsApp(names: string[]): Promise<ControlOutcome> {
  return run(['whatsapp-unarchive', ...names.flatMap(name => ['--name', name])])
}
