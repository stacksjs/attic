/* eslint-disable no-console */
import { describeArtifact, signUpdateManifest, updatePublicKey } from '@stacksjs/desktop-build/update-signing'
import { validateUpdateManifest, verifyUpdateManifestSignature } from '@stacksjs/desktop-build/updater'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { ATTIC_RELEASE_REPO, manifestAsset, UPDATE_KEYS, updateArchive, updateArchiveUrl } from '../app/Attic/updates'

const root = resolve(import.meta.dir, '..')

async function run(command: string[], options: { capture?: boolean, env?: Record<string, string | undefined> } = {}): Promise<string> {
  const child = Bun.spawn(command, { cwd: root, env: { ...process.env, ...options.env }, stdout: options.capture ? 'pipe' : 'inherit', stderr: 'inherit' })
  const output = options.capture ? await new Response(child.stdout).text() : ''
  if (await child.exited !== 0)
    throw new Error(`${command[0]} ${command[1]} failed.`)
  return output.trim()
}

async function version(): Promise<string> {
  return (await Bun.file(join(root, 'package.json')).json()).version
}

function signingKey(): string {
  const file = process.env.ATTIC_UPDATE_KEY_FILE || join(homedir(), 'Library/Application Support/Attic Release/update-signing-key')
  const key = process.env.DESKTOP_UPDATE_PRIVATE_KEY?.trim() || (existsSync(file) ? readFileSync(file, 'utf8').trim() : '')
  if (!key || updatePublicKey(key) !== UPDATE_KEYS.main)
    throw new Error('Provide the private Attic update signing key through ATTIC_UPDATE_KEY_FILE or DESKTOP_UPDATE_PRIVATE_KEY.')
  return key
}

async function developerIdentity(): Promise<string> {
  if (process.env.DESKTOP_SIGNING_IDENTITY)
    return process.env.DESKTOP_SIGNING_IDENTITY
  const identities = await run(['/usr/bin/security', 'find-identity', '-v', '-p', 'codesigning'], { capture: true })
  const identity = identities.match(/([0-9A-F]{40}) "Developer ID Application: [^"]+ \(3JJRNQW6B7\)"/)?.[1]
  if (!identity)
    throw new Error('An Attic Developer ID Application identity is required in the macOS keychain.')
  return identity
}

async function buildAssets(directory: string, tag: string, revision: string, key: string): Promise<void> {
  const identity = await developerIdentity()
  const hasNotaryKey = process.env.APP_STORE_CONNECT_API_KEY_ID && process.env.APP_STORE_CONNECT_API_ISSUER_ID
    && (process.env.APP_STORE_CONNECT_API_KEY_PATH || process.env.APP_STORE_CONNECT_API_KEY)
  const notarize = process.env.DESKTOP_NOTARY_PROFILE || hasNotaryKey ? '1' : undefined
  if (!notarize)
    console.warn('Building with Developer ID signing. Configure a notary profile or App Store Connect API key to notarize the release.')
  await run(['bun', 'run', 'build:app'], { env: { DESKTOP_SIGNING_IDENTITY: identity, DESKTOP_NOTARIZE: notarize } })

  const releases = dirname(directory)
  mkdirSync(releases, { recursive: true })
  const temporary = mkdtempSync(join(releases, 'pack-'))
  try {
    const dmg = `Attic-${tag.slice(1)}.dmg`
    const diskImage = join(root, 'storage/framework/desktop-dmg', dmg)
    const mount = join(temporary, 'mount')
    mkdirSync(mount)
    await run(['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', mount, diskImage], { capture: true })
    const bundle = join(mount, 'Attic.app')
    const archive = join(temporary, updateArchive(tag))
    try {
      await run(['/usr/bin/codesign', '--verify', '--deep', '--strict', bundle])
      await run(['/usr/bin/ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', bundle, archive])
    }
    finally { await run(['hdiutil', 'detach', mount], { capture: true }) }
    rmdirSync(mount)
    copyFileSync(diskImage, join(temporary, dmg))
    const manifest = signUpdateManifest({
      version: tag.slice(1), url: updateArchiveUrl(tag), ...(await describeArtifact(archive)), sourceRevision: revision,
      platform: 'darwin', architecture: process.arch, publishedAt: new Date().toISOString(),
    }, key, 'main')
    await Bun.write(join(temporary, manifestAsset()), `${JSON.stringify(manifest, null, 2)}\n`)
    renameSync(temporary, directory)
  }
  finally { rmSync(temporary, { recursive: true, force: true }) }
}

async function publish(directory: string, tag: string, revision: string, key: string): Promise<void> {
  const release = JSON.parse(await run(['gh', 'api', `repos/${ATTIC_RELEASE_REPO}/releases/tags/${tag}`], { capture: true }))
  if (!existsSync(directory))
    await buildAssets(directory, tag, revision, key)

  const archive = join(directory, updateArchive(tag))
  const diskImage = join(directory, `Attic-${tag.slice(1)}.dmg`)
  const manifestFile = join(directory, manifestAsset())
  const manifest = validateUpdateManifest(await Bun.file(manifestFile).json())
  verifyUpdateManifestSignature(manifest, UPDATE_KEYS)
  const zip = await describeArtifact(archive)
  if (manifest.sourceRevision !== revision || manifest.version !== tag.slice(1) || manifest.url !== updateArchiveUrl(tag) || manifest.sha256 !== zip.sha256 || manifest.size !== zip.size)
    throw new Error('The staged update does not match the tagged release.')

  // Advertise the manifest only after both downloads are available.
  for (const file of [archive, diskImage, manifestFile]) {
    const name = basename(file)
    const existing = release.assets.find((asset: { name: string }) => asset.name === name)
    if (existing) {
      if (existing.digest !== `sha256:${(await describeArtifact(file)).sha256}`)
        throw new Error(`GitHub already has a different ${name}.`)
      continue
    }
    await run(['gh', 'release', 'upload', tag, file, '--repo', ATTIC_RELEASE_REPO])
  }
  console.log(`Published Attic ${tag.slice(1)} at ${release.html_url}`)
}

const args = process.argv.slice(2)
if (args.includes('--dry-run')) {
  await run(['./buddy', 'release', '--bump', 'patch', '--dry-run'])
}
else {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('Attic macOS releases must be built on Apple Silicon.')
  const key = signingKey()
  if (args.includes('--patch'))
    await run(['./buddy', 'release', '--bump', 'patch'])
  const tag = `v${await version()}`
  const revision = await run(['git', 'rev-parse', 'HEAD'], { capture: true })
  const tagged = await run(['git', 'rev-list', '-n', '1', tag], { capture: true })
  if (revision !== tagged)
    throw new Error(`Check out the commit for ${tag} to package that GitHub release.`)
  await publish(join(root, 'storage/attic/releases', tag), tag, revision, key)
}
