import type { DesktopUpdateStatus } from '@stacksjs/desktop-build/update-install'
import type { DesktopFetcher } from '@stacksjs/desktop-build/updater'
import { createDesktopUpdater, detectInstallation, macosSigner } from '@stacksjs/desktop-build/update-install'
import { accessSync, constants } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { DATA_DIR } from './paths'

export const TEXTS_RELEASE_REPO = 'stacksjs/texts-downloads'
export const UPDATE_KEYS = {
  main: 'ed25519-public:MCowBQYDK2VwAyEApIrqVX8iqBUC57QeUU-XQqejB-9P67pkvvFjvBALsrQ',
}
const releases = `https://github.com/${TEXTS_RELEASE_REPO}/releases`
const signedArchiveBase = 'https://github.com/stacksjs/attic-downloads/releases/download'
const feed = `${releases}/latest`
const target = { platform: 'darwin', architecture: process.arch }

export function manifestAsset(arch = target.architecture): string {
  return `update-darwin-${arch}.json`
}

// The old clients validate this asset name before the bundle can update in place.
export function updateArchive(tag: string, arch = target.architecture): string {
  return `Attic-${tag.slice(1)}-${arch}.zip`
}

export function updateArchiveUrl(tag: string, arch = target.architecture): string {
  // Existing clients accept only the original repository and archive name in signed manifests.
  return `${signedArchiveBase}/${tag}/${updateArchive(tag, arch)}`
}

type UpdateAction = 'check' | 'install'
type UpdateStatus = Pick<DesktopUpdateStatus, 'currentVersion' | 'selfUpdating' | 'version' | 'notes' | 'publishedAt' | 'error'> & {
  state: Exclude<DesktopUpdateStatus['state'], 'refused'> | 'unavailable'
  reason?: string
}

/** Translate Stacks' feed request to the public manifest asset on GitHub. */
export function githubUpdateFetcher(fetcher: DesktopFetcher = fetch): DesktopFetcher {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const isManifest = `${url.origin}${url.pathname}` === `${feed}/darwin/${target.architecture}`
    const tag = url.pathname.split('/').at(-2) ?? ''
    if (!isManifest && (!/^v\d+\.\d+\.\d+$/.test(tag) || url.href !== updateArchiveUrl(tag)))
      throw new Error('The update does not point to a Texts release on GitHub.')
    const assetUrl = isManifest ? `${feed}/download/${manifestAsset()}` : `${releases}/download/${tag}/${updateArchive(tag)}`
    return fetcher(assetUrl, { signal: init?.signal })
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
    appName: 'Texts', updatesDir: join(DATA_DIR, 'Updates'), fetcher: githubUpdateFetcher(),
  })
  let pending: Promise<UpdateStatus> | undefined
  let action: UpdateAction | undefined

  function status(): UpdateStatus {
    if (!updater)
      return { currentVersion: version, state: 'unavailable', selfUpdating: false, reason: 'Install the signed Texts app in Applications to enable updates.' }
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
