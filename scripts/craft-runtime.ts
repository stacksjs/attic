/** Use the official Craft release matching the installed SDK for every DMG. */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'

interface ReleaseManifest {
  repository: string
  tag: string
  commit: string
  assets: { name: string, sha256: string, size: number }[]
}

async function download(url: string): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok)
    throw new Error(`Craft download failed (${response.status}): ${url}`)
  return response
}

function assertRuntimeVersion(binary: string, version: string): void {
  const result = Bun.spawnSync([binary, '--version'], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0 || !new RegExp(`^craft version ${version.replaceAll('.', '\\.')}$`, 'm').test(result.stdout.toString()))
    throw new Error(`Craft runtime at ${binary} must match craft-native ${version}.`)
}

export async function resolveCraftRuntime(root: string): Promise<string> {
  const { version } = await Bun.file(join(root, 'node_modules/craft-native/package.json')).json() as { version: string }
  if (process.env.CRAFT_BIN) {
    const override = resolve(process.env.CRAFT_BIN)
    assertRuntimeVersion(override, version)
    return override
  }
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch))
    throw new Error('Attic DMGs require an arm64 or x64 Mac.')

  const tag = `v${version}`
  const assetName = `craft-darwin-${process.arch}.zip`
  const base = `https://github.com/craft-native/craft/releases/download/${tag}`
  const manifest = await (await download(`${base}/release-manifest.json`)).json() as ReleaseManifest
  const asset = manifest.assets.find(item => item.name === assetName)
  if (manifest.repository !== 'craft-native/craft' || manifest.tag !== tag || !asset || !/^[a-f0-9]{64}$/.test(asset.sha256))
    throw new Error(`Invalid Craft release manifest for ${tag}.`)

  const directory = join(root, 'storage/attic/toolchain', tag, process.arch)
  mkdirSync(directory, { recursive: true })
  const archivePath = join(directory, assetName)
  let bytes = existsSync(archivePath) ? await Bun.file(archivePath).bytes() : null
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256)
    bytes = new Uint8Array(await (await download(`${base}/${assetName}`)).arrayBuffer())
  if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256)
    throw new Error(`Craft ${tag} archive failed SHA-256 verification.`)
  await Bun.write(archivePath, bytes)

  const extraction = Bun.spawnSync(['unzip', '-o', archivePath, '-d', directory], { stdout: 'ignore', stderr: 'pipe' })
  if (extraction.exitCode !== 0)
    throw new Error(`Could not unpack Craft: ${extraction.stderr.toString()}`)
  const binary = join(directory, 'craft')
  chmodSync(binary, 0o755)
  assertRuntimeVersion(binary, version)
  await Bun.write(join(directory, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return binary
}
