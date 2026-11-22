/* eslint-disable no-console */
/** Drive the installed app's AppKit controls with invented conversations. */
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import pkg from '../package.json'
import { buildSample } from './sample'

interface Node { id: string, type: string, nativeClass: string, value?: string, label?: string, editorClass?: string, enabled?: boolean, visible: boolean, frame: number[], windowFrame?: number[], visibleRect?: number[], style?: Record<string, unknown> }
interface Window { name: string, title: string, contextClass: string, nodes: Node[], errors: string[], viewClasses: string[] }
interface Snapshot { renderer: string, scriptEngine: string, appearance: string, windows: Window[], webViews: number }
const output = join(import.meta.dir, '../storage/attic/e2e-native')
mkdirSync(output, { recursive: true })
const run = mkdtempSync(join(output, 'run-'))
const sample = await buildSample(join(run, 'sample'), { olderSam: true })
const driver = join(run, 'driver')
mkdirSync(driver)
const app = process.env.ATTIC_E2E_APP || (existsSync('/Applications/Texts.app') ? '/Applications/Texts.app' : join(homedir(), 'Applications/Texts.app'))
const updateFrom = process.env.ATTIC_E2E_UPDATE_FROM
if (updateFrom && (!process.env.ATTIC_E2E_APP || !realpathSync(app).startsWith(`${realpathSync(join(import.meta.dir, '../storage'))}/`)))
  throw new Error('Use an isolated app in storage for the update installation test.')
const runningVersion = updateFrom || pkg.version
if (!existsSync(app)) throw new Error(`Install the DMG first: ${app}`)
const plist = join(app, 'Contents/Info.plist')
const readInfo = (key: string) => Bun.spawnSync(['/usr/libexec/PlistBuddy', '-c', `Print ${key}`, plist]).stdout.toString().trim()
const executable = join(app, 'Contents/MacOS', readInfo('CFBundleExecutable'))
const displayName = readInfo('CFBundleDisplayName')
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
    if (child.exitCode !== null) throw new Error(`App exited (${child.exitCode}) during ${action} ${target ?? ''}`)
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
  await wait('The inbox and its actions render', s => node(s, 'mailbox-title')?.value === 'Inbox' && node(s, 'sources-menu')?.visible === true && node(s, 'conversation-actions')?.visible === true)
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
  await action('fill', 'search', 'no fixture message matches this')
  await wait('A completed search can show an empty state', s => node(s, 'search-status')?.value === 'No matching messages.')
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
  await wait('Resurface setting finishes saving before another edit', s => node(s,'resurface','settings')?.value === 'stay' && node(s,'removal','settings')?.enabled === true)
  await action('pick', 'removal', 'off', 'settings')
  await wait('Settings changes complete without a persistent status banner', s => node(s, 'resurface', 'settings')?.value === 'stay' && node(s, 'removal', 'settings')?.value === 'off' && node(s, 'removal', 'settings')?.enabled === true && !node(s, 'settings-note', 'settings')?.visible)
  await action('click', 'settings-item-rules', undefined, 'settings')
  await wait('Settings sidebar opens Always Archive', s => !!window(s, 'settings')?.nodes.some(n => n.visible && n.value === 'No rules yet') && !node(s, 'removal', 'settings')?.visible)
  await action('click', 'settings-item-phone', undefined, 'settings')
  await wait('Settings sidebar opens Phone', s => node(s, 'pair-phone', 'settings')?.visible === true)
  await action('click', 'settings-item-about', undefined, 'settings')
  await wait('About shows the running Attic version', s => node(s, 'settings-version', 'settings')?.value === runningVersion && node(s, 'settings-version', 'settings')?.visible === true)
  await action('click', 'settings-item-updates', undefined, 'settings')
  const updatePane = await wait('Software Update shows the running version and a check button', s => {
    const nodes = window(s, 'settings')?.nodes.filter(n => n.visible) ?? []
    return nodes.some(n => n.value === `${displayName} ${runningVersion}`) && nodes.some(n => n.label === 'Check Now' && n.enabled)
  })
  if (updateFrom) {
    const check = window(updatePane, 'settings')!.nodes.find(n => n.label === 'Check Now' && n.visible)!
    await action('click', check.id, undefined, 'settings')
    const available = await wait('GitHub offers the signed update', s => {
      const nodes = window(s, 'settings')?.nodes.filter(n => n.visible) ?? []
      return nodes.some(n => n.value === `Version ${pkg.version} is available.`) && nodes.some(n => n.label === 'Download and Install' && n.enabled)
    })
    const install = window(available, 'settings')!.nodes.find(n => n.label === 'Download and Install' && n.visible)!
    await action('click', install.id, undefined, 'settings')
    await wait('The downloaded update replaces the app and offers to restart', s => !!window(s, 'settings')?.nodes.some(n => n.label === 'Restart to Update' && n.visible && n.enabled), 60_000)
    const installed = Bun.spawnSync(['/usr/libexec/PlistBuddy', '-c', 'Print CFBundleShortVersionString', join(app, 'Contents/Info.plist')])
    if (installed.exitCode !== 0 || installed.stdout.toString().trim() !== pkg.version)
      throw new Error('The downloaded app has the wrong version')
    if (Bun.spawnSync(['/usr/bin/codesign', '--verify', '--deep', '--strict', app]).exitCode !== 0)
      throw new Error('The downloaded app signature did not verify')
  }
  await action('click', 'settings-item-about', undefined, 'settings')
  const settingsSearch = window((await state())!, 'settings')?.nodes.find(n => n.nativeClass === 'NSSearchField' && n.visible)
  if (!settingsSearch) throw new Error('Native Settings search field is missing')
  await action('fill', settingsSearch.id, 'when you archive', 'settings')
  await wait('Settings search finds the Archive preference', s => !!window(s, 'settings')?.nodes.some(n => n.visible && n.value === 'When you archive'))
  await action('fill', settingsSearch.id, '', 'settings')
  await action('click', 'settings-item-archiving', undefined, 'settings')
  await wait('Settings sidebar returns to Archiving', s => node(s, 'removal', 'settings')?.visible === true)
  await action('close', undefined, undefined, 'settings')
  await wait('Settings disposes its window', s => !window(s, 'settings'))
  await action('command', 'settings')
  await wait('Reopened Settings restores saved values', s => node(s, 'resurface', 'settings')?.value === 'stay' && node(s, 'removal', 'settings')?.value === 'off')
  await action('close', undefined, undefined, 'settings')
  await action('click', 'cleanup')
  await wait('Clean Up opens a native window and counts conversations', s => node(s, 'cleanup-window', 'cleanup')?.visible === true && node(s, 'cleanup-heading', 'cleanup')?.value === 'Archive from Inbox' && node(s, 'cleanup-count', 'cleanup')?.value === '0 conversations')
  await action('pick', 'cleanup-cutoff', '182', 'cleanup')
  await wait('Clean Up updates the archive preview for another cutoff', s => node(s, 'cleanup-cutoff', 'cleanup')?.value === '182' && node(s, 'cleanup-count', 'cleanup')?.value === '1 conversation' && node(s, 'cleanup-start', 'cleanup')?.enabled === true)
  await action('screenshot', undefined, undefined, 'cleanup')
  await action('click', 'cleanup-start', undefined, 'cleanup')
  await wait('Clean Up archives the matching conversation and refreshes the preview', s => node(s, 'cleanup-count', 'cleanup')?.value === '0 conversations' && !!window(s, 'cleanup')?.nodes.some(n => n.visible && n.value === '1 of 1 processed. 1 archived.'))
  await action('click', 'cleanup-close', undefined, 'cleanup')
  await wait('Closing Clean Up returns to the main window', s => !window(s, 'cleanup') && !!window(s))
  await action('pick', 'mailboxes', 'source:whatsapp')
  await wait('The WhatsApp inbox is selected', s => node(s, 'mailboxes')?.value === 'source:whatsapp')
  await action('click', 'cleanup')
  await wait('Clean Up uses the selected source', s => node(s, 'cleanup-heading', 'cleanup')?.value === 'Archive from WhatsApp')
  await action('click', 'cleanup-close', undefined, 'cleanup')
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
  const artifacts = await Promise.all([`Contents/MacOS/${readInfo('CFBundleExecutable')}`, 'Contents/MacOS/craft-runtime', 'Contents/Resources/native-screen.js'].map(async path => {
    const file = Bun.file(join(app, path))
    return { path, sha256: new Bun.CryptoHasher('sha256').update(await file.bytes()).digest('hex') }
  }))
  await Bun.write(join(output, 'report.json'), JSON.stringify({ app, run, checks, artifacts, snapshot: final }, null, 2))
  console.log(`Native E2E passed. Report: ${join(output, 'report.json')}`)
  if (process.argv.includes('--keep-open')) { console.log(`Fixture is open. Driver: ${driver}`); await child.exited }
}
finally { child.kill(); await child.exited }
