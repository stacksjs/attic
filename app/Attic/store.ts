import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Attic's own database: the copies it keeps of archived conversations, from
 * every source, so they outlive the real app deleting or closing them.
 *
 * Plain bun:sqlite rather than Stacks models, deliberately. This file ships
 * inside the desktop app, where there is no project tree, no migrations
 * runner and no query builder - only the binary - and it needs an FTS5 index
 * the model layer cannot declare. The schema is created and upgraded in place
 * on open.
 */

export type MessageKind = 'message' | 'reaction' | 'event'
export type Provider = 'imessage' | 'whatsapp' | 'slack' | 'discord'
export type ConversationState = 'archived' | 'unarchived'

export interface Person {
  id: string
  name: string | null
}

export interface StoredConversation {
  /** `<provider>:<id>`, e.g. `imessage:direct:+15551234567`, `slack:D012AB`. */
  key: string
  provider: Provider
  /** The provider's own id for it. */
  id: string
  kind: 'direct' | 'group' | 'channel' | 'thread'
  title: string | null
  participants: Person[]
  /** The Slack workspace or Discord server. */
  workspace: string | null
  /** Opens it in the real app. */
  url: string | null
  state: ConversationState
  archivedAt: number | null
  unarchivedAt: number | null
  /** New messages arrived after archiving. */
  resurfacedAt: number | null
  /** Attic saw it leave the real app. */
  removedAt: number | null
  /**
   * Messages sent up to here were deleted from the real app (an iMessage
   * delete), so only Attic has them, even after the thread comes back.
   */
  goneBefore: number | null
  lastMessageAt: number | null
  /** The provider's cursor at the last message copied; anything after is new. */
  syncedCursor: string | null
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
  kind: MessageKind
  text: string | null
  isFromMe: boolean
  sentAt: number
  /** The sender's provider id; null for your own. */
  sender: string | null
  senderName: string | null
  targetGuid: string | null
  /** For a reaction: the emoji. */
  reaction: string | null
  reactionRemoved: boolean
  replyToGuid: string | null
  editedAt: number | null
  unsent: boolean
  cursor: string | null
  attachments: StoredAttachment[]
}

export interface SearchHit {
  conversationKey: string
  guid: string
  sentAt: number
  isFromMe: boolean
  sender: string | null
  senderName: string | null
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
    chat_guid TEXT NOT NULL DEFAULT '',
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

/**
 * Columns added since 0.1 (iMessage only), and the statement adding each.
 * Applied on open when missing, so an existing archive upgrades in place.
 */
const ADDED_COLUMNS: Array<[table: string, column: string, ddl: string]> = [
  ['conversations', 'provider', `ALTER TABLE conversations ADD COLUMN provider TEXT NOT NULL DEFAULT 'imessage'`],
  ['conversations', 'workspace', 'ALTER TABLE conversations ADD COLUMN workspace TEXT'],
  ['conversations', 'url', 'ALTER TABLE conversations ADD COLUMN url TEXT'],
  ['conversations', 'synced_cursor', 'ALTER TABLE conversations ADD COLUMN synced_cursor TEXT'],
  ['conversations', 'gone_before', 'ALTER TABLE conversations ADD COLUMN gone_before INTEGER'],
  ['messages', 'sender_name', 'ALTER TABLE messages ADD COLUMN sender_name TEXT'],
  ['messages', 'reaction', 'ALTER TABLE messages ADD COLUMN reaction TEXT'],
  ['messages', 'reaction_removed', 'ALTER TABLE messages ADD COLUMN reaction_removed INTEGER NOT NULL DEFAULT 0'],
  ['messages', 'cursor', 'ALTER TABLE messages ADD COLUMN cursor TEXT'],
]

const PROVIDERS: readonly Provider[] = ['imessage', 'whatsapp', 'slack', 'discord']

/** Messages' reaction codes, for rows written before reactions were stored as emoji. */
const REACTION_EMOJI: Record<number, string> = { 2000: '❤️', 2001: '👍', 2002: '👎', 2003: '😂', 2004: '‼️', 2005: '❓', 2006: '😀', 2007: '🔖' }

/** The store's key for a provider's conversation. */
export function conversationKey(provider: Provider, id: string): string {
  return `${provider}:${id}`
}

export function splitKey(key: string): { provider: Provider, id: string } {
  const at = key.indexOf(':')
  const provider = key.slice(0, at) as Provider
  if (at === -1 || !PROVIDERS.includes(provider))
    return { provider: 'imessage', id: key }
  return { provider, id: key.slice(at + 1) }
}

interface ConversationRow {
  key: string
  provider: string
  kind: string
  title: string | null
  participants: string
  group_id: string | null
  workspace: string | null
  url: string | null
  state: string
  archived_at: number | null
  unarchived_at: number | null
  resurfaced_at: number | null
  removed_at: number | null
  gone_before: number | null
  last_message_at: number | null
  synced_rowid: number
  synced_cursor: string | null
  message_count: number
  attachment_count: number
  attachment_bytes: number
  missing_attachments: number
}

interface MessageDbRow {
  guid: string
  conversation_key: string
  kind: string
  text: string | null
  is_from_me: number
  sent_at: number
  sender: string | null
  sender_name: string | null
  target_guid: string | null
  reaction: string | null
  reaction_type: number
  reaction_removed: number
  reply_to_guid: string | null
  edited_at: number | null
  unsent: number
  group_title: string | null
  cursor: string | null
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

function parsePeople(raw: string): Person[] {
  try {
    const value = JSON.parse(raw) as Array<string | Person>
    // 0.1 stored bare handles.
    return value.map(p => (typeof p === 'string' ? { id: p, name: null } : p))
  }
  catch {
    return []
  }
}

function toConversation(row: ConversationRow): StoredConversation {
  const { provider, id } = splitKey(row.key)
  return {
    key: row.key,
    provider: PROVIDERS.includes(row.provider as Provider) ? row.provider as Provider : provider,
    id,
    kind: (['direct', 'group', 'channel', 'thread'] as const).find(k => k === row.kind) ?? 'direct',
    title: row.title,
    participants: parsePeople(row.participants),
    workspace: row.workspace,
    url: row.url ?? (row.group_id ? `sms://open?groupid=${encodeURIComponent(row.group_id)}` : null),
    state: row.state === 'unarchived' ? 'unarchived' : 'archived',
    archivedAt: row.archived_at,
    unarchivedAt: row.unarchived_at,
    resurfacedAt: row.resurfaced_at,
    removedAt: row.removed_at,
    goneBefore: row.gone_before,
    lastMessageAt: row.last_message_at,
    syncedCursor: row.synced_cursor ?? (row.synced_rowid ? String(row.synced_rowid) : null),
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
    this.migrate()
  }

  /**
   * Upgrade a 0.1 archive: add the newer columns, and prefix iMessage keys
   * (`direct:+1555…` became `imessage:direct:+1555…` when other sources came).
   */
  private migrate(): void {
    for (const [table, column, ddl] of ADDED_COLUMNS) {
      const columns = (this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name)
      if (!columns.includes(column))
        this.db.exec(ddl)
    }
    // Attachment placeholders (U+FFFC) copied as text before the drivers
    // dropped them: an attachment-only message has no text, not an
    // invisible character that renders as an empty bubble.
    this.db.exec(`
      UPDATE messages SET text = NULLIF(TRIM(REPLACE(text, char(65532), '')), '')
      WHERE text LIKE '%' || char(65532) || '%'
    `)
    const unprefixed = `key NOT LIKE 'imessage:%' AND key NOT LIKE 'whatsapp:%' AND key NOT LIKE 'slack:%' AND key NOT LIKE 'discord:%'`
    if ((this.db.query(`SELECT COUNT(*) AS n FROM conversations WHERE ${unprefixed}`).get() as { n: number }).n === 0)
      return
    this.transaction(() => {
      this.db.exec(`UPDATE conversations SET key = 'imessage:' || key WHERE ${unprefixed}`)
      for (const table of ['messages', 'attachments'])
        this.db.exec(`UPDATE ${table} SET conversation_key = 'imessage:' || conversation_key WHERE ${unprefixed.replaceAll('key', 'conversation_key')}`)
    })
  }

  close(): void {
    this.db.close()
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  upsertConversation(c: Pick<StoredConversation, 'key' | 'provider' | 'kind' | 'title' | 'participants' | 'workspace' | 'url' | 'lastMessageAt'>): void {
    this.db.query(`
      INSERT INTO conversations (key, provider, kind, title, participants, workspace, url, last_message_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT (key) DO UPDATE SET
        provider = excluded.provider,
        kind = excluded.kind,
        title = COALESCE(excluded.title, conversations.title),
        participants = CASE WHEN excluded.participants = '[]' THEN conversations.participants ELSE excluded.participants END,
        workspace = COALESCE(excluded.workspace, conversations.workspace),
        url = COALESCE(excluded.url, conversations.url),
        last_message_at = MAX(COALESCE(excluded.last_message_at, 0), COALESCE(conversations.last_message_at, 0))
    `).run(c.key, c.provider, c.kind, c.title, JSON.stringify(c.participants), c.workspace, c.url, c.lastMessageAt)
  }

  /**
   * Copy or refresh messages. A message already stored is updated in place,
   * because apps edit them after the fact: an edit, an Undo Send.
   *
   * `chat_guid` is written empty: 0.1 created it NOT NULL with no default, and
   * an upgraded archive keeps that constraint.
   */
  upsertMessages(conversationKey: string, messages: Omit<StoredMessage, 'conversationKey' | 'attachments'>[]): void {
    const insert = this.db.query(`
      INSERT INTO messages (guid, conversation_key, kind, text, is_from_me, sent_at, sender, sender_name,
        target_guid, reaction, reaction_removed, reply_to_guid, edited_at, unsent, cursor, chat_guid)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, '')
      ON CONFLICT (guid) DO UPDATE SET
        text = CASE WHEN excluded.unsent = 1 THEN messages.text ELSE COALESCE(excluded.text, messages.text) END,
        sender_name = COALESCE(excluded.sender_name, messages.sender_name),
        edited_at = COALESCE(excluded.edited_at, messages.edited_at),
        unsent = MAX(excluded.unsent, messages.unsent),
        cursor = excluded.cursor
    `)
    this.transaction(() => {
      for (const m of messages) {
        insert.run(m.guid, conversationKey, m.kind, m.text, m.isFromMe ? 1 : 0, m.sentAt, m.sender, m.senderName,
          m.targetGuid, m.reaction, m.reactionRemoved ? 1 : 0, m.replyToGuid, m.editedAt, m.unsent ? 1 : 0, m.cursor)
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

  setSyncedCursor(key: string, cursor: string): void {
    this.db.query('UPDATE conversations SET synced_cursor = ?2 WHERE key = ?1').run(key, cursor)
  }

  archive(key: string, at = Date.now()): void {
    this.db.query(`UPDATE conversations SET state = 'archived', archived_at = ?2, resurfaced_at = NULL WHERE key = ?1`).run(key, at)
  }

  unarchive(key: string, options: { resurfaced?: boolean, at?: number } = {}): void {
    const at = options.at ?? Date.now()
    this.db.query(`UPDATE conversations SET state = 'unarchived', unarchived_at = ?2, resurfaced_at = CASE WHEN ?3 THEN ?2 ELSE resurfaced_at END WHERE key = ?1`)
      .run(key, at, options.resurfaced ? 1 : 0)
  }

  /** `deleted`: the app deleted the history too, not just hid the conversation. */
  markRemoved(key: string, at: number | null, deleted = false): void {
    this.db.query('UPDATE conversations SET removed_at = ?2, gone_before = CASE WHEN ?3 THEN MAX(COALESCE(gone_before, 0), COALESCE(last_message_at, 0)) ELSE gone_before END WHERE key = ?1')
      .run(key, at, deleted ? 1 : 0)
  }

  /** Forget a conversation and every copy Attic holds of it; returns the files to delete. */
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
    const rows = this.db.query('SELECT * FROM messages WHERE conversation_key = ? ORDER BY sent_at ASC, rowid ASC').all(key) as MessageDbRow[]
    const attachments = new Map<string, StoredAttachment[]>()
    for (const row of this.db.query('SELECT * FROM attachments WHERE conversation_key = ?').all(key) as AttachmentDbRow[]) {
      const list = attachments.get(row.message_guid) ?? []
      list.push(toAttachment(row))
      attachments.set(row.message_guid, list)
    }
    return rows.map((row): StoredMessage => {
      const legacyRemoved = row.reaction_type >= 3000
      return {
        guid: row.guid,
        conversationKey: row.conversation_key,
        kind: (row.kind === 'reaction' || row.kind === 'event') ? row.kind : 'message',
        text: row.kind === 'event' && !row.text && row.group_title ? `Named the conversation “${row.group_title}”` : row.text,
        isFromMe: row.is_from_me === 1,
        sentAt: row.sent_at,
        sender: row.sender,
        senderName: row.sender_name,
        targetGuid: row.target_guid,
        reaction: row.reaction ?? (row.reaction_type ? REACTION_EMOJI[legacyRemoved ? row.reaction_type - 1000 : row.reaction_type] ?? '•' : null),
        reactionRemoved: row.reaction_removed === 1 || legacyRemoved,
        replyToGuid: row.reply_to_guid,
        editedAt: row.edited_at,
        unsent: row.unsent === 1,
        cursor: row.cursor ?? (row.source_rowid ? String(row.source_rowid) : null),
        attachments: attachments.get(row.guid) ?? [],
      }
    })
  }

  search(input: string, limit = 50): SearchHit[] {
    const query = ftsQuery(input)
    if (!query)
      return []
    const rows = this.db.query(`
      SELECT m.conversation_key, m.guid, m.sent_at, m.is_from_me, m.sender, m.sender_name,
        snippet(messages_fts, 0, char(1), char(2), '…', 12) AS snippet
      FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
      WHERE messages_fts MATCH ? AND m.kind = 'message'
      ORDER BY m.sent_at DESC
      LIMIT ?
    `).all(query, limit) as Array<{ conversation_key: string, guid: string, sent_at: number, is_from_me: number, sender: string | null, sender_name: string | null, snippet: string }>
    return rows.map(row => ({
      conversationKey: row.conversation_key,
      guid: row.guid,
      sentAt: row.sent_at,
      isFromMe: row.is_from_me === 1,
      sender: row.sender,
      senderName: row.sender_name,
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
