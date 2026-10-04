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
  /** 0 ok, 2 not permitted, 3 not found, 4 the app did not respond, -1 no helper. */
  code: number
  detail: string
}

export function helperPath(): string | null {
  const candidates = [
    process.env.ATTIC_MESSAGES_HELPER,
    join(dirname(process.execPath), 'attic-messages'),
    join(import.meta.dir, '..', '..', 'storage', 'attic', 'bin', 'attic-messages'),
  ]
  return candidates.find(path => !!path && existsSync(path)) ?? null
}

async function run(args: string[]): Promise<ControlOutcome> {
  const helper = helperPath()
  if (!helper)
    return { ok: false, code: -1, detail: 'The Messages helper is missing from this build.' }
  const child = Bun.spawn([helper, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { ok: code === 0, code, detail: (code === 0 ? out : err).trim() }
}

/** Whether Attic may drive Messages; `prompt` raises macOS' own request. */
export async function accessibilityTrusted(prompt = false): Promise<boolean> {
  return (await run(prompt ? ['trusted', '--prompt'] : ['trusted'])).ok
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
