import type { inbox } from '@stacksjs/chat'
import type { LiveEntry, Sources } from './sources'
import type { ArchiveStore, Provider, StoredAttachment, StoredConversation, StoredMessage } from './store'
import { createHash } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { conversationKey, splitKey } from './store'

/**
 * Archiving, as the apps should have had it, for every source at once.
 *
 * Archiving copies a conversation - every message, reaction, edit and
 * attachment - into Attic's own store, checks the copy is complete, and only
 * then takes it out of the real app, as far as that app allows (the driver's
 * `archive` does that part and says what it did). The copy stays searchable
 * and readable for good. When someone writes again, the conversation comes
 * back to the Inbox with its history attached, the way an email archive does.
 */

/** How many messages one archive copies at most: a lifetime of a busy channel. */
const COPY_LIMIT = 100_000

export interface ArchiveResult {
  key: string
  messages: number
  attachmentsCopied: number
  attachmentsMissing: number
  /** Every message the app still shows is in the copy. */
  verified: boolean
}

export interface SyncReport {
  /** Archived conversations someone wrote in again, now back in the Inbox. */
  resurfaced: string[]
  /** Conversations that have just left the real app. */
  removed: string[]
  /** Conversations that came back to the real app. */
  returned: string[]
  copiedMessages: number
}

export type ResurfaceMode = 'inbox' | 'stay'

export interface TranscriptMessage extends Omit<StoredMessage, 'conversationKey' | 'cursor'> {
  /** Still in the real app. False for history only Attic holds now. */
  inApp: boolean
  reactions: Array<{ reaction: string, fromMe: boolean, senderName: string | null }>
}

export interface Transcript {
  key: string
  messages: TranscriptMessage[]
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/** A file name safe to create, keeping its extension. */
function safeName(name: string): string {
  const cleaned = basename(name).replace(/[\u0000-\u001F/\\:]/g, '_').trim()
  return cleaned.length > 0 ? cleaned.slice(-120) : 'attachment'
}

function toStored(message: inbox.InboxMessage): Omit<StoredMessage, 'conversationKey' | 'attachments'> {
  return {
    guid: message.id,
    kind: message.kind,
    text: message.text,
    isFromMe: message.fromMe,
    sentAt: message.sentAt,
    sender: message.sender?.id ?? null,
    senderName: message.sender?.name ?? null,
    targetGuid: message.targetId,
    reaction: message.reaction,
    reactionRemoved: message.reactionRemoved,
    replyToGuid: message.replyToId,
    editedAt: message.editedAt,
    unsent: message.unsent,
    cursor: message.cursor,
  }
}

/** The later of two provider cursors: numeric where they are (ROWIDs, snowflakes, Slack ts). */
function laterCursor(a: string | null, b: string | null): string | null {
  if (!a)
    return b
  if (!b)
    return a
  const x = Number(a)
  const y = Number(b)
  if (!Number.isNaN(x) && !Number.isNaN(y))
    return y > x ? b : a
  return b > a ? b : a
}

export interface ArchiverOptions {
  store: ArchiveStore
  sources: Sources
  attachmentsDir: string
}

export class Archiver {
  readonly store: ArchiveStore
  readonly sources: Sources
  readonly attachmentsDir: string
  /** Attachments of conversations shown but not saved, for serving them. */
  private recentAttachments = new Map<string, { provider: Provider, attachment: inbox.InboxAttachment }>()

  constructor(options: ArchiverOptions) {
    this.store = options.store
    this.sources = options.sources
    this.attachmentsDir = options.attachmentsDir
  }

  private driverFor(key: string) {
    const { provider, id } = splitKey(key)
    const driver = this.sources.driver(provider)
    if (!driver)
      throw new Error(`${provider} is not connected`)
    return { provider, id, driver }
  }

  /**
   * Keep the attachment: clone a local file (on APFS a clone shares blocks,
   * so it costs nothing until one side changes, and outlives the original),
   * or download a remote one through the driver's credentials.
   */
  private async copyAttachment(key: string, provider: Provider, messageGuid: string, attachment: inbox.InboxAttachment): Promise<StoredAttachment> {
    const base = { guid: attachment.id, messageGuid, name: attachment.name, mimeType: attachment.mimeType, bytes: attachment.bytes, isSticker: false }
    const existing = this.store.attachment(attachment.id)
    if (existing?.status === 'copied' && existing.storedPath && existsSync(join(this.attachmentsDir, existing.storedPath)))
      return existing

    const relative = join(shortHash(key), attachment.id.replace(/[^\w-]/g, '_'), safeName(attachment.name))
    const target = join(this.attachmentsDir, relative)
    try {
      mkdirSync(dirname(target), { recursive: true })
      if (attachment.path && existsSync(attachment.path)) {
        copyFileSync(attachment.path, target, constants.COPYFILE_FICLONE)
      }
      else if (attachment.url) {
        const response = await this.sources.driver(provider)!.attachment(attachment)
        if (!response.ok)
          return { ...base, storedPath: null, status: 'missing' }
        await Bun.write(target, response)
      }
      else {
        return { ...base, storedPath: null, status: 'missing' }
      }
      return { ...base, bytes: base.bytes || statSync(target).size, storedPath: relative, status: 'copied' }
    }
    catch {
      return { ...base, storedPath: null, status: 'missing' }
    }
  }

  /** Copy everything after the stored cursor. Returns what was copied. */
  private async copy(entry: LiveEntry | undefined, key: string): Promise<{ messages: inbox.InboxMessage[], copied: number, missing: number }> {
    const { provider, id, driver } = this.driverFor(key)
    const stored = this.store.conversation(key)
    // Recently Deleted included: a conversation deleted in the app can still be kept.
    const messages = await driver.messages(id, { after: stored?.syncedCursor ?? '0', limit: COPY_LIMIT, includeDeleted: true })
    if (entry) {
      this.store.upsertConversation({
        key,
        provider,
        kind: entry.conversation.kind,
        title: entry.conversation.title,
        participants: entry.conversation.participants,
        workspace: entry.conversation.workspace,
        url: entry.conversation.url,
        avatar: entry.conversation.avatar ?? null,
        lastMessageAt: entry.conversation.lastMessageAt,
      })
    }
    if (messages.length === 0)
      return { messages, copied: 0, missing: 0 }

    this.store.upsertMessages(key, messages.map(toStored))
    let copied = 0
    let missing = 0
    for (const message of messages) {
      for (const attachment of message.attachments) {
        const kept = await this.copyAttachment(key, provider, message.id, attachment)
        this.store.upsertAttachment(key, kept)
        if (kept.status === 'copied')
          copied++
        else
          missing++
      }
    }
    let cursor = stored?.syncedCursor ?? null
    for (const message of messages)
      cursor = laterCursor(cursor, message.cursor)
    if (cursor)
      this.store.setSyncedCursor(key, cursor)
    return { messages, copied, missing }
  }

  private async entry(key: string, force = false): Promise<LiveEntry | undefined> {
    return (await this.sources.live(force, true)).find(e => e.key === key)
  }

  /**
   * Copy a conversation and verify the copy. An unverified copy is kept, but
   * the conversation is not archived, so nothing is hidden that Attic could
   * not show again.
   */
  async archive(key: string): Promise<ArchiveResult> {
    const entry = await this.entry(key, true)
    const stored = this.store.conversation(key)
    if (!entry && !stored)
      throw new Error(`No conversation ${key}`)

    let verified = true
    if (entry) {
      await this.copy(entry, key)
      // Everything the app still holds must now be in the store.
      const { id, driver } = this.driverFor(key)
      const all = await driver.messages(id, { after: '0', limit: COPY_LIMIT, includeDeleted: true })
      const have = new Set(this.store.messages(key).map(m => m.guid))
      verified = all.every(m => have.has(m.id))
    }
    if (verified)
      this.store.archive(key)

    const after = this.store.conversation(key)!
    return { key, messages: after.messageCount, attachmentsCopied: after.attachmentCount, attachmentsMissing: after.missingAttachments, verified }
  }

  /** Take an archived conversation out of the real app, as far as it allows. */
  async removeFromApp(key: string): Promise<inbox.ArchiveOutcome> {
    const { provider, id, driver } = this.driverFor(key)
    const outcome = await driver.archive(id)
    this.sources.invalidate(provider)
    return outcome
  }

  /** Put it back in the real app where possible, and back in the Inbox. */
  async unarchive(key: string): Promise<void> {
    if (!this.store.conversation(key))
      throw new Error(`Attic has no copy of ${key}`)
    const { provider, id, driver } = this.driverFor(key)
    await driver.unarchive(id)
    this.sources.invalidate(provider)
    this.store.unarchive(key)
  }

  /** Forget Attic's copy, attachments included. The real app is not touched. */
  forget(key: string): void {
    for (const attachment of this.store.forget(key)) {
      if (attachment.storedPath)
        rmSync(dirname(join(this.attachmentsDir, attachment.storedPath)), { recursive: true, force: true })
    }
    rmSync(join(this.attachmentsDir, shortHash(key)), { recursive: true, force: true })
  }

  /**
   * Keep every copy current: append what was said since, bring archived
   * conversations back when someone writes again, and notice conversations
   * leaving and returning to their apps.
   */
  async sync(mode: ResurfaceMode = 'inbox', now = Date.now(), force = false): Promise<SyncReport> {
    const report: SyncReport = { resurfaced: [], removed: [], returned: [], copiedMessages: 0 }
    const stored = this.store.conversations()
    if (stored.length === 0)
      return report

    const live = new Map((await this.sources.live(force, true)).map(e => [e.key, e]))
    for (const conversation of stored) {
      if (!this.sources.connected(conversation.provider))
        continue
      const current = live.get(conversation.key)
      const visible = !!current?.conversation.visible

      if (!visible && conversation.removedAt === null) {
        // Messages deletes the history; Slack and Discord only hide it.
        this.store.markRemoved(conversation.key, now, conversation.provider === 'imessage')
        report.removed.push(conversation.key)
      }
      else if (visible && conversation.removedAt !== null) {
        this.store.markRemoved(conversation.key, null)
        report.returned.push(conversation.key)
      }

      if (!current || current.conversation.cursor === conversation.syncedCursor || laterCursor(conversation.syncedCursor, current.conversation.cursor) === conversation.syncedCursor)
        continue

      try {
        const { messages } = await this.copy(current, conversation.key)
        report.copiedMessages += messages.length
        const fresh = messages.some(m => m.kind === 'message')
        if (fresh && conversation.state === 'archived' && mode === 'inbox') {
          this.store.unarchive(conversation.key, { resurfaced: true, at: now })
          report.resurfaced.push(conversation.key)
        }
      }
      catch {
        // An API hiccup: the next sync tries again.
      }
    }
    return report
  }

  /**
   * One conversation as a person reads it: what the app still has, plus what
   * only Attic remembers. Reactions are folded onto their messages.
   */
  async transcript(key: string, limit = 300): Promise<Transcript> {
    const stored = this.store.conversation(key)
    const { provider, id } = splitKey(key)
    const driver = this.sources.driver(provider)

    let live: inbox.InboxMessage[] = []
    if (driver && this.sources.connected(provider)) {
      try {
        live = await driver.messages(id, stored?.syncedCursor ? { after: stored.syncedCursor, limit: COPY_LIMIT } : { limit, includeDeleted: !(await this.entry(key))?.conversation.visible })
      }
      catch {}
    }

    const byGuid = new Map<string, TranscriptMessage>()
    if (stored) {
      // History the app deleted, or that is hidden right now, only Attic shows.
      const goneBefore = stored.goneBefore ?? 0
      for (const message of this.store.messages(key)) {
        const { conversationKey: _, cursor: __, ...rest } = message
        byGuid.set(message.guid, { ...rest, inApp: stored.removedAt === null && message.sentAt > goneBefore, reactions: [] })
      }
    }
    for (const message of live) {
      for (const attachment of message.attachments)
        this.recentAttachments.set(attachment.id, { provider, attachment })
      const { cursor: _, ...rest } = toStored(message)
      byGuid.set(message.id, {
        ...rest,
        attachments: byGuid.get(message.id)?.attachments ?? message.attachments.map(a => ({
          guid: a.id,
          messageGuid: message.id,
          name: a.name,
          mimeType: a.mimeType,
          bytes: a.bytes,
          isSticker: false,
          storedPath: null,
          status: a.path || a.url ? 'copied' as const : 'missing' as const,
        })),
        inApp: true,
        reactions: [],
      })
    }

    const all = [...byGuid.values()].sort((a, b) => a.sentAt - b.sentAt)
    const visible = all.filter(m => m.kind !== 'reaction')
    const index = new Map(visible.map(m => [m.guid, m]))
    for (const reaction of all.filter(m => m.kind === 'reaction')) {
      const target = reaction.targetGuid ? index.get(reaction.targetGuid) : undefined
      if (!target || !reaction.reaction)
        continue
      if (reaction.reactionRemoved) {
        const at = target.reactions.findIndex(r => r.reaction === reaction.reaction && r.fromMe === reaction.isFromMe)
        if (at !== -1)
          target.reactions.splice(at, 1)
        continue
      }
      target.reactions.push({ reaction: reaction.reaction, fromMe: reaction.isFromMe, senderName: reaction.senderName })
    }
    return { key, messages: visible.slice(-Math.max(limit, stored ? visible.length : 0)) }
  }

  /** An attachment's bytes: Attic's copy first, then the app's. */
  async attachmentResponse(guid: string): Promise<Response | null> {
    const stored = this.store.attachment(guid)
    if (stored?.status === 'copied' && stored.storedPath) {
      const path = join(this.attachmentsDir, stored.storedPath)
      if (existsSync(path))
        return new Response(Bun.file(path), { headers: { 'content-type': stored.mimeType ?? 'application/octet-stream' } })
    }
    const recent = this.recentAttachments.get(guid)
    const driver = recent && this.sources.driver(recent.provider)
    if (!recent || !driver)
      return null
    return driver.attachment(recent.attachment)
  }

  conversation(key: string): StoredConversation | null {
    return this.store.conversation(key)
  }
}

export { conversationKey }
