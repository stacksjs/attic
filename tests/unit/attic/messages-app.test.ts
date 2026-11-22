import { afterEach, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const directories: string[] = []
afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

async function fixture(helperBody: string, task: string) {
  const dir = mkdtempSync(join(tmpdir(), 'attic-control-'))
  directories.push(dir)
  const helper = join(dir, 'helper')
  writeFileSync(helper, `#!/bin/sh\ncd '${dir}'\n${helperBody}\n`)
  chmodSync(helper, 0o755)
  const script = join(dir, 'parent.ts')
  const module = resolve(import.meta.dir, '../../../app/Attic/messages-app.ts')
  // `waitForHelper` re-stats the path on every poll. A `BunFile` holds on to
  // the stat it took, including the one that found nothing, so a single
  // instance polled in a loop never sees the helper's file appear.
  writeFileSync(script, `import { accessibilityTrusted, removeFromMessages, stopMessagesControl, withBackgroundMessages, MessagesControlDeferred } from ${JSON.stringify(module)}
import { existsSync } from 'node:fs'
import { join } from 'node:path'
async function waitForHelper(name) {
  const path = join(${JSON.stringify(dir)}, name)
  const deadline = Date.now() + 5000
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error('Helper did not start')
    await Bun.sleep(5)
  }
}
${task}
`)
  const child = Bun.spawn([process.execPath, script], {
    env: { ...process.env, ATTIC_MESSAGES_HELPER: helper },
    stdout: 'pipe', stderr: 'pipe',
  })
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(err).toBe('')
  expect(code).toBe(0)
  return { dir, out }
}

it('finishes one native operation before starting the next', async () => {
  const { out } = await fixture(
    'mkdir busy 2>/dev/null || exit 9\nsleep 0.1\nrmdir busy\necho done',
    `const results = await Promise.all([removeFromMessages(['Alice'], null, true), removeFromMessages(['Bob'], null, true)])
console.log(JSON.stringify(results.map(result => result.ok)))`,
  )
  expect(JSON.parse(out)).toEqual([true, true])
})

it('can read Accessibility status while a native operation is waiting', async () => {
  const { out } = await fixture(
    'if [ "$1" = "trusted" ]; then exit 0; fi\ntouch started\nsleep 1',
    `let finished = false
const removal = removeFromMessages(['Alice'], null, true).then(() => { finished = true })
await waitForHelper('started')
console.log(JSON.stringify([await accessibilityTrusted(), finished]))
stopMessagesControl()
await removal`,
  )
  expect(JSON.parse(out)).toEqual([true, false])
})

it('does not leave a helper running after Attic exits', async () => {
  const { dir } = await fixture(
    'touch started\nsleep 0.3\ntouch orphaned',
    `void removeFromMessages(['Alice'], null, true)
await waitForHelper('started')
process.exit(0)`,
  )
  await Bun.sleep(400)
  expect(existsSync(join(dir, 'orphaned'))).toBe(false)
})

it('cancels queued operations when Attic closes', async () => {
  const { dir, out } = await fixture(
    'echo "$3" >> started\nsleep 0.3',
    `const first = removeFromMessages(['Alice'], null, true)
const second = removeFromMessages(['Bob'], null, true)
await waitForHelper('started')
stopMessagesControl()
console.log(JSON.stringify((await Promise.all([first, second])).map(result => result.ok)))`,
  )
  expect(JSON.parse(out)).toEqual([false, false])
  expect(readFileSync(join(dir, 'started'), 'utf8').trim()).toBe('Alice')
})

it('keeps background restrictions separate from concurrent explicit actions, including after deferral', async () => {
  const { out } = await fixture(
    'for arg do\n  if [ "$arg" = "--background" ]; then exit 5; fi\ndone\necho explicit',
    `const automatic = withBackgroundMessages(() => removeFromMessages(['Alice'], null, true))
  .catch(error => error instanceof MessagesControlDeferred ? 'deferred' : 'unexpected')
const explicit = removeFromMessages(['Bob'], null, true)
console.log(JSON.stringify([await automatic, (await explicit).detail]))`,
  )
  expect(JSON.parse(out)).toEqual(['deferred', 'explicit'])
})
