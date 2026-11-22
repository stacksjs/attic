/* eslint-disable no-console */
/**
 * `bun run build:app`: Texts.app and its DMG, signed when an identity is set.
 *
 * Everything that is framework work - compiling the launcher, bundling the
 * Craft runtime, the manifest, the icon, signing and imaging - is
 * `buddy build:desktop` and `buddy build:dmg`. What is left here is what only
 * Attic knows: its stx native screen bundle, Craft's AppKit host linked with
 * zig-js, and the Swift Messages helper beside the launcher. The static web
 * build remains available to the agent's browser and mobile clients.
 *
 *   DESKTOP_SIGNING_IDENTITY  Developer ID Application (name or SHA-1). Sign
 *                             with a stable identity or every rebuild voids the
 *                             Full Disk Access grant.
 *   DESKTOP_NOTARY_PROFILE    notarytool keychain profile, for a release.
 *   CRAFT_BIN                 Optional runtime override, matching the installed SDK.
 */
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { resolveCraftRuntime } from './craft-runtime'

const root = join(import.meta.dir, '..')
const version = (await Bun.file(join(root, 'package.json')).json()).version as string
const craft = await resolveCraftRuntime(root)

function step(args: string[], env: Record<string, string | undefined> = {}): void {
  console.log(`> ${args.join(' ')}`)
  const result = Bun.spawnSync(args, { cwd: root, env: { ...process.env, ...env }, stdout: 'inherit', stderr: 'inherit' })
  if (result.exitCode !== 0)
    process.exit(result.exitCode ?? 1)
}

if (!process.argv.includes('--reuse-web'))
  step(['bun', 'run', 'build:ui'])
step(['bun', 'run', 'build:native'])
const resources = join(root, 'app', 'Desktop', 'Resources')
rmSync(join(resources, 'web'), { recursive: true, force: true })
mkdirSync(resources, { recursive: true })
cpSync(join(root, 'storage', 'attic', 'web'), join(resources, 'web'), { recursive: true })
cpSync(join(root, 'storage', 'attic', 'native', 'native-screen.js'), join(resources, 'native-screen.js'))
cpSync(join(root, 'storage', 'attic', 'native', 'provenance.json'), join(resources, 'native-provenance.json'))

step(['bun', 'run', 'build:helper'])

step(['./buddy', 'build:desktop'], { CRAFT_BIN: craft })
cpSync(join(root, 'storage', 'attic', 'bin', 'attic-messages'), join(root, 'storage', 'framework', 'desktop-dist', 'attic-messages'))
cpSync(join(root, 'storage', 'attic', 'bin', 'attic-notifications.dylib'), join(root, 'storage', 'framework', 'desktop-dist', 'attic-notifications.dylib'))
cpSync(join(root, 'storage', 'attic', 'native', 'craft-native-macos'), join(root, 'storage', 'framework', 'desktop-dist', 'craft-runtime'))

// The app replaces the bootstrap runtime with its compiled native host. Keep
// the packaged checksums and provenance about the bytes actually distributed.
const distribution = join(root, 'storage/framework/desktop-dist')
const provenance = await Bun.file(join(distribution, 'provenance.json')).json()
const artifacts = await Promise.all(['stacks-desktop', 'craft-runtime', 'attic-messages', 'attic-notifications.dylib', 'desktop.json'].map(async (name) => {
  const bytes = await Bun.file(join(distribution, name)).bytes()
  return { name, bytes: bytes.length, sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex') }
}))
provenance.artifacts = artifacts
provenance.builtWith.craftSha256 = artifacts.find(a => a.name === 'craft-runtime')!.sha256
provenance.native = await Bun.file(join(resources, 'native-provenance.json')).json()
provenance.target.osVersions = [`macOS ${Bun.spawnSync(['sw_vers', '-productVersion']).stdout.toString().trim()} (native AppKit host)`]
await Bun.write(join(distribution, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`)
await Bun.write(join(distribution, 'checksums.sha256'), `${artifacts.map(a => `${a.sha256}  ${a.name}`).join('\n')}\n`)

step(['./buddy', 'build:dmg'], {
  DESKTOP_APP_NAME: 'Texts',
  DESKTOP_BUNDLE_ID: 'com.stacksjs.attic',
  DESKTOP_APP_VERSION: version,
})
console.log(`Built Texts ${version}: storage/framework/desktop-dmg/`)
