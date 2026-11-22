import { inbox } from '@stacksjs/chat'

/**
 * Several Slack workspaces as one inbox source.
 *
 * A Slack user token belongs to one workspace, so a person in three
 * workspaces signs in three times, each through an Attic app of their own in
 * that workspace. This driver puts the workspaces' drivers behind the one
 * `slack` source: it lists every workspace's conversations together and
 * sends each action to the workspace the conversation belongs to. Slack's
 * channel ids are unique across workspaces, so a conversation keeps the id
 * it had when Attic knew a single workspace.
 */

/** One signed-in workspace, as the keychain keeps it. */
export interface SlackWorkspace {
  teamId: string
  team: string
  token: string
  appToken?: string
}

/** Who a user token belongs to, from Slack itself. */
export async function slackIdentity(token: string, fetcher: typeof fetch = fetch): Promise<{ teamId: string, team: string } | { error: string }> {
  try {
    const response = await fetcher('https://slack.com/api/auth.test', { method: 'POST', headers: { authorization: `Bearer ${token}` } })
    const data = await response.json() as { ok?: boolean, team_id?: string, team?: string, error?: string }
    if (!data.ok || !data.team_id)
      return { error: data.error === 'invalid_auth' || data.error === 'not_authed' ? 'Slack did not accept that token. Copy the User OAuth Token (xoxp-) again.' : `Slack said ${data.error ?? `HTTP ${response.status}`}.` }
    return { teamId: data.team_id, team: data.team ?? data.team_id }
  }
  catch (error) {
    return { error: `Slack could not be reached: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Parse the keychain's list, tolerating anything malformed as no workspaces. */
export function parseWorkspaces(json: string | null): SlackWorkspace[] {
  if (!json)
    return []
  try {
    const list = JSON.parse(json) as unknown
    return Array.isArray(list)
      ? list.filter((w): w is SlackWorkspace => !!w && typeof w.teamId === 'string' && typeof w.token === 'string').map(w => ({ teamId: w.teamId, team: typeof w.team === 'string' ? w.team : w.teamId, token: w.token, appToken: typeof w.appToken === 'string' && w.appToken ? w.appToken : undefined }))
      : []
  }
  catch {
    return []
  }
}

/** Add a workspace, or replace its tokens when it is already there. */
export function upsertWorkspace(list: SlackWorkspace[], workspace: SlackWorkspace): SlackWorkspace[] {
  return [...list.filter(w => w.teamId !== workspace.teamId), workspace]
}

export class SlackWorkspaces implements inbox.InboxDriver {
  readonly provider = 'slack' as const
  readonly label = 'Slack'
  /** Which workspace each conversation, and each attachment seen, belongs to. */
  private owners = new Map<string, inbox.InboxDriver>()
  private attachmentOwners = new Map<string, inbox.InboxDriver>()

  constructor(private readonly drivers: inbox.InboxDriver[]) {}

  async status(): Promise<inbox.InboxStatus> {
    const states = await Promise.all(this.drivers.map(d => d.status()))
    const connected = states.filter(s => s.connected)
    if (connected.length === 0)
      return states[0] ?? { connected: false, detail: 'Sign in to Slack to bring it in.', needs: 'token' }
    const failing = states.length - connected.length
    return {
      connected: true,
      detail: `${connected.map(s => s.detail.replace(/^Signed in to (.*)\.$/, '$1')).join(', ')}${failing ? `. ${failing} more ${failing === 1 ? 'workspace needs' : 'workspaces need'} signing in again.` : '.'}`,
    }
  }

  capabilities(): inbox.InboxCapabilities {
    const all = this.drivers.map(d => d.capabilities?.() ?? { send: false, attachments: false, replies: false, reactions: false, markRead: false, live: false })
    return {
      send: all.some(c => c.send),
      attachments: all.some(c => c.attachments),
      replies: all.some(c => c.replies),
      reactions: all.some(c => c.reactions),
      markRead: all.some(c => c.markRead),
      live: all.some(c => c.live),
    }
  }

  async conversations(): Promise<inbox.InboxConversation[]> {
    const lists = await Promise.all(this.drivers.map(async (driver) => {
      try {
        const conversations = await driver.conversations()
        for (const conversation of conversations)
          this.owners.set(conversation.id, driver)
        return conversations
      }
      catch {
        // One workspace failing leaves the others' conversations in the inbox.
        return []
      }
    }))
    return lists.flat()
  }

  /** The workspace a conversation is in, listing them once if it is not known yet. */
  private async owner(conversationId: string): Promise<inbox.InboxDriver> {
    if (!this.owners.has(conversationId))
      await this.conversations()
    const driver = this.owners.get(conversationId)
    if (!driver)
      throw new Error('That Slack conversation is not in any signed-in workspace.')
    return driver
  }

  async messages(conversationId: string, query?: inbox.MessageQuery): Promise<inbox.InboxMessage[]> {
    const driver = await this.owner(conversationId)
    const messages = await driver.messages(conversationId, query)
    for (const message of messages) {
      for (const attachment of message.attachments)
        this.attachmentOwners.set(attachment.id, driver)
    }
    return messages
  }

  async archive(conversationId: string): Promise<inbox.ArchiveOutcome> {
    return (await this.owner(conversationId)).archive(conversationId)
  }

  async unarchive(conversationId: string): Promise<void> {
    return (await this.owner(conversationId)).unarchive(conversationId)
  }

  async send(conversationId: string, message: inbox.OutgoingMessage): Promise<inbox.SendOutcome> {
    const driver = await this.owner(conversationId)
    if (!driver.send)
      throw new Error('Chatfold cannot send to this Slack workspace.')
    return driver.send(conversationId, message)
  }

  async react(conversationId: string, messageId: string, reaction: string, remove?: boolean): Promise<void> {
    const driver = await this.owner(conversationId)
    if (!driver.react)
      throw new Error('Chatfold cannot react in this Slack workspace.')
    return driver.react(conversationId, messageId, reaction, remove)
  }

  async markRead(conversationId: string): Promise<void> {
    return (await this.owner(conversationId)).markRead?.(conversationId)
  }

  async attachment(attachment: inbox.InboxAttachment): Promise<Response> {
    const known = this.attachmentOwners.get(attachment.id)
    // A file is private to its workspace: without knowing which, each
    // workspace's token is tried in turn.
    for (const driver of known ? [known] : this.drivers) {
      const response = await driver.attachment(attachment).catch(() => null)
      if (response?.ok)
        return response
    }
    return new Response('Not found', { status: 404 })
  }

  async avatar(ref: string): Promise<Response> {
    // Profile pictures are public images on Slack's hosts; any workspace fetches them.
    return this.drivers[0]?.avatar?.(ref) ?? new Response('Not found', { status: 404 })
  }

  watch(onEvent: (event: inbox.InboxEvent) => void): () => void {
    const stops = this.drivers.filter(d => d.watch).map(driver => driver.watch!((event) => {
      if (event.conversationId)
        this.owners.set(event.conversationId, driver)
      onEvent(event)
    }))
    return () => {
      for (const stop of stops)
        stop()
    }
  }

  close(): void {
    for (const driver of this.drivers)
      (driver as { close?: () => void }).close?.()
  }
}

/** One driver per workspace, behind a single source when there is more than one. */
export function slackSource(workspaces: SlackWorkspace[]): inbox.InboxDriver | null {
  const drivers = workspaces.map(w => inbox.createInboxDriver('slack', { token: w.token, appToken: w.appToken }))
  if (drivers.length === 0)
    return null
  return drivers.length === 1 ? drivers[0]! : new SlackWorkspaces(drivers)
}
