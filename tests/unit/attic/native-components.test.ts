import { expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { compileNativeBundle } from '@stacksjs/stx/native'
import { mountNativeScreen } from '@stacksjs/stx/native/testing'

it('disables unavailable reply links and keeps the composer model and send action connected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'attic-composer-'))
  const app = resolve(import.meta.dir, '../../..')
  let screen: ReturnType<typeof mountNativeScreen> | undefined
  try {
    await Bun.write(join(root, 'stx.config.ts'), `export default { componentsDir:${JSON.stringify(join(app, 'resources/components'))} }`)
    await Bun.write(join(root, 'Screen.stx'), `<script client>
const draft = state('')
const enabled = state(false)
const canOpen = state(false)
const sent = []
globalThis.probe = { draft, enabled, canOpen, sent }
</script><View><AtticComposer v-model:draft="draft" :enabled="enabled()" :canOpen="canOpen()" @send="sent.push(draft())" /></View>`)
    const { code } = await compileNativeBundle({ root, screens: { Screen: 'Screen.stx' } })
    screen = mountNativeScreen(code, 'Screen')
    await screen.settle()
    expect(screen.find(node => node.props.title === 'Reply in App')?.props.disabled).toBe(true)
    screen.context.probe.enabled.set(true)
    await screen.settle()
    screen.type(screen.byTestID('composer')!, 'The van is ready')
    await screen.settle()
    expect(screen.context.probe.draft()).toBe('The van is ready')
    screen.press(screen.byTestID('send')!)
    await screen.settle()
    expect(Array.from(screen.context.probe.sent)).toEqual(['The van is ready'])
  }
  finally { screen?.unmount(); rmSync(root, { recursive: true, force: true }) }
})
