import type { MessageKind } from './messages-db'
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Attic's own database: the copies it keeps of archived conversations, so
 * they outlive Messages deleting them.
 *
 * Plain bun:sqlite rather than Stacks models, deliberately. This file ships
 * inside the desktop app, where there is no project tree, no migrations
 * runner and no query builder - only the binary - and it needs an FTS5 index
 * the model layer cannot declare. The schema is small and created idempotently
 * on open.
 */

export type ConversationState = 'archived' | 'unarchived'

export interface StoredConversation {
  key: string
  kind: 'direct' | 'group'
  title: string | null
  participants: string[]
  chatGuids: string[]
  groupId: string | null
  state: ConversationState
  archivedAt: number | null
  unarchivedAt: number | null
  /** New messages arrived after archiving. */
  resurfacedAt: number | null
  /** Attic saw the conversation gone from Messages. */
  removedAt: number | null
  lastMessageAt: number | null
  /** Highest chat.db message ROWID copied; anything above is new. */
  syncedRowId: number
  messageCount: number
  attachmentCount: number
  attachmentBytes: number
  missingAttachments: number
}

export interface StoredAttachment {
  guid: string
  messageGuid: string
  name: string
  mimeType: string | null
  bytes: number
  isSticker: boolean
  /** Relative to the attachments directory; null when there was nothing to copy. */
  storedPath: string | null
  status: 'copied' | 'missing'
}

export interface StoredMessage {
  guid: string
  conversationKey: string
  chatGuid: string
  kind: MessageKind
  text: string | null
  isFromMe: boolean
  sentAt: number
  sender: string | null
  service: string | null
  targetGuid: string | null
  reactionType: number
  replyToGuid: string | null
  editedAt: number | null
  unsent: boolean
  eventType: number
  groupTitle: string | null
  sourceRowId: number | null
  attachments: StoredAttachment[]
}

export interface SearchHit {
  conversationKey: string
  guid: string
  sentAt: number
  isFromMe: boolean
  sender: string | null
  /** The matching text with `\u0001`/`\u0002` around each match. */
  snippet: string
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS conversations (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT,
    participants TEXT NOT NULL DEFAULT '[]',
    chat_guids TEXT NOT NULL DEFAULT '[]',
    group_id TEXT,
    state TEXT NOT NULL DEFAULT 'archived',
    archived_at INTEGER,
    unarchived_at INTEGER,
    resurfaced_at INTEGER,
    removed_at INTEGER,
    last_message_at INTEGER,
    synced_rowid INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    guid TEXT PRIMARY KEY,
    conversation_key TEXT NOT NULL,
    chat_guid TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT,
    is_from_me INTEGER NOT NULL,
    sent_at INTEGER NOT NULL,
    sender TEXT,
    service TEXT,
    target_guid TEXT,
    reaction_type INTEGER NOT NULL DEFAULT 0,
    reply_to_guid TEXT,
    edited_at INTEGER,
    unsent INTEGER NOT NULL DEFAULT 0,
    event_type INTEGER NOT NULL DEFAULT 0,
    group_title TEXT,
    source_rowid INTEGER
  );
  CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (conversation_key, sent_at);

  CREATE TABLE IF NOT EXISTS attachments (
    guid TEXT PRIMARY KEY,
    message_guid TEXT NOT NULL,
    conversation_key TEXT NOT NULL,
    name TEXT NOT NULL,
    mime_type TEXT,
    bytes INTEGER NOT NULL DEFAULT 0,
    is_sticker INTEGER NOT NULL DEFAULT 0,
    stored_path TEXT,
    status TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS attachments_by_message ON attachments (message_guid);
  CREATE INDEX IF NOT EXISTS attachments_by_conversation ON attachments (conversation_key);

  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (text, content = 'messages', content_rowid = 'rowid', tokenize = 'unicode61 remove_diacritics 2');
  CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF text ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text);
  END;

  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

interface ConversationRow {
  key: string
  kind: string
  title: string | null
  participants: string
  chat_guids: string
  group_id: string | null
  state: string
  archived_at: number | null
  unarchived_at: number | null
  resurfaced_at: number | null
  removed_at: number | null
  last_message_at: number | null
  synced_rowid: number
  message_count: number
  attachment_count: number
  attachment_bytes: number
  missing_attachments: number
}

interface MessageDbRow {
  guid: string
  conversation_key: string
  chat_guid: string
  kind: string
  text: string | null
  is_from_me: number
  sent_at: number
  sender: string | null
  service: string | null
  target_guid: string | null
  reaction_type: number
  reply_to_guid: string | null
  edited_at: number | null
  unsent: number
  event_type: number
  group_title: string | null
  source_rowid: number | null
}

interface AttachmentDbRow {
  guid: string
  message_guid: string
  name: string
  mime_type: string | null
  bytes: number
  is_sticker: number
  stored_path: string | null
  status: string
}

const CONVERSATION_SELECT = `
  SELECT c.*,
    (SELECT COUNT(*) FROM messages m WHERE m.conversation_key = c.key AND m.kind = 'message') AS message_count,
    (SELECT COUNT(*) FROM attachments a WHERE a.conversation_key = c.key AND a.status = 'copied') AS attachment_count,
    (SELECT COALESCE(SUM(a.bytes), 0) FROM attachments a WHERE a.conversation_key = c.key AND a.status = 'copied') AS attachment_bytes,
    (SELECT COUNT(*) FROM attachments a WHERE a.conversation_key = c.key AND a.status = 'missing') AS missing_attachments
  FROM conversations c
`

function toConversation(row: ConversationRow): StoredConversation {
  return {
    key: row.key,
    kind: row.kind === 'group' ? 'group' : 'direct',
    title: row.title,
    participants: JSON.parse(row.participants) as string[],
    chatGuids: JSON.parse(row.chat_guids) as string[],
    groupId: row.group_id,
    state: row.state === 'unarchived' ? 'unarchived' : 'archived',
    archivedAt: row.archived_at,
    unarchivedAt: row.unarchived_at,
    resurfacedAt: row.resurfaced_at,
    removedAt: row.removed_at,
    lastMessageAt: row.last_message_at,
    syncedRowId: row.synced_rowid,
    messageCount: row.message_count,
    attachmentCount: row.attachment_count,
    attachmentBytes: row.attachment_bytes,
    missingAttachments: row.missing_attachments,
  }
}

function toAttachment(row: AttachmentDbRow): StoredAttachment {
  return {
    guid: row.guid,
    messageGuid: row.message_guid,
    name: row.name,
    mimeType: row.mime_type,
    bytes: row.bytes,
    isSticker: row.is_sticker === 1,
    storedPath: row.stored_path,
    status: row.status === 'copied' ? 'copied' : 'missing',
  }
}

/**
 * FTS5 query syntax treats `"`, `*`, `:`, `-`, `AND`... specially. A search
 * box is free text, so each word is quoted and matched as a prefix.
 */
export function ftsQuery(input: string): string | null {
  const words = input.split(/\s+/).map(w => w.replace(/"/g, '')).filter(Boolean)
  if (words.length === 0)
    return null
  return words.map(w => `"${w}"*`).join(' ')
}

export class ArchiveStore {
  readonly db: Database

  constructor(public readonly path: string) {
    if (path !== ':memory:')
      mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  upsertConversation(c: Pick<StoredConversation, 'key' | 'kind' | 'title' | 'participants' | 'chatGuids' | 'groupId' | 'lastMessageAt'>): void {
    this.db.query(`
      INSERT INTO conversations (key, kind, title, participants, chat_guids, group_id, last_message_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT (key) DO UPDATE SET
        kind = excluded.kind,
        title = COALESCE(excluded.title, conversations.title),
        participants = excluded.participants,
        chat_guids = excluded.chat_guids,
        group_id = COALESCE(excluded.group_id, conversations.group_id),
        last_message_at = MAX(COALESCE(excluded.last_message_at, 0), COALESCE(conversations.last_message_at, 0))
    `).run(c.key, c.kind, c.title, JSON.stringify(c.participants), JSON.stringify(c.chatGuids), c.groupId, c.lastMessageAt)
  }

  /**
   * Copy or refresh messages. A message already stored is updated in place,
   * because Messages edits them after the fact: an edit, an Undo Send.
   */
  upsertMessages(conversationKey: string, messages: Omit<StoredMessage, 'conversationKey' | 'attachments'>[]): void {
    const insert = this.db.query(`
      INSERT INTO messages (guid, conversation_key, chat_guid, kind, text, is_from_me, sent_at, sender, service,
        target_guid, reaction_type, reply_to_guid, edited_at, unsent, event_type, group_title, source_rowid)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
      ON CONFLICT (guid) DO UPDATE SET
        text = CASE WHEN excluded.unsent = 1 THEN messages.text ELSE COALESCE(excluded.text, messages.text) END,
        edited_at = COALESCE(excluded.edited_at, messages.edited_at),
        unsent = MAX(excluded.unsent, messages.unsent),
        source_rowid = excluded.source_rowid
    `)
    this.transaction(() => {
      for (const m of messages) {
        insert.run(m.guid, conversationKey, m.chatGuid, m.kind, m.text, m.isFromMe ? 1 : 0, m.sentAt, m.sender, m.service,
          m.targetGuid, m.reactionType, m.replyToGuid, m.editedAt, m.unsent ? 1 : 0, m.eventType, m.groupTitle, m.sourceRowId)
      }
    })
  }

  upsertAttachment(conversationKey: string, a: StoredAttachment): void {
    this.db.query(`
      INSERT INTO attachments (guid, message_guid, conversation_key, name, mime_type, bytes, is_sticker, stored_path, status)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      ON CONFLICT (guid) DO UPDATE SET
        stored_path = COALESCE(excluded.stored_path, attachments.stored_path),
        status = CASE WHEN attachments.status = 'copied' THEN 'copied' ELSE excluded.status END,
        bytes = MAX(excluded.bytes, attachments.bytes)
    `).run(a.guid, a.messageGuid, conversationKey, a.name, a.mimeType, a.bytes, a.isSticker ? 1 : 0, a.storedPath, a.status)
  }

  attachment(guid: string): StoredAttachment | null {
    const row = this.db.query('SELECT * FROM attachments WHERE guid = ?').get(guid) as AttachmentDbRow | null
    return row ? toAttachment(row) : null
  }

  setSyncedRowId(key: string, rowid: number): void {
    this.db.query('UPDATE conversations SET synced_rowid = MAX(synced_rowid, ?2) WHERE key = ?1').run(key, rowid)
  }

  archive(key: string, at = Date.now()): void {
    this.db.query(`UPDATE conversations SET state = 'archived', archived_at = ?2, resurfaced_at = NULL WHERE key = ?1`).run(key, at)
  }

  unarchive(key: string, options: { resurfaced?: boolean, at?: number } = {}): void {
    const at = options.at ?? Date.now()
    this.db.query(`UPDATE conversations SET state = 'unarchived', unarchived_at = ?2, resurfaced_at = CASE WHEN ?3 THEN ?2 ELSE resurfaced_at END WHERE key = ?1`)
      .run(key, at, options.resurfaced ? 1 : 0)
  }

  markRemoved(key: string, at: number | null): void {
    this.db.query('UPDATE conversations SET removed_at = ?2 WHERE key = ?1').run(key, at)
  }

  /** Forget a conversation and every copy Attic holds of it. */
  forget(key: string): StoredAttachment[] {
    const attachments = (this.db.query('SELECT * FROM attachments WHERE conversation_key = ?').all(key) as AttachmentDbRow[]).map(toAttachment)
    this.transaction(() => {
      this.db.query('DELETE FROM attachments WHERE conversation_key = ?').run(key)
      this.db.query('DELETE FROM messages WHERE conversation_key = ?').run(key)
      this.db.query('DELETE FROM conversations WHERE key = ?').run(key)
    })
    return attachments
  }

  conversation(key: string): StoredConversation | null {
    const row = this.db.query(`${CONVERSATION_SELECT} WHERE c.key = ?`).get(key) as ConversationRow | null
    return row ? toConversation(row) : null
  }

  conversations(state?: ConversationState): StoredConversation[] {
    const rows = state
      ? this.db.query(`${CONVERSATION_SELECT} WHERE c.state = ? ORDER BY c.last_message_at DESC`).all(state) as ConversationRow[]
      : this.db.query(`${CONVERSATION_SELECT} ORDER BY c.last_message_at DESC`).all() as ConversationRow[]
    return rows.map(toConversation)
  }

  messageCount(key: string): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM messages WHERE conversation_key = ?').get(key) as { n: number }).n
  }

  /** Every stored message of a conversation, oldest first, attachments attached. */
  messages(key: string): StoredMessage[] {
    const rows = this.db.query('SELECT * FROM messages WHERE conversation_key = ? ORDER BY sent_at ASC, source_rowid ASC').all(key) as MessageDbRow[]
    const attachments = new Map<string, StoredAttachment[]>()
    for (const row of this.db.query('SELECT * FROM attachments WHERE conversation_key = ?').all(key) as AttachmentDbRow[]) {
      const list = attachments.get(row.message_guid) ?? []
      list.push(toAttachment(row))
      attachments.set(row.message_guid, list)
    }
    return rows.map(row => ({
      guid: row.guid,
      conversationKey: row.conversation_key,
      chatGuid: row.chat_guid,
      kind: (row.kind === 'reaction' || row.kind === 'event') ? row.kind : 'message',
      text: row.text,
      isFromMe: row.is_from_me === 1,
      sentAt: row.sent_at,
      sender: row.sender,
      service: row.service,
      targetGuid: row.target_guid,
      reactionType: row.reaction_type,
      replyToGuid: row.reply_to_guid,
      editedAt: row.edited_at,
      unsent: row.unsent === 1,
      eventType: row.event_type,
      groupTitle: row.group_title,
      sourceRowId: row.source_rowid,
      attachments: attachments.get(row.guid) ?? [],
    }))
  }

  search(input: string, limit = 50): SearchHit[] {
    const query = ftsQuery(input)
    if (!query)
      return []
    const rows = this.db.query(`
      SELECT m.conversation_key, m.guid, m.sent_at, m.is_from_me, m.sender,
        snippet(messages_fts, 0, char(1), char(2), '…', 12) AS snippet
      FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
      WHERE messages_fts MATCH ? AND m.kind = 'message'
      ORDER BY m.sent_at DESC
      LIMIT ?
    `).all(query, limit) as Array<{ conversation_key: string, guid: string, sent_at: number, is_from_me: number, sender: string | null, snippet: string }>
    return rows.map(row => ({
      conversationKey: row.conversation_key,
      guid: row.guid,
      sentAt: row.sent_at,
      isFromMe: row.is_from_me === 1,
      sender: row.sender,
      snippet: row.snippet,
    }))
  }

  setting(key: string): string | null {
    const row = this.db.query('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | null
    return row?.value ?? null
  }

  setSetting(key: string, value: string): void {
    this.db.query('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)
  }
}
