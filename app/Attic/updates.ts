import type { DesktopUpdateStatus } from '@stacksjs/desktop-build/update-install'
import type { DesktopFetcher } from '@stacksjs/desktop-build/updater'
import { createDesktopUpdater, detectInstallation, macosSigner } from '@stacksjs/desktop-build/update-install'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { DATA_DIR } from './paths'

export const ATTIC_RELEASE_REPO = 'stacksjs/attic'
export const UPDATE_KEYS = {
  main: 'ed25519-public:MCowBQYDK2VwAyEApIrqVX8iqBUC57QeUU-XQqejB-9P67pkvvFjvBALsrQ',
}
const api = `https://api.github.com/repos/${ATTIC_RELEASE_REPO}`
const feed = `${api}/releases/latest`
const downloadPath = `/${ATTIC_RELEASE_REPO}/releases/download/`
const target = { platform: 'darwin', architecture: process.arch }

export function manifestAsset(arch = target.architecture): string {
  return `update-darwin-${arch}.json`
}

export function updateArchive(tag: string, arch = target.architecture): string {
  return `Attic-${tag.slice(1)}-${arch}.zip`
}

export function updateArchiveUrl(tag: string, arch = target.architecture): string {
  return `https://github.com${downloadPath}${tag}/${updateArchive(tag, arch)}`
}

type Release = { assets: { id: number, name: string }[] }
type UpdateAction = 'check' | 'install'
type UpdateStatus = Pick<DesktopUpdateStatus, 'currentVersion' | 'selfUpdating' | 'version' | 'notes' | 'publishedAt' | 'error'> & {
  state: Exclude<DesktopUpdateStatus['state'], 'refused'> | 'unavailable'
  reason?: string
}

async function githubToken(): Promise<string> {
  // Launch Services does not inherit the shell's PATH. Pantry and Homebrew
  // install gh in these locations, as well as supporting a shell install.
  const gh = [Bun.which('gh'), join(homedir(), '.local/share/pantry/global/bin/gh'), '/opt/homebrew/bin/gh', '/usr/local/bin/gh']
    .find((candidate) => {
      if (!candidate) return false
      try { accessSync(candidate, constants.X_OK); return true }
      catch { return false }
    })
  if (!gh)
    throw new Error('Install GitHub CLI and sign in to check for private Attic releases.')

  const child = Bun.spawn([gh, 'auth', 'token', '--hostname', 'github.com'], {
    stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', env: { ...process.env, GH_PROMPT_DISABLED: '1' },
  })
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  const token = output.trim()
  if (code !== 0 || !token)
    throw new Error('Sign in with gh auth login using a GitHub account that can read stacksjs/attic.')
  return token
}

/** Use the caller's GitHub login for exactly the private release assets Attic expects. */
export function githubUpdateFetcher(token: () => Promise<string> = githubToken, fetcher: DesktopFetcher = fetch): DesktopFetcher {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const isManifest = `${url.origin}${url.pathname}` === `${feed}/darwin/${target.architecture}`
    const tag = url.pathname.slice(downloadPath.length).split('/')[0] ?? ''
    if (!isManifest && (!/^v\d+\.\d+\.\d+$/.test(tag) || url.href !== updateArchiveUrl(tag)))
      throw new Error('The update does not point to an Attic release on GitHub.')

    const authorization = `Bearer ${await token()}`
    const releaseUrl = isManifest ? feed : `${api}/releases/tags/${tag}`
    const releaseResponse = await fetcher(releaseUrl, {
      headers: { authorization, accept: 'application/vnd.github+json' }, redirect: 'error', signal: init?.signal,
    })
    if ([401, 403, 404].includes(releaseResponse.status))
      throw new Error('The current GitHub login cannot read the Attic releases.')
    if (!releaseResponse.ok)
      throw new Error(`GitHub could not read the Attic release (HTTP ${releaseResponse.status}).`)
    const release = await releaseResponse.json() as Release
    const name = isManifest ? manifestAsset() : updateArchive(tag)
    const asset = release.assets.find(asset => asset.name === name)
    if (!asset && isManifest)
      return new Response(null, { status: 204 })
    if (!asset || !Number.isSafeInteger(asset.id) || asset.id <= 0)
      throw new Error('The Attic release is missing its update archive.')

    const response = await fetcher(`${api}/releases/assets/${asset.id}`, {
      headers: { authorization, accept: 'application/octet-stream' }, redirect: 'manual', signal: init?.signal,
    })
    if (response.status < 300 || response.status >= 400)
      return response
    const location = response.headers.get('location')
    if (!location || new URL(location).protocol !== 'https:')
      throw new Error('GitHub returned an invalid release download URL.')
    // Release assets redirect to a signed CDN URL. Keep the GitHub token on api.github.com.
    return fetcher(location, { signal: init?.signal })
  }
}

function installedBundle(): ReturnType<typeof detectInstallation> | null {
  const installed = detectInstallation()
  if (installed.kind !== 'macos-bundle' || !installed.path)
    return null
  try {
    accessSync(dirname(installed.path), constants.W_OK)
    const signer = macosSigner(installed.path)
    return signer.teamId && signer.identifier === 'com.stacksjs.attic' ? installed : null
  }
  catch { return null }
}

export function createAtticUpdater(version: string, enabled: boolean, changed: (status: UpdateStatus) => void) {
  const installation = enabled ? installedBundle() : null
  const updater = installation && createDesktopUpdater({
    currentVersion: version, feedUrl: feed, trustedKeys: UPDATE_KEYS, target, installation,
    appName: 'Attic', updatesDir: join(DATA_DIR, 'Updates'), fetcher: githubUpdateFetcher(),
  })
  let pending: Promise<UpdateStatus> | undefined
  let action: UpdateAction | undefined

  function status(): UpdateStatus {
    if (!updater)
      return { currentVersion: version, state: 'unavailable', selfUpdating: false, reason: 'Install the signed Attic app in Applications to enable updates.' }
    const current = updater.status()
    const state = action === 'install' ? 'installing' : current.state === 'refused' ? 'error' : current.state
    return { ...current, state }
  }

  function run(next: UpdateAction): Promise<UpdateStatus> {
    if (pending)
      return pending
    if (!updater || (next === 'install' && updater.status().state !== 'available'))
      return Promise.resolve(status())
    action = next
    pending = updater[next]().then(() => {
      pending = undefined
      action = undefined
      const current = status()
      changed(current)
      return current
    })
    changed(status())
    return pending
  }

  return { status, run, relaunch: () => updater ? updater.relaunchIfInstalled() : Promise.resolve() }
}
