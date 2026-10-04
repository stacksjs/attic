import type { Provider } from './store'
import { inbox } from '@stacksjs/chat'
import { readSecret as readKeychain } from './keychain'
import { recoverInMessages, removeFromMessages } from './messages-app'
import { addressBookDir, messagesDbPath } from './paths'
import { sampleDiscord, sampleSlack } from './sample-sources'

/**
 * The apps Attic reads, through the inbox drivers in `@stacksjs/chat`.
 *
 * iMessage is always present (it needs only Full Disk Access). Slack and
 * Discord join once their tokens are in the keychain. Listing is cached: the
 * iMessage list is a local query, but Slack and Discord cost an API call per
 * conversation, so they are re-read at most once a minute unless forced.
 */

export interface LiveEntry {
  key: string
  provider: Provider
  conversation: inbox.InboxConversation
}

export interface SourceState {
  provider: Provider
  label: string
  status: inbox.InboxStatus
}

const TTL: Record<Provider, number> = { imessage: 0, slack: 60_000, discord: 60_000 }

export interface SourcesOptions {
  /** Whether Attic also confirms Messages' delete alert. Read on load(). */
  confirmDeletes: () => boolean
  /** Sample data must never reach the real Messages app. */
  sample: boolean
  /** Where tokens come from; the login keychain unless a test says otherwise. */
  secrets?: (account: string) => Promise<string | null>
  /** Drivers to use instead of building them, for tests. */
  drivers?: Partial<Record<Provider, inbox.InboxDriver>>
}

export class Sources {
  private drivers = new Map<Provider, inbox.InboxDriver>()
  private cache = new Map<Provider, { at: number, entries: LiveEntry[] }>()
  private states = new Map<Provider, SourceState>()

  constructor(private readonly options: SourcesOptions) {}

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

    // Sample mode brings invented Slack and Discord conversations too, so the
    // whole inbox works without anyone's tokens.
    if (options.sample) {
      this.drivers.set('slack', sampleSlack())
      this.drivers.set('discord', sampleDiscord())
      this.cache.clear()
      await this.refreshStates()
      return
    }

    const slack = await readSecret('slack')
    if (slack)
      this.drivers.set('slack', inbox.createInboxDriver('slack', { token: slack }))
    else
      this.drivers.delete('slack')

    const discord = await readSecret('discord')
    if (discord)
      this.drivers.set('discord', inbox.createInboxDriver('discord', { token: discord, userId: (await readSecret('discord-user')) ?? undefined }))
    else
      this.drivers.delete('discord')

    this.cache.clear()
    await this.refreshStates()
  }

  driver(provider: Provider): inbox.InboxDriver | undefined {
    return this.drivers.get(provider)
  }

  async refreshStates(): Promise<SourceState[]> {
    const all: Provider[] = ['imessage', 'slack', 'discord']
    for (const provider of all) {
      const driver = this.drivers.get(provider)
      const status = driver
        ? await driver.status()
        : { connected: false, detail: provider === 'slack' ? 'Add a Slack user token to bring Slack in.' : 'Add a Discord bot token to bring Discord in.', needs: 'token' as const }
      this.states.set(provider, { provider, label: driver?.label ?? (provider === 'slack' ? 'Slack' : 'Discord'), status })
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
  async live(force = false): Promise<LiveEntry[]> {
    const lists = await Promise.all([...this.drivers.entries()].map(async ([provider, driver]) => {
      if (!this.connected(provider))
        return []
      const cached = this.cache.get(provider)
      if (!force && cached && Date.now() - cached.at < TTL[provider])
        return cached.entries
      try {
        const entries = (await driver.conversations()).map(conversation => ({ key: `${provider}:${conversation.id}`, provider, conversation }))
        this.cache.set(provider, { at: Date.now(), entries })
        return entries
      }
      catch {
        // A transient API failure keeps the last good list rather than emptying the inbox.
        return cached?.entries ?? []
      }
    }))
    return lists.flat()
  }

  /** Forget a provider's cached list, after acting on it. */
  invalidate(provider: Provider): void {
    this.cache.delete(provider)
  }
}
