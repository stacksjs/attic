import type { LiveConversation } from './conversations'
import type { MessageRow, MessagesDb } from './messages-db'
import type { ArchiveStore, StoredAttachment, StoredConversation, StoredMessage } from './store'
import { createHash } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { groupChats } from './conversations'

/**
 * Archiving, as Messages should have had it.
 *
 * Messages can only delete. Attic archives by copying a conversation - every
 * message, reaction, edit and attachment - into its own store, checking the
 * copy is complete, and only then letting Messages remove it. The archived
 * copy is searchable and readable forever; Messages' own Recently Deleted
 * keeps the original for 30 days on top. When the person writes again,
 * Messages starts the thread afresh and Attic brings the conversation back to
 * the Inbox with its history attached, the way an email archive does.
 */

const PAGE = 5_000

export interface ArchiveResult {
  key: string
  messages: number
  attachmentsCopied: number
  attachmentsMissing: number
  /** Every message Messages still shows is in the copy. */
  verified: boolean
}

export interface SyncReport {
  /** Archived conversations someone wrote in again, now back in the Inbox. */
  resurfaced: string[]
  /** Conversations that have just disappeared from Messages. */
  removed: string[]
  /** Conversations that came back to Messages after being removed. */
  returned: string[]
  copiedMessages: number
}

export type ResurfaceMode = 'inbox' | 'stay'

export interface TranscriptMessage extends Omit<StoredMessage, 'conversationKey' | 'sourceRowId'> {
  /** Still in Messages. False for history that only Attic holds now. */
  inMessages: boolean
  reactions: Array<{ type: number, fromMe: boolean, sender: string | null }>
}

export interface Transcript {
  key: string
  messages: TranscriptMessage[]
  /** More, older messages exist before the first one returned. */
  hasEarlier: boolean
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/** A file name safe to create, keeping its extension. */
function safeName(name: string): string {
  const cleaned = basename(name).replace(/[\u0000-\u001F/\\:]/g, '_').trim()
  return cleaned.length > 0 ? cleaned.slice(-120) : 'attachment'
}

function toStored(row: MessageRow): Omit<StoredMessage, 'conversationKey' | 'attachments'> {
  return {
    guid: row.guid,
    chatGuid: row.chatGuid,
    kind: row.kind,
    text: row.text,
    isFromMe: row.isFromMe,
    sentAt: row.sentAt,
    sender: row.sender,
    service: row.service,
    targetGuid: row.targetGuid,
    reactionType: row.reactionType,
    replyToGuid: row.replyToGuid,
    editedAt: row.editedAt,
    unsent: row.unsent,
    eventType: row.eventType,
    groupTitle: row.groupTitle,
    sourceRowId: row.rowid,
  }
}

export interface ArchiverOptions {
  store: ArchiveStore
  /** Opens chat.db. Called per operation so a revoked permission shows up at once. */
  openMessages: () => MessagesDb
  attachmentsDir: string
}

export class Archiver {
  readonly store: ArchiveStore
  private openMessages: () => MessagesDb
  readonly attachmentsDir: string

  constructor(options: ArchiverOptions) {
    this.store = options.store
    this.openMessages = options.openMessages
    this.attachmentsDir = options.attachmentsDir
  }

  private withMessages<T>(fn: (db: MessagesDb) => T): T {
    const db = this.openMessages()
    try {
      return fn(db)
    }
    finally {
      db.close()
    }
  }

  live(): LiveConversation[] {
    return this.withMessages(db => groupChats(db.chats()))
  }

  /**
   * Copy everything Messages has for a conversation that Attic does not yet,
   * above `afterRowId`. Returns the number of messages copied and the highest
   * ROWID seen.
   */
  private copy(db: MessagesDb, conversation: LiveConversation, afterRowId: number): { copied: number, maxRowId: number, attachmentsCopied: number, attachmentsMissing: number } {
    let cursor = afterRowId
    let copied = 0
    let attachmentsCopied = 0
    let attachmentsMissing = 0
    while (true) {
      const page = db.messages(conversation.chatGuids, { afterRowId: cursor, limit: PAGE, byRowId: true })
      if (page.length === 0)
        break
      this.store.upsertMessages(conversation.key, page.map(toStored))
      for (const message of page) {
        for (const attachment of message.attachments) {
          const stored = this.copyAttachment(conversation.key, message.guid, attachment)
          this.store.upsertAttachment(conversation.key, stored)
          if (stored.status === 'copied')
            attachmentsCopied++
          else
            attachmentsMissing++
        }
      }
      copied += page.length
      cursor = page[page.length - 1]!.rowid
      if (page.length < PAGE)
        break
    }
    return { copied, maxRowId: cursor, attachmentsCopied, attachmentsMissing }
  }

  /**
   * Clone the file into Attic's attachments folder. On APFS a clone shares the
   * original's blocks, so it costs no space until one side changes - and when
   * Messages deletes its copy, Attic's keeps the data.
   */
  private copyAttachment(key: string, messageGuid: string, attachment: MessageRow['attachments'][number]): StoredAttachment {
    const base: Omit<StoredAttachment, 'storedPath' | 'status'> = {
      guid: attachment.guid,
      messageGuid,
      name: attachment.name,
      mimeType: attachment.mimeType,
      bytes: attachment.bytes,
      isSticker: attachment.isSticker,
    }
    const existing = this.store.attachment(attachment.guid)
    if (existing?.status === 'copied' && existing.storedPath && existsSync(join(this.attachmentsDir, existing.storedPath)))
      return existing

    if (!attachment.path || !existsSync(attachment.path))
      return { ...base, storedPath: null, status: 'missing' }

    const relative = join(shortHash(key), attachment.guid.replace(/[^\w-]/g, '_'), safeName(attachment.name))
    const target = join(this.attachmentsDir, relative)
    try {
      mkdirSync(join(target, '..'), { recursive: true })
      copyFileSync(attachment.path, target, constants.COPYFILE_FICLONE)
      return { ...base, bytes: base.bytes || statSync(target).size, storedPath: relative, status: 'copied' }
    }
    catch {
      return { ...base, storedPath: null, status: 'missing' }
    }
  }

  private remember(conversation: LiveConversation, title: string | null): void {
    const existing = this.store.conversation(conversation.key)
    const chatGuids = [...new Set([...(existing?.chatGuids ?? []), ...conversation.chatGuids])]
    this.store.upsertConversation({
      key: conversation.key,
      kind: conversation.kind,
      title,
      participants: conversation.participants,
      chatGuids,
      groupId: conversation.groupId,
      lastMessageAt: conversation.lastMessageAt,
    })
  }

  /**
   * Archive a conversation: copy it, verify the copy, and only then mark it
   * archived. An unverified copy is kept but the conversation stays in the
   * Inbox, so nothing is ever hidden that Attic could not show again.
   */
  archive(key: string): ArchiveResult {
    return this.withMessages((db) => {
      const conversation = groupChats(db.chats()).find(c => c.key === key)
      const stored = this.store.conversation(key)
      if (!conversation) {
        // Already gone from Messages; Attic's copy is all there is.
        if (!stored)
          throw new Error(`No conversation ${key} in Messages or in Attic`)
        this.store.archive(key)
        return { key, messages: stored.messageCount, attachmentsCopied: stored.attachmentCount, attachmentsMissing: stored.missingAttachments, verified: true }
      }

      this.remember(conversation, conversation.displayName)
      const { maxRowId, attachmentsCopied, attachmentsMissing } = this.copy(db, conversation, stored?.syncedRowId ?? 0)
      this.store.setSyncedRowId(key, maxRowId)

      const live = db.messages(conversation.chatGuids, { byRowId: true }).map(m => m.guid)
      const have = new Set(this.store.messages(key).map(m => m.guid))
      const verified = live.every(guid => have.has(guid))
      if (verified)
        this.store.archive(key)

      const after = this.store.conversation(key)!
      return {
        key,
        messages: after.messageCount,
        attachmentsCopied: after.attachmentCount || attachmentsCopied,
        attachmentsMissing: after.missingAttachments || attachmentsMissing,
        verified,
      }
    })
  }

  unarchive(key: string): void {
    if (!this.store.conversation(key))
      throw new Error(`Attic has no copy of ${key}`)
    this.store.unarchive(key)
  }

  /** Forget Attic's copy, attachments included. Messages is not touched. */
  forget(key: string): void {
    this.store.forget(key)
    rmSync(join(this.attachmentsDir, shortHash(key)), { recursive: true, force: true })
  }

  /**
   * Keep every copy current: append what was said since, bring archived
   * conversations back when someone writes again, and notice conversations
   * leaving and returning to Messages.
   */
  sync(mode: ResurfaceMode = 'inbox', now = Date.now()): SyncReport {
    const report: SyncReport = { resurfaced: [], removed: [], returned: [], copiedMessages: 0 }
    const stored = this.store.conversations()
    if (stored.length === 0)
      return report

    this.withMessages((db) => {
      const live = new Map(groupChats(db.chats()).map(c => [c.key, c]))
      for (const conversation of stored) {
        const current = live.get(conversation.key)
        const visible = !!current && current.messageCount > 0

        if (!visible && conversation.removedAt === null) {
          this.store.markRemoved(conversation.key, now)
          report.removed.push(conversation.key)
        }
        else if (visible && conversation.removedAt !== null) {
          this.store.markRemoved(conversation.key, null)
          report.returned.push(conversation.key)
        }

        if (!current || current.lastMessageRowId <= conversation.syncedRowId)
          continue

        this.remember(current, current.displayName)
        const { copied, maxRowId } = this.copy(db, current, conversation.syncedRowId)
        this.store.setSyncedRowId(conversation.key, maxRowId)
        report.copiedMessages += copied

        const fresh = db.messages(current.chatGuids, { afterRowId: conversation.syncedRowId }).some(m => m.kind === 'message')
        if (fresh && conversation.state === 'archived' && mode === 'inbox') {
          this.store.unarchive(conversation.key, { resurfaced: true, at: now })
          report.resurfaced.push(conversation.key)
        }
      }
    })
    return report
  }

  /**
   * One conversation as a person reads it: what Messages still has, plus what
   * only Attic remembers, newest `limit` messages before `beforeMs`.
   * Reactions are folded onto the messages they react to.
   */
  transcript(key: string, options: { beforeMs?: number, limit?: number } = {}): Transcript {
    const limit = options.limit ?? 300
    const stored = this.store.conversation(key)

    const liveRows = this.withMessages((db) => {
      const conversation = groupChats(db.chats()).find(c => c.key === key)
      const guids = [...new Set([...(conversation?.chatGuids ?? []), ...(stored?.chatGuids ?? [])])]
      return db.messages(guids, { beforeMs: options.beforeMs, limit: limit * 2, newestFirst: true })
    })

    const byGuid = new Map<string, TranscriptMessage>()
    for (const row of liveRows) {
      byGuid.set(row.guid, {
        ...toStored(row),
        attachments: row.attachments.map(a => ({
          guid: a.guid,
          messageGuid: row.guid,
          name: a.name,
          mimeType: a.mimeType,
          bytes: a.bytes,
          isSticker: a.isSticker,
          storedPath: null,
          status: a.path ? 'copied' : 'missing',
        })),
        inMessages: true,
        reactions: [],
      })
    }

    if (stored) {
      const cutoff = options.beforeMs ?? Number.POSITIVE_INFINITY
      for (const message of this.store.messages(key)) {
        if (message.sentAt >= cutoff || byGuid.has(message.guid))
          continue
        const { conversationKey: _, sourceRowId: __, ...rest } = message
        byGuid.set(message.guid, { ...rest, inMessages: false, reactions: [] })
      }
    }

    const all = [...byGuid.values()].sort((a, b) => a.sentAt - b.sentAt)
    const reactions = all.filter(m => m.kind === 'reaction')
    const visible = all.filter(m => m.kind !== 'reaction')
    const index = new Map(visible.map(m => [m.guid, m]))
    for (const reaction of reactions) {
      const target = reaction.targetGuid ? index.get(reaction.targetGuid) : undefined
      if (!target)
        continue
      // 3000-3006 remove the matching 2000-2006 reaction.
      if (reaction.reactionType >= 3000) {
        const added = reaction.reactionType - 1000
        const at = target.reactions.findIndex(r => r.type === added && r.fromMe === reaction.isFromMe && r.sender === reaction.sender)
        if (at !== -1)
          target.reactions.splice(at, 1)
        continue
      }
      target.reactions.push({ type: reaction.reactionType, fromMe: reaction.isFromMe, sender: reaction.sender })
    }

    const page = visible.slice(-limit)
    // A full live page means Messages may hold older ones not fetched yet.
    return { key, messages: page, hasEarlier: visible.length > limit || liveRows.length >= limit * 2 }
  }

  /** Resolve an attachment to a file on disk: Attic's copy first, then Messages'. */
  attachmentFile(guid: string): { path: string, mimeType: string | null, name: string } | null {
    const stored = this.store.attachment(guid)
    if (stored?.status === 'copied' && stored.storedPath) {
      const path = join(this.attachmentsDir, stored.storedPath)
      if (existsSync(path))
        return { path, mimeType: stored.mimeType, name: stored.name }
    }
    const live = this.withMessages(db => db.attachmentPath(guid))
    if (live?.path && existsSync(live.path))
      return { path: live.path, mimeType: live.mimeType, name: live.name }
    return null
  }

  conversation(key: string): StoredConversation | null {
    return this.store.conversation(key)
  }
}
