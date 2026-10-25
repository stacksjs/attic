/* eslint-disable no-console */
/** Drive the installed app's AppKit controls with invented conversations. */
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { buildSample } from './sample'

interface Node { id: string, type: string, nativeClass: string, value?: string, label?: string, editorClass?: string, enabled?: boolean, visible: boolean, frame: number[], windowFrame?: number[], visibleRect?: number[], style?: Record<string, unknown> }
interface Window { name: string, title: string, contextClass: string, nodes: Node[], errors: string[], viewClasses: string[] }
interface Snapshot { renderer: string, scriptEngine: string, appearance: string, windows: Window[], webViews: number }
const output = join(import.meta.dir, '../storage/attic/e2e-native')
mkdirSync(output, { recursive: true })
const run = mkdtempSync(join(output, 'run-'))
const sample = await buildSample(join(run, 'sample'))
const driver = join(run, 'driver')
mkdirSync(driver)
const app = process.env.ATTIC_E2E_APP || join(homedir(), 'Applications/Attic.app')
const executable = join(app, 'Contents/MacOS/Attic')
if (!existsSync(executable)) throw new Error(`Install the DMG first: ${app}`)
const child = Bun.spawn([executable], {
  env: { ...process.env, ATTIC_MESSAGES_DB: sample.chatDb, ATTIC_ADDRESS_BOOK_DIR: sample.addressBook, ATTIC_DATA_DIR: sample.data, ATTIC_NATIVE_TEST_DIR: driver },
  stdout: 'ignore', stderr: 'inherit',
})
const checks: string[] = []
let sequence = 0
async function state(): Promise<Snapshot | null> {
  try { return await Bun.file(join(driver, 'state.json')).json() }
  catch { return null }
}
async function wait(label: string, predicate: (state: Snapshot) => boolean, timeout = 30000): Promise<Snapshot> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`App exited (${child.exitCode}) while waiting for ${label}`)
    const value = await state()
    if (value) {
      const errors = value.windows.flatMap(w => w.errors)
      if (errors.length) throw new Error(`Native script errors: ${errors.join('\n')}`)
      if (predicate(value)) { checks.push(label); console.log(`PASS ${label}`); return value }
    }
    await Bun.sleep(100)
  }
  throw new Error(`Timed out: ${label}. Snapshot: ${JSON.stringify(await state())}`)
}
function window(s: Snapshot, name = 'main'): Window | undefined { return s.windows.find(w => w.name === name) }
function node(s: Snapshot, id: string, name = 'main'): Node | undefined { return window(s, name)?.nodes.find(n => n.id === id) }
async function action(action: string, target?: string, value?: string, name = 'main'): Promise<void> {
  const id = String(++sequence).padStart(4, '0')
  await Bun.write(join(driver, `action-${id}.json`), JSON.stringify({ action, target, value, window: name, ...(action === 'command' ? { id: target } : {}), ...(action === 'resize' ? {width:Number(target),height:Number(value)} : {}) }))
  for (let i = 0; i < 100; i++) {
    const file = Bun.file(join(driver, `result-${id}.json`))
    if (await file.exists()) {
      const result = await file.json()
      if (!result.ok) throw new Error(`Native action failed: ${JSON.stringify(result)}`)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error(`Native action did not finish: ${action} ${target}`)
}
try {
  await wait('AppKit and zig-js boot without a WebView', s => s.renderer === 'appkit' && s.scriptEngine === 'zig-js' && window(s)?.contextClass === 'ZigJSContext' && s.webViews === 0 && !!node(s, 'conversation-title')?.value)
  await wait('Conversation count renders', s => !!window(s)?.nodes.some(n => n.value === '13 conversations'))
  const initial = await state()
  const sam = window(initial!)!.nodes.find(n => n.id.startsWith('row-') && n.id.includes('14155550178'))
  if (!sam) throw new Error('Sample Sam Rivera conversation is missing')
  await action('click', sam.id)
  await wait('Native transcript shows Sam Rivera', s => node(s, 'conversation-title')?.value === 'Sam Rivera' && !!window(s)?.nodes.some(n => n.nativeClass === 'NSTextField' && n.value?.includes('couch')))
  await wait('Native composer uses NSTextView', s => node(s, 'composer')?.editorClass?.endsWith('CraftMacTextView') === true)
  await action('appearance', undefined, 'light')
  await wait('Native light appearance applies', s => s.appearance === 'light' && node(s, 'transcript-pane')?.style?.backgroundColor === '#ffffff')
  await action('fill', 'composer', 'A sample draft for native editing')
  await wait('Native draft editing updates Send', s => node(s, 'composer')?.value === 'A sample draft for native editing' && node(s, 'send')?.enabled === true)
  await action('screenshot')
  await action('appearance', undefined, 'dark')
  await wait('Native dark appearance applies', s => s.appearance === 'dark' && node(s, 'transcript-pane')?.style?.backgroundColor === '#1e1e20' && (node(s,'mailboxes')?.frame[3] ?? 0) > 500)
  await action('screenshot')
  await action('click', 'archive')
  await wait('Archive completes', s => !!node(s, 'status-message')?.value?.includes('messages kept'))
  await action('pick', 'mailboxes', 'archived')
  await wait('Archive appears in the native sidebar', s => node(s, 'mailboxes')?.value === 'archived' && !!node(s, sam.id))
  await action('fill', 'search', 'couch')
  const search = await wait('Native search finds saved messages', s => node(s, 'search')?.nativeClass === 'NSSearchField' && !!window(s)?.nodes.some(n => n.id.startsWith('result-') && n.visible))
  const hit = window(search)!.nodes.find(n => n.id.startsWith('result-') && n.visible)!
  await action('click', hit.id)
  await wait('Search opens the native archived transcript', s => node(s, 'conversation-title')?.value === 'Sam Rivera' && !!node(s, 'restore'))
  await action('click', 'restore')
  await action('pick', 'mailboxes', 'all')
  await wait('Restore returns the conversation to Inbox', s => !!node(s, sam.id) && node(s, 'mailboxes')?.value === 'all')
  await action('command', 'settings')
  await wait('Settings opens with native popup controls', s => node(s, 'resurface', 'settings')?.nativeClass === 'NSPopUpButton' && node(s, 'removal', 'settings')?.nativeClass === 'NSPopUpButton' && node(s, 'removal', 'settings')?.enabled === true)
  await action('screenshot', undefined, undefined, 'settings')
  await action('appearance', undefined, 'light')
  await wait('Settings light appearance applies', s => s.appearance === 'light')
  await action('screenshot', undefined, undefined, 'settings')
  await action('appearance', undefined, 'dark')
  await action('pick', 'resurface', 'stay', 'settings')
  await wait('Resurface setting finishes saving before another edit', s => node(s,'resurface','settings')?.value === 'stay' && node(s,'removal','settings')?.enabled === true && node(s,'settings-note','settings')?.value === 'Settings saved.')
  await action('pick', 'removal', 'off', 'settings')
  await wait('Settings changes persist', s => node(s, 'resurface', 'settings')?.value === 'stay' && node(s, 'removal', 'settings')?.value === 'off' && node(s, 'settings-note', 'settings')?.value === 'Settings saved.')
  await action('close', undefined, undefined, 'settings')
  await wait('Settings disposes its window', s => !window(s, 'settings'))
  await action('command', 'settings')
  await wait('Reopened Settings restores saved values', s => node(s, 'resurface', 'settings')?.value === 'stay' && node(s, 'removal', 'settings')?.value === 'off')
  await action('close', undefined, undefined, 'settings')
  await action('click', 'cleanup')
  await wait('Clean Up opens a sheet sized to its content', s => !!node(s, 'cleanup-dialog')?.visible && node(s, 'cleanup-dialog')!.frame[3]! >= 290)
  await action('click', 'cleanup-close')
  await action('pick', 'mailboxes', 'all')
  const rosa = window((await state())!)!.nodes.find(n => n.id.startsWith('row-whatsapp:15550007777'))
  if (!rosa) throw new Error('Sample Rosa conversation is missing')
  await action('click', rosa.id)
  await wait('Source badges and the selected conversation remain visible', s => node(s,'conversation-title')?.value === 'Rosa Lindqvist' && node(s,rosa.id)?.visible === true)
  await action('resize', '900', '660')
  await wait('Three panes remain usable in a smaller window', s => node(s,'main-shell')?.frame[2] === 900 && (node(s,'transcript-pane')?.frame[2] ?? 0) >= 340)
  await action('resize', '1120', '740')
  await action('appearance', undefined, 'light')
  await wait('Light inbox surfaces settle before capture', s => s.appearance === 'light' && node(s,'transcript-pane')?.style?.backgroundColor === '#ffffff')
  await Bun.sleep(1000)
  await action('screenshot')
  await action('appearance', undefined, 'dark')
  await wait('Dark inbox surfaces settle before capture', s => s.appearance === 'dark' && node(s,'transcript-pane')?.style?.backgroundColor === '#1e1e20' && (node(s,'mailboxes')?.frame[3] ?? 0) > 500)
  await Bun.sleep(1000)
  await action('screenshot')
  const final = await state()
  const artifacts = await Promise.all(['Contents/MacOS/Attic', 'Contents/MacOS/craft-runtime', 'Contents/Resources/native-screen.js'].map(async path => {
    const file = Bun.file(join(app, path))
    return { path, sha256: new Bun.CryptoHasher('sha256').update(await file.bytes()).digest('hex') }
  }))
  await Bun.write(join(output, 'report.json'), JSON.stringify({ app, run, checks, artifacts, snapshot: final }, null, 2))
  console.log(`Native E2E passed. Report: ${join(output, 'report.json')}`)
  if (process.argv.includes('--keep-open')) { console.log(`Fixture is open. Driver: ${driver}`); await child.exited }
}
finally { child.kill(); await child.exited }
