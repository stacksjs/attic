import { expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { compileNativeBundle } from '@stacksjs/stx/native'
import { mountNativeScreen } from '@stacksjs/stx/native/testing'

it('shows only available reply actions and keeps the composer model connected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'attic-composer-'))
  const app = resolve(import.meta.dir, '../../..')
  let screen: ReturnType<typeof mountNativeScreen> | undefined
  try {
    await Bun.write(join(root, 'stx.config.ts'), `export default { componentsDir:${JSON.stringify(join(app, 'resources/components'))} }`)
    await Bun.write(join(root, 'Screen.stx'), `<script client>
const draft = state('')
const enabled = state(false)
const canOpen = state(false)
const opened = state(0)
const sent = []
globalThis.probe = { draft, enabled, canOpen, opened, sent }
</script><View><AtticComposer v-model:draft="draft" :enabled="enabled()" :canOpen="canOpen()" provider="imessage" @open="opened.set(opened() + 1)" @send="sent.push(draft())" /></View>`)
    const { code } = await compileNativeBundle({ root, screens: { Screen: 'Screen.stx' } })
    screen = mountNativeScreen(code, 'Screen')
    await screen.settle()
    const reply = () => screen?.find(node => node.props.title === 'Reply in Messages')
    expect(reply()).toBeUndefined()
    screen.context.probe.canOpen.set(true)
    await screen.settle()
    expect(reply()).toBeDefined()
    screen.press(reply()!)
    expect(screen.context.probe.opened()).toBe(1)
    screen.context.probe.enabled.set(true)
    await screen.settle()
    expect(reply()).toBeUndefined()
    screen.type(screen.byTestID('composer')!, 'The van is ready')
    await screen.settle()
    expect(screen.context.probe.draft()).toBe('The van is ready')
    screen.press(screen.byTestID('send')!)
    await screen.settle()
    expect(Array.from(screen.context.probe.sent)).toEqual(['The van is ready'])
  }
  finally { screen?.unmount(); rmSync(root, { recursive: true, force: true }) }
})
