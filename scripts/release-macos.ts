/* eslint-disable no-console */
import { describeArtifact, signUpdateManifest, updatePublicKey } from '@stacksjs/desktop-build/update-signing'
import { validateUpdateManifest, verifyUpdateManifestSignature } from '@stacksjs/desktop-build/updater'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { ATTIC_RELEASE_REPO, manifestAsset, UPDATE_KEYS, updateArchive, updateArchiveUrl } from '../app/Attic/updates'

const root = resolve(import.meta.dir, '..')

async function run(command: string[], options: { capture?: boolean, input?: object, env?: Record<string, string | undefined> } = {}): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: root, env: { ...process.env, ...options.env }, stdin: options.input ? Buffer.from(JSON.stringify(options.input)) : 'ignore',
    stdout: options.capture ? 'pipe' : 'inherit', stderr: 'inherit',
  })
  const output = options.capture ? await new Response(child.stdout).text() : ''
  if (await child.exited !== 0)
    throw new Error(`${command[0]} ${command[1]} failed.`)
  return output.trim()
}

async function version(): Promise<string> {
  return (await Bun.file(join(root, 'package.json')).json()).version
}

function diskImageName(tag: string): string {
  return `Chatfold-${tag.slice(1)}.dmg`
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
  if (!process.env.DESKTOP_NOTARY_PROFILE && !hasNotaryKey)
    throw new Error('Configure a notary profile or App Store Connect API key to publish a macOS release.')
  await run(['bun', 'run', 'build:app'], { env: { DESKTOP_SIGNING_IDENTITY: identity, DESKTOP_NOTARIZE: '1' } })

  const releases = dirname(directory)
  mkdirSync(releases, { recursive: true })
  const temporary = mkdtempSync(join(releases, 'pack-'))
  try {
    const dmg = diskImageName(tag)
    const diskImage = join(root, 'storage/framework/desktop-dmg', dmg)
    await run(['xcrun', 'stapler', 'validate', diskImage])
    const mount = join(temporary, 'mount')
    mkdirSync(mount)
    await run(['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', mount, diskImage], { capture: true })
    const bundle = join(mount, 'Chatfold.app')
    const archive = join(temporary, updateArchive(tag))
    try {
      await run(['/usr/bin/codesign', '--verify', '--deep', '--strict', bundle])
      await run(['xcrun', 'stapler', 'validate', bundle])
      for await (const file of new Bun.Glob('**/*').scan({ cwd: bundle, dot: true, onlyFiles: true })) {
        if (/(?:^|\/)(?:\.git(?:\/|$)|\.env(?:\.|$))|\.(?:p8|p12|key|sqlite3?|db)$/i.test(file))
          throw new Error(`Private build material was packaged in the app: ${file}`)
      }
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

interface PublicRelease {
  tag_name: string
  draft: boolean
  assets: Array<{ name: string, digest: string }>
}

async function publicRelease(tag: string): Promise<PublicRelease> {
  const endpoint = `repos/${ATTIC_RELEASE_REPO}/releases`
  const pages = JSON.parse(await run(['gh', 'api', `${endpoint}?per_page=100`, '--paginate', '--slurp'], { capture: true })) as PublicRelease[][]
  const existing = pages.flat().find(release => release.tag_name === tag)
  if (existing)
    return existing

  return JSON.parse(await run(['gh', 'api', '-X', 'POST', endpoint, '--input', '-'], {
    capture: true,
    input: {
      tag_name: tag,
      name: `Chatfold ${tag.slice(1)}`,
      draft: true,
      body: `Download **${diskImageName(tag)}** on an Apple silicon Mac. Open the disk image and drag Chatfold into Applications.\n\nAttic is now Chatfold. If Attic is installed, use **Settings → Software Update** to get Chatfold in place with your existing archive.`,
    },
  }))
}

async function publish(directory: string, tag: string, revision: string, key: string): Promise<void> {
  if (!existsSync(directory))
    await buildAssets(directory, tag, revision, key)

  const archive = join(directory, updateArchive(tag))
  const diskImage = join(directory, diskImageName(tag))
  const manifestFile = join(directory, manifestAsset())
  const manifest = validateUpdateManifest(await Bun.file(manifestFile).json())
  verifyUpdateManifestSignature(manifest, UPDATE_KEYS)
  const zip = await describeArtifact(archive)
  if (manifest.sourceRevision !== revision || manifest.version !== tag.slice(1) || manifest.url !== updateArchiveUrl(tag) || manifest.sha256 !== zip.sha256 || manifest.size !== zip.size)
    throw new Error('The staged update does not match the tagged release.')

  const release = await publicRelease(tag)
  // The latest URL must keep serving the prior complete release until every asset is present.
  for (const file of [archive, diskImage, manifestFile]) {
    const name = basename(file)
    const existing = release.assets.find(asset => asset.name === name)
    if (existing) {
      if (existing.digest !== `sha256:${(await describeArtifact(file)).sha256}`)
        throw new Error(`GitHub already has a different ${name}.`)
      continue
    }
    await run(['gh', 'release', 'upload', tag, file, '--repo', ATTIC_RELEASE_REPO])
  }
  if (release.draft)
    await run(['gh', 'release', 'edit', tag, '--repo', ATTIC_RELEASE_REPO, '--draft=false', '--latest'])
  console.log(`Published Chatfold ${tag.slice(1)} at https://github.com/${ATTIC_RELEASE_REPO}/releases/tag/${tag}`)
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
