/* eslint-disable no-console */
/**
 * `bun run build:app`: Attic.app and its DMG, signed when an identity is set.
 *
 * Everything that is framework work - compiling the launcher, bundling the
 * Craft runtime, the manifest, the icon, signing and imaging - is
 * `buddy build:desktop` and `buddy build:dmg`. What is left here is what only
 * Attic knows: the UI rendered to static files, and the Swift helper that
 * drives Messages, compiled beside the launcher so it shares Attic's grants.
 *
 *   DESKTOP_SIGNING_IDENTITY  Developer ID Application (name or SHA-1). Sign
 *                             with a stable identity or every rebuild voids the
 *                             Full Disk Access grant.
 *   DESKTOP_NOTARY_PROFILE    notarytool keychain profile, for a release.
 *   CRAFT_BIN                 Craft runtime; pantry's by default.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const root = join(import.meta.dir, '..')
const version = (await Bun.file(join(root, 'package.json')).json()).version as string

function step(args: string[], env: Record<string, string | undefined> = {}): void {
  console.log(`> ${args.join(' ')}`)
  const result = Bun.spawnSync(args, { cwd: root, env: { ...process.env, ...env }, stdout: 'inherit', stderr: 'inherit' })
  if (result.exitCode !== 0)
    process.exit(result.exitCode ?? 1)
}

step(['bun', 'run', 'build:ui'])
const resources = join(root, 'app', 'Desktop', 'Resources')
rmSync(join(resources, 'web'), { recursive: true, force: true })
mkdirSync(resources, { recursive: true })
cpSync(join(root, 'storage', 'attic', 'web'), join(resources, 'web'), { recursive: true })

step(['bun', 'run', 'build:helper'])

const craft = process.env.CRAFT_BIN || join(root, 'pantry', '.bin', 'craft')
if (!existsSync(craft)) {
  console.error(`No Craft runtime at ${craft}: run \`pantry install\` or set CRAFT_BIN.`)
  process.exit(1)
}
step(['./buddy', 'build:desktop'], { CRAFT_BIN: craft })
cpSync(join(root, 'storage', 'attic', 'bin', 'attic-messages'), join(root, 'storage', 'framework', 'desktop-dist', 'attic-messages'))

step(['./buddy', 'build:dmg'], {
  DESKTOP_APP_NAME: 'Attic',
  DESKTOP_BUNDLE_ID: 'com.stacksjs.attic',
  DESKTOP_APP_VERSION: version,
})
console.log(`Built Attic ${version}: storage/framework/desktop-dmg/`)
