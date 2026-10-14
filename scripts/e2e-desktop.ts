/* eslint-disable no-console */
/** Exercise the installed signed bundle and its STX UI with isolated sample data. */
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { buildSample } from './sample'

const root = join(import.meta.dir, '..')
const app = process.env.ATTIC_E2E_APP || join(homedir(), 'Applications/Attic.app')
const executable = join(app, 'Contents/MacOS/Attic')
if (!existsSync(executable))
  throw new Error(`Install the DMG first, or set ATTIC_E2E_APP: ${app}`)

const output = join(root, 'storage/attic/e2e')
mkdirSync(output, { recursive: true })
const sample = await buildSample(mkdtempSync(join(output, 'sample-')))
const child = Bun.spawn([executable], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...process.env, ATTIC_MESSAGES_DB: sample.chatDb, ATTIC_ADDRESS_BOOK_DIR: sample.addressBook, ATTIC_DATA_DIR: sample.data },
})

try {
  let port = ''
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null)
      throw new Error(`Installed Attic exited before becoming ready (${child.exitCode}).`)
    const file = Bun.file(join(sample.data, 'port'))
    if (await file.exists()) {
      port = (await file.text()).trim()
      break
    }
    await Bun.sleep(200)
  }
  if (!/^\d+$/.test(port))
    throw new Error('Installed Attic did not become ready within 30 seconds.')
  const url = `http://127.0.0.1:${port}`
  console.log(`Installed bundle: ${app}\nFixture URL: ${url}\nFixture data: ${sample.data}`)

  async function scenario(name: string, route: string, steps: object[], scheme = 'light'): Promise<void> {
    if (process.argv.includes('--native-only'))
      return
    const command = [
      'bun', 'storage/framework/defaults/ai/skills/stacks-browse/scripts/browse.ts', 'scenario', `${url}${route}`,
      '--viewport', '1120x740', '--settle', '2500', '--scheme', scheme, '--out', join(output, `${name}.png`),
      ...steps.flatMap(step => ['--step', JSON.stringify({ settle: 1000, ...step })]),
    ]
    for (let attempt = 0; attempt < 2; attempt++) {
      const run = Bun.spawn(command, { cwd: root, stdout: 'pipe', stderr: 'pipe' })
      const [stdout, stderr, exitCode] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
      await Bun.write(join(output, `${name}.json`), stdout)
      if (exitCode === 0) {
        console.log(`PASS ${name}`)
        return
      }
      // A browser startup failure precedes every step, so it is safe to retry.
      if (attempt === 0 && stderr.includes('Could not launch any browser'))
        continue
      throw new Error(`${name} failed:\n${stdout}\n${stderr}`)
    }
  }

  await scenario('archive-search-restore', '/app?presentation', [
    { action: 'assert', selector: '[aria-label=Conversations]', text: 'All Inboxes' },
    { action: 'click', selector: '[role=option]', text: 'Sam Rivera' },
    { action: 'assert', selector: '[aria-label=Transcript]', text: 'couch' },
    { action: 'click', selector: 'button[title^="Archive:"]' },
    { action: 'click', selector: 'nav button', text: 'Archived' },
    { action: 'assert', selector: '[role=option]', text: 'Sam Rivera' },
    { action: 'fill', selector: '#search', value: 'couch' },
    { action: 'assert', selector: '.row', text: 'Sam Rivera' },
    { action: 'click', selector: '.row', text: 'Sam Rivera' },
    { action: 'assert', selector: '[aria-label=Transcript]', text: 'couch' },
    { action: 'click', selector: 'button[title^="Move to Inbox"]' },
    { action: 'click', selector: 'nav button', text: 'All Inboxes' },
    { action: 'assert', selector: '[role=option]', text: 'Sam Rivera' },
  ])
  await scenario('sources-and-dark-mode', '/app?presentation', [
    { action: 'click', selector: 'nav button', text: 'Slack' },
    { action: 'click', selector: '[role=option]', text: 'Priya Nair' },
    { action: 'assert', selector: '[aria-label=Transcript]', text: 'Priya Nair' },
    { action: 'click', selector: 'nav button', text: 'iMessage' },
    { action: 'click', selector: '[role=option]', text: 'Climbing crew' },
    { action: 'assert', selector: '[aria-label=Transcript]', text: 'That one is going to hurt' },
    { action: 'assert', selector: 'img[alt="IMG_2041.svg"]' },
  ], 'dark')
  await scenario('settings', '/settings', [
    { action: 'assert', selector: 'main', text: 'When someone writes again' },
    { action: 'assert', selector: 'select[aria-label="When you archive"]' },
    { action: 'assert', selector: 'main', text: 'Phone' },
  ])
  if (process.argv.includes('--keep-open') || process.argv.includes('--native-only')) {
    console.log('Native fixture window is ready for UI testing. Quit Attic to finish.')
    await child.exited
  }
}
finally {
  child.kill()
  await child.exited
}
