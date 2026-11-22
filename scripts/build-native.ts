/* eslint-disable no-console */
/** Compile STX screens and Craft's AppKit host against the pinned zig-js engine. */
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import lock from './native-lock.json'

const root = resolve(import.meta.dir, '..')
const outdir = join(root, 'storage/attic/native')
const toolchain = join(root, 'storage/attic/toolchain')
mkdirSync(outdir, { recursive: true })
mkdirSync(toolchain, { recursive: true })

async function run(args: string[], cwd = root): Promise<void> {
  console.log(`> ${args.join(' ')}`)
  const child = Bun.spawn(args, { cwd, stdout: 'inherit', stderr: 'inherit' })
  if (await child.exited !== 0) throw new Error(`Build command failed: ${args[0]}`)
}

async function source(name: keyof typeof lock.sources, override?: string): Promise<string> {
  if (override) return resolve(override)
  const pin = lock.sources[name]
  const destination = join(toolchain, 'native', name)
  if (!existsSync(join(destination, '.git'))) {
    mkdirSync(destination, { recursive: true })
    await run(['git', 'init', destination])
    await run(['git', 'remote', 'add', 'origin', pin.url], destination)
    await run(['git', 'sparse-checkout', 'set', ...pin.paths], destination)
  }
  const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: destination }).stdout.toString().trim()
  if (head !== pin.revision) {
    await run(['git', 'config', 'remote.origin.promisor', 'true'], destination)
    await run(['git', 'config', 'remote.origin.partialclonefilter', 'blob:none'], destination)
    await run(['git', 'fetch', '--filter=blob:none', '--depth=1', 'origin', pin.revision], destination)
    await run(['git', 'checkout', '--detach', 'FETCH_HEAD'], destination)
  }
  return destination
}

if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('This locked DMG toolchain targets Apple Silicon macOS.')
let zig = process.env.CRAFT_ZIG
if (!zig) {
  zig = join(toolchain, `zig-aarch64-macos-${lock.zig.version}`, 'zig')
  if (!existsSync(zig)) {
    const response = await fetch(`https://ziglang.org/builds/zig-aarch64-macos-${lock.zig.version}.tar.xz`)
    if (!response.ok) throw new Error(`Zig download failed (${response.status})`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (new Bun.CryptoHasher('sha256').update(bytes).digest('hex') !== lock.zig.sha256)
      throw new Error('Zig download SHA256 mismatch.')
    const archive = join(toolchain, `zig-${lock.zig.version}.tar.xz`)
    await Bun.write(archive, bytes)
    await run(['tar', '-xJf', archive, '-C', toolchain])
  }
}
const engine = await source('zig-js', process.env.ZIG_JS_SOURCE)
if (!process.env.ZIG_JS_SOURCE) { await source('zig-regex'); await source('zig-gc') }
await run([zig, 'build', 'home-tool-bootstrap', '-Doptimize=ReleaseFast'], engine)
// Bun links select local checkouts during development. The same imports use
// the registry packages after release, so validation and shipping share a path.
const { compileNativeBundle } = await import('@stacksjs/stx/native')
const { buildMacOSNative } = await import('craft-native/macos')
const compiled = await compileNativeBundle({
  screens: { Main: 'resources/native/Main.stx', Settings: 'resources/native/Settings.stx', Cleanup: 'resources/native/Cleanup.stx' },
  initialScreen: 'Main', root, minify: true, outFile: 'storage/attic/native/native-screen.js',
})
const diagnostics = compiled.diagnostics.filter((item: { message: string }) => item.message !== 'dropped-subtree: script')
if (diagnostics.length) throw new Error(`Native screen diagnostics: ${JSON.stringify(diagnostics)}`)
await buildMacOSNative({ outdir, nativeBundle: compiled.outFile, zig, zigJS: { source: engine, library: join(engine, 'zig-out/lib/libzig-js.a') } })
const links = Bun.spawnSync(['otool', '-L', join(outdir, 'craft-native-macos')]).stdout.toString()
if (links.includes('JavaScriptCore.framework') || links.includes('WebKit.framework'))
  throw new Error('The native renderer linked a system browser or script engine.')
const packages = await Promise.all(['@stacksjs/stx', '@stacksjs/components', 'craft-native'].map(async name => {
  const { version } = await Bun.file(join(root, 'node_modules', name, 'package.json')).json()
  return { name, version }
}))
await Bun.write(join(outdir, 'provenance.json'), JSON.stringify({ renderer: 'appkit', scriptEngine: 'zig-js', packages, ...lock }, null, 2))
console.log('Built native STX UI with Craft AppKit and zig-js.')
