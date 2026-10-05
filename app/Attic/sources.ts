import type { Provider } from './store'
import type { LinkState } from './whatsapp-link'
import { inbox } from '@stacksjs/chat'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { SlackWorkspace } from './slack-workspaces'
import { deleteSecret, readSecret as readKeychain, writeSecret as writeKeychain } from './keychain'
import { archiveInWhatsApp, recoverInMessages, removeFromMessages, unarchiveInWhatsApp } from './messages-app'
import { addressBookDir, messagesDbPath, WHATSAPP_LINK_DIR, whatsappDbPath } from './paths'
import { sampleDiscord, sampleSlack, sampleWhatsApp } from './sample-sources'
import { parseWorkspaces, slackIdentity, slackSource } from './slack-workspaces'
import { WhatsAppLink } from './whatsapp-link'

/**
 * The apps Attic reads, through the inbox drivers in `@stacksjs/chat`.
 *
 * iMessage is always present (it needs only Full Disk Access and, to
 * archive, Accessibility). WhatsApp is Attic's own linked device once the
 * person has linked it, and WhatsApp for Mac's database until then, so the
 * Mac app can be uninstalled after linking. Slack and Discord join once their
 * tokens are in the keychain. Listing is cached: the
 * iMessage list is a local query, but Slack and Discord cost an API call per
 * conversation, so they are re-read at most once a minute unless forced.
 */

/** Something a pushing app reported, with the app it came from. */
export interface SourceEvent {
  provider: Provider
  event: inbox.InboxEvent
}

export interface LiveEntry {
  key: string
  provider: Provider
  conversation: inbox.InboxConversation
}

export interface SourceState {
  provider: Provider
  label: string
  status: inbox.InboxStatus
  /** What Attic can do in this app beyond reading: send, react, mark read. */
  capabilities: inbox.InboxCapabilities
}

const READ_ONLY: inbox.InboxCapabilities = { send: false, attachments: false, replies: false, reactions: false, markRead: false, live: false }

// Local apps are re-read at most every couple of seconds: each list request
// used to re-query Messages and WhatsApp in full (half a second with a real
// history). Anything that must see the app's latest state passes `force`.
const TTL: Record<Provider, number> = { imessage: 2_000, whatsapp: 2_000, slack: 60_000, discord: 60_000 }

export interface SourcesOptions {
  /** Whether Attic also confirms Messages' delete alert. Read on load(). */
  confirmDeletes: () => boolean
  /** Sample data must never reach the real Messages app. */
  sample: boolean
  /** Where tokens come from; the login keychain unless a test says otherwise. */
  secrets?: (account: string) => Promise<string | null>
  /** Drivers to use instead of building them, for tests. */
  drivers?: Partial<Record<Provider, inbox.InboxDriver>>
  /** Hears the WhatsApp link's progress: codes to scan, connected, unlinked. */
  onWhatsAppLink?: (state: LinkState) => void
}

export class Sources {
  private drivers = new Map<Provider, inbox.InboxDriver>()
  private cache = new Map<Provider, { at: number, entries: LiveEntry[] }>()
  private states = new Map<Provider, SourceState>()
  private link: WhatsAppLink | null = null

  constructor(private readonly options: SourcesOptions) {}

  /**
   * Attic's WhatsApp device. One for the life of the process, whatever
   * load() rebuilds: it holds the connection to WhatsApp.
   */
  whatsappLink(): WhatsAppLink | null {
    if (this.options.sample || this.options.drivers)
      return null
    if (!this.link) {
      const readSecret = this.options.secrets ?? readKeychain
      this.link = new WhatsAppLink({
        dir: WHATSAPP_LINK_DIR,
        sealKey: async () => {
          const stored = await readSecret('whatsapp-key')
          if (stored)
            return new Uint8Array(Buffer.from(stored, 'base64'))
          const key = new Uint8Array(randomBytes(32))
          if (!(await writeKeychain('whatsapp-key', Buffer.from(key).toString('base64'))))
            throw new Error('Attic could not keep the WhatsApp key in the keychain.')
          return key
        },
        onState: state => this.options.onWhatsAppLink?.(state),
        // Linking swaps WhatsApp for Mac's database for the device; unlinking
        // swaps it back.
        onLinked: (linked) => {
          if (linked !== (this.drivers.get('whatsapp') === this.link))
            void this.load()
        },
      })
      // eslint-disable-next-line no-console
      void this.link.start().catch(error => console.error(`[attic] whatsapp: ${error instanceof Error ? error.message : String(error)}`))
    }
    return this.link
  }

  /** Build (or rebuild, after a token changes) every driver that can run. */
  async load(): Promise<void> {
    const options = this.options
    const readSecret = options.secrets ?? readKeychain
    if (options.drivers) {
      this.drivers = new Map(Object.entries(options.drivers) as Array<[Provider, inbox.InboxDriver]>)
      this.cache.clear()
      await this.refreshStates()
      return
    }
    const confirmDeletes = (): boolean => options.confirmDeletes()
    this.drivers.set('imessage', inbox.createInboxDriver('imessage', {
      databasePath: messagesDbPath(),
      addressBookDir: addressBookDir() ?? false,
      // Acting on the row by name, through the bundled helper. Never on sample
      // data: a sample "Maya Chen" must not delete a real one.
      controller: options.sample
        ? { remove: async () => ({ ok: false, detail: 'Sample data: the real Messages app is not touched.' }), recover: async () => ({ ok: false, detail: '' }) }
        : { remove: (names, url, confirm) => removeFromMessages(names, url, confirm), recover: names => recoverInMessages(names) },
      // Read once per driver; changing the setting calls load() again.
      confirmDeletes: confirmDeletes(),
    }))

    // Sample mode brings invented WhatsApp, Slack and Discord conversations
    // too, so the whole inbox works without anyone's tokens - and without
    // reading the real WhatsApp.
    if (options.sample) {
      this.drivers.set('whatsapp', sampleWhatsApp())
      this.drivers.set('slack', sampleSlack())
      this.drivers.set('discord', sampleDiscord())
      this.cache.clear()
      await this.refreshStates()
      return
    }

    const link = this.whatsappLink()!
    if (link.linked || !existsSync(whatsappDbPath())) {
      this.drivers.set('whatsapp', link)
    }
    else {
      this.drivers.set('whatsapp', inbox.createInboxDriver('whatsapp', {
        databasePath: whatsappDbPath(),
        controller: { archive: names => archiveInWhatsApp(names), unarchive: names => unarchiveInWhatsApp(names) },
      }))
    }

    ;(this.drivers.get('slack') as { close?: () => void } | undefined)?.close?.()
    const slack = slackSource(await this.slackWorkspaces())
    if (slack)
      this.drivers.set('slack', slack)
    else
      this.drivers.delete('slack')

    // A Discord driver holds a gateway session; the old one is closed first.
    ;(this.drivers.get('discord') as { close?: () => void } | undefined)?.close?.()
    const discord = await readSecret('discord')
    if (discord) {
      const account = (await readSecret('discord-account')) === 'bot' ? 'bot' : 'user'
      this.drivers.set('discord', inbox.createInboxDriver('discord', { token: discord, account, userId: (await readSecret('discord-user')) ?? undefined }))
    }
    else {
      this.drivers.delete('discord')
    }

    this.cache.clear()
    await this.refreshStates()
    this.resubscribe()
  }

  /**
   * Every signed-in Slack workspace. Attic used to keep one, as `slack` and
   * `slack-app`; that one moves into the list the first time Slack can say
   * which workspace it is.
   */
  async slackWorkspaces(): Promise<SlackWorkspace[]> {
    const readSecret = this.options.secrets ?? readKeychain
    const list = parseWorkspaces(await readSecret('slack-workspaces'))
    const legacy = await readSecret('slack')
    if (!legacy)
      return list
    const appToken = (await readSecret('slack-app')) ?? undefined
    const identity = await slackIdentity(legacy)
    if ('error' in identity)
      return [...list, { teamId: 'legacy', team: 'Slack', token: legacy, appToken }]
    const merged = [...list.filter(w => w.teamId !== identity.teamId), { ...identity, token: legacy, appToken }]
    if (!this.options.secrets && await writeKeychain('slack-workspaces', JSON.stringify(merged))) {
      await deleteSecret('slack')
      await deleteSecret('slack-app')
    }
    return merged
  }

  // ── Live events ─────────────────────────────────────────────────────

  private subscriber: ((event: SourceEvent) => void) | null = null
  private unsubscribers: Array<() => void> = []

  /**
   * Hear every app that pushes its events (Slack over Socket Mode, Discord's
   * gateway). Rebuilding the drivers subscribes the new ones. A provider's
   * cached list is dropped whenever something happens there.
   */
  listen(onEvent: (event: SourceEvent) => void): () => void {
    this.subscriber = onEvent
    this.resubscribe()
    return () => {
      this.subscriber = null
      this.resubscribe()
    }
  }

  private resubscribe(): void {
    for (const stop of this.unsubscribers.splice(0))
      stop()
    const subscriber = this.subscriber
    if (!subscriber)
      return
    for (const [provider, driver] of this.drivers) {
      if (!driver.watch)
        continue
      this.unsubscribers.push(driver.watch((event) => {
        this.invalidate(provider)
        subscriber({ provider, event })
      }))
    }
  }

  /** Hang up on the apps that hold a connection open. */
  close(): void {
    this.link?.close()
    for (const provider of ['slack', 'discord'] as const)
      (this.drivers.get(provider) as { close?: () => void } | undefined)?.close?.()
  }

  driver(provider: Provider): inbox.InboxDriver | undefined {
    return this.drivers.get(provider)
  }

  async refreshStates(): Promise<SourceState[]> {
    const all: Provider[] = ['imessage', 'whatsapp', 'slack', 'discord']
    for (const provider of all) {
      const driver = this.drivers.get(provider)
      const status = driver
        ? await driver.status()
        : { connected: false, detail: provider === 'slack' ? 'Sign in to Slack to bring it in.' : 'Sign in to Discord to bring it in.', needs: 'token' as const }
      this.states.set(provider, { provider, label: driver?.label ?? (provider === 'slack' ? 'Slack' : 'Discord'), status, capabilities: driver?.capabilities?.() ?? READ_ONLY })
    }
    return this.statesList()
  }

  statesList(): SourceState[] {
    return [...this.states.values()]
  }

  connected(provider: Provider): boolean {
    return !!this.states.get(provider)?.status.connected
  }

  /** Every conversation in every connected app. */
  /**
   * Every conversation the connected apps list. `force` re-reads them all;
   * `freshLocal` re-reads only the apps on this Mac (cheap, and what changed
   * when the archiver is asked to sync), leaving Slack and Discord cached.
   */
  async live(force = false, freshLocal = false): Promise<LiveEntry[]> {
    const lists = await Promise.all([...this.drivers.entries()].map(async ([provider, driver]) => {
      if (!this.connected(provider))
        return []
      const cached = this.cache.get(provider)
      const local = provider === 'imessage' || provider === 'whatsapp'
      if (force || (freshLocal && local) || !cached)
        return this.refresh(provider, driver)
      // Stale-while-revalidate: listing thousands of conversations takes the
      // apps most of a second, and the window should never wait on it. An old
      // list answers now while a fresh one is read behind it.
      if (Date.now() - cached.at >= TTL[provider])
        void this.refresh(provider, driver)
      return cached.entries
    }))
    return lists.flat()
  }

  private inflight = new Map<Provider, Promise<LiveEntry[]>>()

  /** Re-read one app's list, once at a time however many callers ask. */
  private refresh(provider: Provider, driver: inbox.InboxDriver): Promise<LiveEntry[]> {
    const running = this.inflight.get(provider)
    if (running)
      return running
    const read = (async () => {
      try {
        const entries = (await driver.conversations()).map(conversation => ({ key: `${provider}:${conversation.id}`, provider, conversation }))
        this.cache.set(provider, { at: Date.now(), entries })
        return entries
      }
      catch {
        // A transient failure keeps the last good list rather than emptying the inbox.
        return this.cache.get(provider)?.entries ?? []
      }
      finally {
        this.inflight.delete(provider)
      }
    })()
    this.inflight.set(provider, read)
    return read
  }


  /** Forget a provider's cached list, after acting on it. */
  invalidate(provider: Provider): void {
    this.cache.delete(provider)
  }
}
