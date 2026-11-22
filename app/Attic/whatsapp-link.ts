/* eslint-disable no-console */
import type { inbox } from '@stacksjs/chat'
import type { AuthenticationCreds, Chat, Contact, GroupMetadata, LIDMapping, SignalDataSet, SignalDataTypeMap, SignalKeyStore, WAMessage, WAMessageKey, WASocket } from 'baileys'
import { Database } from 'bun:sqlite'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import makeWASocket, { Browsers, BufferJSON, DisconnectReason, downloadMediaMessage, fetchLatestWaWebVersion, getContentType, initAuthCreds, isJidBroadcast, isJidGroup, isJidNewsletter, isLidUser, jidNormalizedUser, makeCacheableSignalKeyStore, normalizeMessageContent, proto } from 'baileys'

/**
 * WhatsApp without WhatsApp for Mac: Attic is a linked device of its own.
 *
 * The person links it once, the way WhatsApp Web is linked - WhatsApp on the
 * phone, Linked Devices, scan the code Attic shows - and from then on Attic
 * talks to WhatsApp's servers itself: it receives every message as it is
 * sent, sends, replies, reacts, marks read and archives, with the Mac app
 * uninstalled and the phone switched off. WhatsApp only asks that the phone
 * stays signed in and comes online now and then (it unlinks devices whose
 * phone has been away for about two weeks).
 *
 * WhatsApp keeps no history for linked devices to page through: the phone
 * sends what it has when the device links, and new messages arrive after.
 * So this driver keeps its own copy - chats, contacts, groups and every
 * message - in a SQLite file beside the archive, and serves the inbox from
 * it. The session's keys sit in the same file, encrypted with a key kept in
 * the login keychain: they are as good as the person's WhatsApp.
 */

export type LinkPhase = 'signed-out' | 'linking' | 'connecting' | 'open'

export interface LinkState {
  phase: LinkPhase
  /** The code to scan while linking; a `https://wa.me/settings/linked_devices#…` link. */
  qr: string | null
  /** The linked account's number, once linked. */
  me: string | null
  /** Why the last attempt ended, when it ended badly. */
  error: string | null
}

export interface WhatsAppLinkOptions {
  /** Where the link keeps its database and downloaded media. */
  dir: string
  /** The key that seals the session, from the keychain unless a test says otherwise. */
  sealKey: () => Promise<Uint8Array>
  /** Called whenever {@link LinkState} changes, to redraw the sheet. */
  onState?: (state: LinkState) => void
  /** Called once a device has linked or unlinked, so the inbox switches drivers. */
  onLinked?: (linked: boolean) => void
  /** Socket factory, for tests. */
  socket?: typeof makeWASocket
  /** Ask web.whatsapp.com for its current version before connecting; on unless a test says otherwise. */
  checkVersion?: boolean
}

/** How long a linking session keeps offering fresh codes before it gives up. */
const LINK_WINDOW_MS = 3 * 60_000
const MAX_BACKOFF_MS = 60_000

const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'] as const
type MediaType = typeof MEDIA_TYPES[number]

const MEDIA_LABEL: Record<MediaType, string> = {
  imageMessage: 'Photo',
  videoMessage: 'Video',
  audioMessage: 'Voice message',
  documentMessage: 'Document',
  stickerMessage: 'Sticker',
}

const MEDIA_EXTENSION: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'application/pdf': '.pdf',
}

/** Content types that carry nothing a person would read: key exchange and housekeeping. */
const SILENT = new Set(['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'keepInChatMessage', 'pinInChatMessage', 'encReactionMessage', 'pollUpdateMessage'])

const ARCHIVE_DETAIL = 'Archives the chat in WhatsApp, on every device. WhatsApp brings it back when a new message arrives, unless Keep chats archived is on.'

type Logger = NonNullable<Parameters<typeof makeWASocket>[0]['logger']>

const SILENT_LOGGER: Logger = {
  level: 'silent',
  child: () => SILENT_LOGGER,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

function toNumber(value: unknown): number {
  if (typeof value === 'number')
    return value
  if (value && typeof value === 'object' && 'toNumber' in value && typeof (value as { toNumber: unknown }).toNumber === 'function')
    return (value as { toNumber: () => number }).toNumber()
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** `+1 555…` for a phone-number JID. */
function numberOf(jid: string | null | undefined): string | null {
  const [user, server] = (jid ?? '').split('@')
  return server === 's.whatsapp.net' && user && /^\d{6,15}$/.test(user) ? `+${user}` : null
}

/** Chats the inbox shows: people and groups, not Status, channels or broadcast lists. */
export function isInboxJid(jid: string | null | undefined): jid is string {
  return !!jid && !isJidBroadcast(jid) && !isJidNewsletter(jid) && !jid.endsWith('@call') && jid !== '0@s.whatsapp.net'
}

/** What a message says, as plain text. */
export function messageText(message: proto.IMessage | null | undefined): string | null {
  const content = normalizeMessageContent(message)
  if (!content)
    return null
  const type = getContentType(content)
  switch (type) {
    case 'conversation':
      return content.conversation || null
    case 'extendedTextMessage':
      return content.extendedTextMessage?.text || null
    case 'imageMessage':
      return content.imageMessage?.caption || null
    case 'videoMessage':
      return content.videoMessage?.caption || null
    case 'documentMessage':
      return content.documentMessage?.caption || null
    case 'contactMessage':
      return content.contactMessage?.displayName ? `Contact: ${content.contactMessage.displayName}` : 'Contact'
    case 'contactsArrayMessage':
      return `${content.contactsArrayMessage?.contacts?.length ?? 0} contacts`
    case 'locationMessage':
      return content.locationMessage?.name || content.locationMessage?.address || 'Location'
    case 'liveLocationMessage':
      return 'Live location'
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      return `Poll: ${(content[type] as proto.Message.IPollCreationMessage | null | undefined)?.name ?? ''}`.trim()
    case 'eventMessage':
      return content.eventMessage?.name ? `Event: ${content.eventMessage.name}` : 'Event'
    default:
      return null
  }
}

/** The message a reply answers, by stanza id. */
function replyTo(content: proto.IMessage | undefined): string | null {
  const type = content ? getContentType(content) : undefined
  const inner = type ? (content![type] as { contextInfo?: proto.IContextInfo | null } | null | undefined) : null
  return inner && typeof inner === 'object' ? inner.contextInfo?.stanzaId ?? null : null
}

interface ChatRow { jid: string, name: string | null, unread: number, archived: number, at: number }
interface MessageRow { seq: number, jid: string, id: string, from_me: number, sender: string | null, at: number, body: string, edited_text: string | null, edited_at: number | null, revoked: number }

/**
 * The link's own store. Messages are never deleted from it (a deletion only
 * marks one unsent), and a message changed after the archiver read it - an
 * edit, an unsend - moves to the end of `seq`, so reading "after" a cursor
 * picks the change up.
 */
export class LinkStore {
  readonly db: Database

  constructor(path: string) {
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth (key TEXT PRIMARY KEY, value BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS chats (jid TEXT PRIMARY KEY, name TEXT, unread INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS contacts (jid TEXT PRIMARY KEY, name TEXT, notify TEXT);
      CREATE TABLE IF NOT EXISTS lids (lid TEXT PRIMARY KEY, pn TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS groups (jid TEXT PRIMARY KEY, subject TEXT, participants TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY, jid TEXT NOT NULL, id TEXT NOT NULL, from_me INTEGER NOT NULL, sender TEXT,
        at INTEGER NOT NULL, body TEXT NOT NULL, edited_text TEXT, edited_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0,
        UNIQUE (jid, id)
      );
      CREATE INDEX IF NOT EXISTS messages_by_chat ON messages (jid, at);
    `)
    try {
      chmodSync(path, 0o600)
    }
    catch {}
  }

  close(): void {
    this.db.close()
  }

  // ── Session ─────────────────────────────────────────────────────────

  authGet(key: string): Uint8Array | null {
    const row = this.db.query<{ value: Uint8Array }, [string]>('SELECT value FROM auth WHERE key = ?').get(key)
    return row ? new Uint8Array(row.value) : null
  }

  authSet(key: string, value: Uint8Array | null): void {
    if (value)
      this.db.query('INSERT INTO auth (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)
    else
      this.db.query('DELETE FROM auth WHERE key = ?').run(key)
  }

  // ── Identities ──────────────────────────────────────────────────────

  /** A phone-number JID for a LID one, when WhatsApp has said which. */
  pnFor(lid: string): string | null {
    return this.db.query<{ pn: string }, [string]>('SELECT pn FROM lids WHERE lid = ?').get(jidNormalizedUser(lid))?.pn ?? null
  }

  /**
   * Record that a LID and a number are one person, and move anything filed
   * under the LID to the number, so a chat never splits in two.
   */
  mapLid(lid: string, pn: string): void {
    lid = jidNormalizedUser(lid)
    pn = jidNormalizedUser(pn)
    if (!isLidUser(lid) || !pn.endsWith('@s.whatsapp.net'))
      return
    const known = this.pnFor(lid)
    this.db.query('INSERT INTO lids (lid, pn) VALUES (?, ?) ON CONFLICT (lid) DO UPDATE SET pn = excluded.pn').run(lid, pn)
    if (known === pn)
      return
    this.db.transaction(() => {
      const lidChat = this.db.query<ChatRow, [string]>('SELECT * FROM chats WHERE jid = ?').get(lid)
      if (lidChat) {
        this.db.query('INSERT INTO chats (jid, name, unread, archived, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (jid) DO UPDATE SET name = COALESCE(chats.name, excluded.name), unread = MAX(chats.unread, excluded.unread), at = MAX(chats.at, excluded.at)')
          .run(pn, lidChat.name, lidChat.unread, lidChat.archived, lidChat.at)
        this.db.query('DELETE FROM chats WHERE jid = ?').run(lid)
      }
      this.db.query('UPDATE OR IGNORE messages SET jid = ? WHERE jid = ?').run(pn, lid)
      this.db.query('UPDATE messages SET sender = ? WHERE sender = ?').run(pn, lid)
      const contact = this.db.query<{ name: string | null, notify: string | null }, [string]>('SELECT name, notify FROM contacts WHERE jid = ?').get(lid)
      if (contact)
        this.contact(pn, contact.name, contact.notify)
    })()
  }

  /** The JID a chat or person is filed under: the number where it is known. */
  canonical(jid: string | null | undefined, alt?: string | null): string | null {
    if (!jid)
      return null
    const normal = jidNormalizedUser(jid)
    if (!isLidUser(normal))
      return normal
    if (alt && jidNormalizedUser(alt).endsWith('@s.whatsapp.net')) {
      this.mapLid(normal, alt)
      return jidNormalizedUser(alt)
    }
    return this.pnFor(normal) ?? normal
  }

  contact(jid: string, name?: string | null, notify?: string | null): void {
    this.db.query('INSERT INTO contacts (jid, name, notify) VALUES (?, ?, ?) ON CONFLICT (jid) DO UPDATE SET name = COALESCE(excluded.name, contacts.name), notify = COALESCE(excluded.notify, contacts.notify)')
      .run(jid, name || null, notify || null)
  }

  nameOf(jid: string): string | null {
    const row = this.db.query<{ name: string | null, notify: string | null }, [string]>('SELECT name, notify FROM contacts WHERE jid = ?').get(jid)
    return row?.name || row?.notify || null
  }

  group(jid: string, subject?: string | null, participants?: string[]): void {
    this.db.query('INSERT INTO groups (jid, subject, participants) VALUES (?, ?, ?) ON CONFLICT (jid) DO UPDATE SET subject = COALESCE(excluded.subject, groups.subject), participants = CASE WHEN excluded.participants = \'[]\' THEN groups.participants ELSE excluded.participants END')
      .run(jid, subject || null, JSON.stringify(participants ?? []))
  }

  groupRow(jid: string): { subject: string | null, participants: string[] } | null {
    const row = this.db.query<{ subject: string | null, participants: string }, [string]>('SELECT subject, participants FROM groups WHERE jid = ?').get(jid)
    return row ? { subject: row.subject, participants: JSON.parse(row.participants) as string[] } : null
  }

  // ── Chats ───────────────────────────────────────────────────────────

  chat(jid: string, fields: { name?: string | null, unread?: number, archived?: boolean, at?: number }): void {
    this.db.query('INSERT INTO chats (jid) VALUES (?) ON CONFLICT (jid) DO NOTHING').run(jid)
    if (fields.name)
      this.db.query('UPDATE chats SET name = ? WHERE jid = ?').run(fields.name, jid)
    if (fields.unread !== undefined)
      this.db.query('UPDATE chats SET unread = ? WHERE jid = ?').run(Math.max(0, fields.unread), jid)
    if (fields.archived !== undefined)
      this.db.query('UPDATE chats SET archived = ? WHERE jid = ?').run(fields.archived ? 1 : 0, jid)
    if (fields.at)
      this.db.query('UPDATE chats SET at = MAX(at, ?) WHERE jid = ?').run(fields.at, jid)
  }

  bumpUnread(jid: string): void {
    this.db.query('UPDATE chats SET unread = unread + 1 WHERE jid = ?').run(jid)
  }

  chatRow(jid: string): ChatRow | null {
    return this.db.query<ChatRow, [string]>('SELECT * FROM chats WHERE jid = ?').get(jid)
  }

  chats(): Array<ChatRow & { last: MessageRow | null }> {
    const rows = this.db.query<ChatRow, []>('SELECT * FROM chats').all()
    const latest = this.db.query<MessageRow, [string]>('SELECT * FROM messages WHERE jid = ? AND body NOT LIKE \'%"reactionMessage"%\' ORDER BY at DESC, seq DESC LIMIT 1')
    return rows.map(row => ({ ...row, last: latest.get(row.jid) }))
  }

  // ── Messages ────────────────────────────────────────────────────────

  nextSeq(): number {
    return (this.db.query<{ seq: number | null }, []>('SELECT MAX(seq) AS seq FROM messages').get()?.seq ?? 0) + 1
  }

  /** Store a message; true when it is new. */
  put(jid: string, message: WAMessage, sender: string | null): boolean {
    const id = message.key.id
    if (!id)
      return false
    const at = toNumber(message.messageTimestamp) * 1000 || Date.now()
    const body = JSON.stringify(message, BufferJSON.replacer)
    const existing = this.db.query<{ seq: number }, [string, string]>('SELECT seq FROM messages WHERE jid = ? AND id = ?').get(jid, id)
    if (existing) {
      // The same message again (history overlapping live delivery): keep the
      // richer copy, without moving it.
      if (message.message)
        this.db.query('UPDATE messages SET body = ?, sender = COALESCE(?, sender) WHERE seq = ?').run(body, sender, existing.seq)
      return false
    }
    this.db.query('INSERT INTO messages (seq, jid, id, from_me, sender, at, body) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(this.nextSeq(), jid, id, message.key.fromMe ? 1 : 0, sender, at, body)
    this.chat(jid, { at })
    return true
  }

  /** An edit or an unsend: change the message and move it past every cursor. */
  amend(jid: string, id: string, change: { text?: string | null, at?: number, revoked?: boolean }): boolean {
    const row = this.db.query<{ seq: number }, [string, string]>('SELECT seq FROM messages WHERE jid = ? AND id = ?').get(jid, id)
    if (!row)
      return false
    if (change.revoked)
      this.db.query('UPDATE messages SET revoked = 1, seq = ? WHERE seq = ?').run(this.nextSeq(), row.seq)
    else
      this.db.query('UPDATE messages SET edited_text = ?, edited_at = ?, seq = ? WHERE seq = ?').run(change.text ?? null, change.at ?? Date.now(), this.nextSeq(), row.seq)
    return true
  }

  message(jid: string, id: string): MessageRow | null {
    return this.db.query<MessageRow, [string, string]>('SELECT * FROM messages WHERE jid = ? AND id = ?').get(jid, id)
  }

  messageById(id: string): MessageRow | null {
    return this.db.query<MessageRow, [string]>('SELECT * FROM messages WHERE id = ? LIMIT 1').get(id)
  }

  /** Oldest first, as the inbox reads them. */
  messages(jid: string, after: number | null, limit: number): MessageRow[] {
    if (after !== null)
      return this.db.query<MessageRow, [string, number, number]>('SELECT * FROM messages WHERE jid = ? AND seq > ? ORDER BY seq LIMIT ?').all(jid, after, limit).sort((a, b) => a.at - b.at || a.seq - b.seq)
    return this.db.query<MessageRow, [string, number]>('SELECT * FROM messages WHERE jid = ? ORDER BY at DESC, seq DESC LIMIT ?').all(jid, limit).reverse()
  }

  /** The newest messages someone else sent, to acknowledge as read. */
  unreadKeys(jid: string, count: number): WAMessageKey[] {
    return this.db.query<{ body: string }, [string, number]>('SELECT body FROM messages WHERE jid = ? AND from_me = 0 ORDER BY at DESC LIMIT ?').all(jid, Math.max(1, Math.min(count, 50)))
      .map(row => (JSON.parse(row.body, BufferJSON.reviver) as WAMessage).key)
  }
}

/** AES-256-GCM, with the IV and tag carried beside the ciphertext. */
function seal(key: Uint8Array, plain: Uint8Array): Uint8Array {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), body]))
}

function unseal(key: Uint8Array, sealed: Uint8Array): Uint8Array {
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12))
  decipher.setAuthTag(sealed.subarray(12, 28))
  return new Uint8Array(Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]))
}

export class WhatsAppLink implements inbox.InboxDriver {
  readonly provider = 'whatsapp' as const
  readonly label = 'WhatsApp'

  private readonly dir: string
  private readonly mediaDir: string
  private store: LinkStore
  private socket: WASocket | null = null
  private creds: AuthenticationCreds | null = null
  private key: Uint8Array | null = null
  private state: LinkState = { phase: 'signed-out', qr: null, me: null, error: null }
  private linkUntil = 0
  private backoff = 2_000
  private retry: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private readonly listeners = new Set<(event: inbox.InboxEvent) => void>()

  constructor(private readonly options: WhatsAppLinkOptions) {
    this.dir = options.dir
    this.mediaDir = join(options.dir, 'Media')
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    this.store = new LinkStore(join(this.dir, 'link.sqlite'))
  }

  /** Linked to an account: a session exists, whether or not it is connected right now. */
  get linked(): boolean {
    return this.store.authGet('creds') !== null
  }

  linkState(): LinkState {
    return { ...this.state }
  }

  private setState(change: Partial<LinkState>): void {
    this.state = { ...this.state, ...change }
    this.options.onState?.(this.linkState())
  }

  // ── Session storage ─────────────────────────────────────────────────

  private async sealKey(): Promise<Uint8Array> {
    this.key ??= await this.options.sealKey()
    return this.key
  }

  private read<T>(key: string): T | null {
    const sealed = this.store.authGet(key)
    if (!sealed || !this.key)
      return null
    try {
      return JSON.parse(new TextDecoder().decode(unseal(this.key, sealed)), BufferJSON.reviver) as T
    }
    catch {
      return null
    }
  }

  private write(key: string, value: unknown): void {
    if (!this.key)
      return
    this.store.authSet(key, value == null ? null : seal(this.key, new TextEncoder().encode(JSON.stringify(value, BufferJSON.replacer))))
  }

  private keyStore(): SignalKeyStore {
    return {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const out: { [id: string]: SignalDataTypeMap[T] } = {}
        for (const id of ids) {
          let value = this.read<SignalDataTypeMap[T]>(`${type}-${id}`)
          if (value && type === 'app-state-sync-key')
            value = proto.Message.AppStateSyncKeyData.fromObject(value as object) as unknown as SignalDataTypeMap[T]
          if (value)
            out[id] = value
        }
        return out
      },
      set: async (data: SignalDataSet) => {
        this.store.db.transaction(() => {
          for (const type of Object.keys(data) as Array<keyof SignalDataSet>) {
            for (const [id, value] of Object.entries(data[type] ?? {}))
              this.write(`${type}-${id}`, value ?? null)
          }
        })()
      },
    }
  }

  // ── Connection ──────────────────────────────────────────────────────

  /** Connect if a device is already linked; otherwise wait to be asked to link. */
  async start(): Promise<void> {
    this.stopped = false
    await this.sealKey()
    if (this.linked) {
      const me = this.read<AuthenticationCreds>('creds')?.me?.id
      this.setState({ me: me ? numberOf(jidNormalizedUser(me)) : null })
      await this.connect()
    }
  }

  /** Start linking: show codes to scan for a few minutes. */
  async link(): Promise<LinkState> {
    this.stopped = false
    await this.sealKey()
    if (this.linked)
      return this.linkState()
    this.linkUntil = Date.now() + LINK_WINDOW_MS
    this.setState({ phase: 'linking', error: null })
    await this.connect()
    return this.linkState()
  }

  /** Stop offering codes, when the sheet closes without linking. */
  cancelLink(): void {
    if (this.linked)
      return
    this.linkUntil = 0
    this.disconnectSocket()
    this.setState({ phase: 'signed-out', qr: null })
  }

  private disconnectSocket(): void {
    if (this.retry)
      clearTimeout(this.retry)
    this.retry = null
    const socket = this.socket
    this.socket = null
    try {
      socket?.end(undefined)
    }
    catch {}
  }

  private schedule(ms: number): void {
    if (this.retry || this.stopped)
      return
    this.retry = setTimeout(() => {
      this.retry = null
      void this.connect()
    }, ms)
  }

  private version: [number, number, number] | null = null

  /**
   * The WhatsApp Web version to claim. WhatsApp turns away clients that fall
   * too far behind, so the current one is asked for once per run, falling
   * back to the version Baileys shipped with.
   */
  private async webVersion(): Promise<{ version?: [number, number, number] }> {
    if (!this.version && this.options.checkVersion !== false) {
      const latest = await fetchLatestWaWebVersion({ signal: AbortSignal.timeout(5_000) }).catch(() => null)
      if (latest?.isLatest)
        this.version = latest.version as [number, number, number]
    }
    return this.version ? { version: this.version } : {}
  }

  private opening: Promise<void> | null = null

  /** Open the one connection, however many callers ask at once. */
  private connect(): Promise<void> {
    if (this.socket || this.stopped)
      return Promise.resolve()
    this.opening ??= this.open().finally(() => {
      this.opening = null
    })
    return this.opening
  }

  private async open(): Promise<void> {
    await this.sealKey()
    const version = await this.webVersion()
    if (this.socket || this.stopped)
      return
    this.creds = this.read<AuthenticationCreds>('creds') ?? initAuthCreds()
    const create = this.options.socket ?? makeWASocket
    const socket = create({
      auth: { creds: this.creds, keys: makeCacheableSignalKeyStore(this.keyStore(), SILENT_LOGGER) },
      logger: SILENT_LOGGER,
      // As a linked browser: WhatsApp refuses the native desktop client type
      // to anything that is not WhatsApp for Mac. Asking for the full history
      // still has the phone send all it is willing to.
      browser: Browsers.macOS('Attic'),
      syncFullHistory: true,
      ...version,
      // Staying "offline" keeps the phone's own notifications coming.
      markOnlineOnConnect: false,
      getMessage: async (key) => {
        const jid = this.store.canonical(key.remoteJid, key.remoteJidAlt)
        const row = jid && key.id ? this.store.message(jid, key.id) : null
        return row ? (JSON.parse(row.body, BufferJSON.reviver) as WAMessage).message ?? undefined : undefined
      },
      cachedGroupMetadata: async (jid) => {
        const group = this.store.groupRow(jid)
        return group ? { id: jid, subject: group.subject ?? '', participants: group.participants.map(id => ({ id })) } as GroupMetadata : undefined
      },
    })
    this.socket = socket
    if (this.linked)
      this.setState({ phase: 'connecting' })

    socket.ev.process(async (events) => {
      if (this.socket !== socket)
        return
      try {
        if (events['creds.update']) {
          Object.assign(this.creds!, events['creds.update'])
          this.write('creds', this.creds)
        }
        if (events['connection.update'])
          await this.onConnection(socket, events['connection.update'])
        if (events['lid-mapping.update'])
          this.onLids([events['lid-mapping.update']])
        if (events['messaging-history.set']) {
          const history = events['messaging-history.set']
          this.onLids(history.lidPnMappings ?? [])
          this.onContacts(history.contacts)
          this.onChats(history.chats, true)
          this.onMessages(history.messages, false)
          this.emit({ type: 'changed', conversationId: null })
        }
        if (events['contacts.upsert'])
          this.onContacts(events['contacts.upsert'])
        if (events['contacts.update'])
          this.onContacts(events['contacts.update'] as Contact[])
        if (events['chats.upsert'])
          this.onChats(events['chats.upsert'], true)
        if (events['chats.update'])
          this.onChats(events['chats.update'] as Chat[], false)
        if (events['groups.upsert'])
          this.onGroups(events['groups.upsert'])
        if (events['groups.update'])
          this.onGroups(events['groups.update'] as GroupMetadata[])
        if (events['messages.upsert'])
          this.onMessages(events['messages.upsert'].messages, events['messages.upsert'].type === 'notify')
        if (events['messages.update']) {
          for (const update of events['messages.update']) {
            const jid = this.store.canonical(update.key.remoteJid, update.key.remoteJidAlt)
            const edited = update.update.message ? messageText(update.update.message) : undefined
            if (jid && update.key.id && edited !== undefined && edited !== null && this.store.amend(jid, update.key.id, { text: edited }))
              this.emit({ type: 'changed', conversationId: jid })
          }
        }
        if (events['messages.delete']) {
          const deleted = events['messages.delete']
          if ('keys' in deleted) {
            for (const key of deleted.keys) {
              const jid = this.store.canonical(key.remoteJid, key.remoteJidAlt)
              if (jid && key.id && this.store.amend(jid, key.id, { revoked: true }))
                this.emit({ type: 'changed', conversationId: jid })
            }
          }
        }
      }
      catch (error) {
        console.error(`[attic] whatsapp: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  private async onConnection(socket: WASocket, update: Partial<import('baileys').ConnectionState>): Promise<void> {
    if (update.qr && !this.linked)
      this.setState({ phase: 'linking', qr: update.qr })
    if (update.connection === 'open') {
      this.backoff = 2_000
      this.linkUntil = 0
      const me = this.creds?.me?.id ? numberOf(jidNormalizedUser(this.creds.me.id)) : null
      this.setState({ phase: 'open', qr: null, me, error: null })
      this.options.onLinked?.(true)
      try {
        this.onGroups(Object.values(await socket.groupFetchAllParticipating()))
        this.emit({ type: 'changed', conversationId: null })
      }
      catch {}
    }
    if (update.connection !== 'close')
      return
    if (this.socket === socket)
      this.socket = null
    const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode
    if (code === DisconnectReason.loggedOut) {
      // Unlinked from the phone, or logged out here: nothing in the session
      // is any use now.
      this.wipe()
      this.setState({ phase: 'signed-out', qr: null, me: null, error: 'WhatsApp unlinked Texts. Link it again to carry on.' })
      this.options.onLinked?.(false)
      return
    }
    if (code === DisconnectReason.restartRequired) {
      // Expected right after the phone scans the code.
      void this.connect()
      return
    }
    if (this.linked) {
      this.setState({ phase: 'connecting' })
      this.schedule(this.backoff)
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
      return
    }
    if (Date.now() < this.linkUntil) {
      this.schedule(1_000)
      return
    }
    this.setState({ phase: 'signed-out', qr: null, error: this.linkUntil ? 'The code expired. Try again when the phone is at hand.' : null })
  }

  /** Unlink this device, in WhatsApp as well as here. */
  async logout(): Promise<void> {
    try {
      await this.socket?.logout()
    }
    catch {}
    this.disconnectSocket()
    this.wipe()
    this.setState({ phase: 'signed-out', qr: null, me: null, error: null })
    this.options.onLinked?.(false)
  }

  /** Forget the session and everything it brought in. Attic's archive keeps its own copy. */
  private wipe(): void {
    this.disconnectSocket()
    this.store.close()
    for (const file of ['link.sqlite', 'link.sqlite-wal', 'link.sqlite-shm'])
      rmSync(join(this.dir, file), { force: true })
    rmSync(this.mediaDir, { recursive: true, force: true })
    this.store = new LinkStore(join(this.dir, 'link.sqlite'))
    this.creds = null
  }

  close(): void {
    this.stopped = true
    this.disconnectSocket()
  }

  // ── Incoming ────────────────────────────────────────────────────────

  private onLids(mappings: LIDMapping[]): void {
    for (const { lid, pn } of mappings)
      this.store.mapLid(lid, pn)
  }

  private onContacts(contacts: Array<Partial<Contact>>): void {
    for (const contact of contacts) {
      if (contact.lid && contact.phoneNumber)
        this.store.mapLid(contact.lid, contact.phoneNumber)
      const jid = this.store.canonical(contact.phoneNumber ?? contact.id ?? null, contact.phoneNumber)
      if (jid)
        this.store.contact(jid, contact.name, contact.notify ?? contact.verifiedName)
    }
  }

  private onChats(chats: Chat[], full: boolean): void {
    for (const chat of chats) {
      if (chat.lidJid && chat.pnJid)
        this.store.mapLid(chat.lidJid, chat.pnJid)
      const jid = this.store.canonical(chat.id, chat.pnJid)
      if (!isInboxJid(jid))
        continue
      const at = toNumber(chat.conversationTimestamp) * 1000 || toNumber(chat.lastMessageRecvTimestamp) * 1000
      const unread = chat.unreadCount
      this.store.chat(jid, {
        name: chat.name ?? null,
        at,
        archived: typeof chat.archived === 'boolean' ? chat.archived : undefined,
        // A full chat carries its count. An update only matters when it says
        // the chat was read (0) or marked unread (-1); new messages are
        // counted as they arrive.
        unread: typeof unread === 'number' ? (full ? unread : unread === 0 ? 0 : unread < 0 ? Math.max(1, this.store.chatRow(jid)?.unread ?? 0) : undefined) : undefined,
      })
      if (!full && chat.archived !== undefined)
        this.emit({ type: 'changed', conversationId: jid })
    }
  }

  private onGroups(groups: Array<Partial<GroupMetadata>>): void {
    for (const group of groups) {
      if (!group.id)
        continue
      const participants = (group.participants ?? []).map(p => this.store.canonical(p.id, (p as { phoneNumber?: string }).phoneNumber)).filter((id): id is string => !!id)
      this.store.group(group.id, group.subject, participants)
      if (group.subject)
        this.store.chat(group.id, { name: group.subject })
    }
  }

  private onMessages(messages: WAMessage[], live: boolean): void {
    for (const message of messages) {
      const key = message.key
      const jid = this.store.canonical(key.remoteJid, key.remoteJidAlt)
      if (!isInboxJid(jid) || !key.id)
        continue
      const content = normalizeMessageContent(message.message)
      const type = content ? getContentType(content) : undefined
      const sender = key.fromMe ? null : isJidGroup(jid) ? this.store.canonical(key.participant, key.participantAlt) : jid
      if (sender && message.pushName)
        this.store.contact(sender, null, message.pushName)

      // Edits and unsends arrive as messages about another message.
      const protocol = content?.protocolMessage
      if (type === 'protocolMessage' && protocol?.key?.id) {
        const changed = protocol.type === proto.Message.ProtocolMessage.Type.REVOKE
          ? this.store.amend(jid, protocol.key.id, { revoked: true })
          : protocol.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT
            ? this.store.amend(jid, protocol.key.id, { text: messageText(protocol.editedMessage), at: toNumber(message.messageTimestamp) * 1000 || Date.now() })
            : false
        if (changed)
          this.emit({ type: 'changed', conversationId: jid })
        continue
      }
      if (!type || SILENT.has(type))
        continue

      const added = this.store.put(jid, message, sender)
      if (!added)
        continue
      if (key.fromMe)
        this.store.chat(jid, { unread: 0 })
      else if (live && type !== 'reactionMessage')
        this.store.bumpUnread(jid)
      if (live) {
        const row = this.store.message(jid, key.id)
        const converted = row ? this.toMessage(row) : null
        if (converted)
          this.emit({ type: 'message', conversationId: jid, message: converted })
      }
    }
  }

  private emit(event: inbox.InboxEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      }
      catch {}
    }
  }

  // ── The inbox ───────────────────────────────────────────────────────

  async status(): Promise<inbox.InboxStatus> {
    if (this.state.phase === 'open')
      return { connected: true, detail: this.state.me ? `Linked as ${this.state.me}.` : 'Linked.' }
    if (this.linked)
      return { connected: true, detail: 'Reconnecting to WhatsApp. New messages arrive once it is back.' }
    return {
      connected: false,
      detail: this.state.error ?? 'Link Texts in WhatsApp on your phone: Settings, Linked Devices, Link a Device.',
      needs: 'signed-out',
    }
  }

  capabilities(): inbox.InboxCapabilities {
    return { send: true, attachments: true, replies: true, reactions: true, markRead: true, live: true }
  }

  watch(onEvent: (event: inbox.InboxEvent) => void): () => void {
    this.listeners.add(onEvent)
    return () => this.listeners.delete(onEvent)
  }

  private person(jid: string): inbox.InboxPerson {
    return { id: jid, name: this.store.nameOf(jid) ?? numberOf(jid), avatar: jid }
  }

  async conversations(): Promise<inbox.InboxConversation[]> {
    return this.store.chats()
      .filter(chat => chat.last || chat.at > 0)
      .map((chat) => {
        const group = isJidGroup(chat.jid)
        const groupRow = group ? this.store.groupRow(chat.jid) : null
        const last = chat.last
        const lastAt = Math.max(chat.at, last?.at ?? 0)
        return {
          provider: 'whatsapp' as const,
          id: chat.jid,
          kind: group ? 'group' as const : 'direct' as const,
          title: group ? (groupRow?.subject ?? chat.name) : null,
          participants: group ? (groupRow?.participants ?? []).map(jid => this.person(jid)) : [{ ...this.person(chat.jid), name: this.store.nameOf(chat.jid) ?? chat.name ?? numberOf(chat.jid) }],
          workspace: null,
          lastMessageAt: lastAt || null,
          preview: last ? (last.revoked ? 'This message was deleted' : this.preview(last)) : null,
          previewFromMe: !!last?.from_me,
          unread: chat.unread,
          cursor: `${last?.seq ?? 0}:${chat.at}`,
          visible: !chat.archived,
          archive: { mode: 'native' as const, detail: ARCHIVE_DETAIL },
          url: numberOf(chat.jid) ? `https://wa.me/${numberOf(chat.jid)!.slice(1)}` : null,
          avatar: chat.jid,
        }
      })
  }

  private preview(row: MessageRow): string | null {
    const message = this.parse(row)
    const text = row.edited_text ?? messageText(message.message)
    if (text)
      return text
    const content = normalizeMessageContent(message.message)
    const type = content ? getContentType(content) : undefined
    return type && (MEDIA_TYPES as readonly string[]).includes(type) ? MEDIA_LABEL[type as MediaType] : null
  }

  private parse(row: MessageRow): WAMessage {
    return JSON.parse(row.body, BufferJSON.reviver) as WAMessage
  }

  async messages(conversationId: string, query: inbox.MessageQuery = {}): Promise<inbox.InboxMessage[]> {
    const after = query.after !== undefined && query.after !== '' ? Number(query.after) || 0 : null
    return this.store.messages(conversationId, after, query.limit ?? 500)
      .map(row => this.toMessage(row))
      .filter((m): m is inbox.InboxMessage => !!m)
  }

  private toMessage(row: MessageRow): inbox.InboxMessage | null {
    const message = this.parse(row)
    const content = normalizeMessageContent(message.message)
    const type = content ? getContentType(content) : undefined
    const sender = row.from_me ? null : row.sender ? this.person(row.sender) : null
    const base = {
      id: row.id,
      conversationId: row.jid,
      fromMe: !!row.from_me,
      sentAt: row.at,
      sender,
      service: null,
      cursor: String(row.seq),
    }
    if (type === 'reactionMessage') {
      const reaction = content!.reactionMessage!
      return {
        ...base,
        kind: 'reaction',
        text: null,
        targetId: reaction.key?.id ?? null,
        reaction: reaction.text || null,
        reactionRemoved: !reaction.text,
        replyToId: null,
        editedAt: null,
        unsent: false,
        attachments: [],
      }
    }
    return {
      ...base,
      kind: 'message',
      text: row.revoked ? null : (row.edited_text ?? messageText(message.message)),
      targetId: null,
      reaction: null,
      reactionRemoved: false,
      replyToId: replyTo(content),
      editedAt: row.edited_at,
      unsent: !!row.revoked,
      attachments: row.revoked ? [] : this.attachments(row, content, type),
    }
  }

  private attachments(row: MessageRow, content: proto.IMessage | undefined, type: keyof proto.IMessage | undefined): inbox.InboxAttachment[] {
    if (!content || !type || !(MEDIA_TYPES as readonly string[]).includes(type))
      return []
    const media = content[type] as { mimetype?: string | null, fileLength?: unknown, fileName?: string | null } | null | undefined
    const mimeType = media?.mimetype?.split(';')[0]?.trim() || null
    const name = media?.fileName || `${MEDIA_LABEL[type as MediaType]}${(mimeType && MEDIA_EXTENSION[mimeType]) ?? ''}`
    const cached = join(this.mediaDir, this.mediaName(row.jid, row.id))
    return [{
      id: `${row.id}:media`,
      name,
      mimeType,
      bytes: toNumber(media?.fileLength),
      path: existsSync(cached) ? cached : null,
      url: `whatsapp-media:${encodeURIComponent(row.jid)}/${encodeURIComponent(row.id)}`,
    }]
  }

  private mediaName(jid: string, id: string): string {
    return createHash('sha256').update(`${jid}/${id}`).digest('hex').slice(0, 32)
  }

  /** Media is fetched from WhatsApp's servers and decrypted the first time it is wanted, then kept. */
  async attachment(attachment: inbox.InboxAttachment): Promise<Response> {
    const match = attachment.url?.match(/^whatsapp-media:([^/]+)\/(.+)$/)
    if (!match)
      return new Response('Not found', { status: 404 })
    const jid = decodeURIComponent(match[1]!)
    const id = decodeURIComponent(match[2]!)
    const file = join(this.mediaDir, this.mediaName(jid, id))
    const headers = { 'content-type': attachment.mimeType ?? 'application/octet-stream' }
    if (existsSync(file))
      return new Response(Bun.file(file), { headers })
    const row = this.store.message(jid, id)
    if (!row)
      return new Response('Not found', { status: 404 })
    try {
      const socket = this.socket
      const bytes = await downloadMediaMessage(this.parse(row), 'buffer', {}, socket ? { logger: SILENT_LOGGER, reuploadRequest: socket.updateMediaMessage } : undefined)
      mkdirSync(this.mediaDir, { recursive: true, mode: 0o700 })
      await Bun.write(file, bytes)
      return new Response(new Uint8Array(bytes), { headers })
    }
    catch {
      return new Response('Not found', { status: 404 })
    }
  }

  async avatar(ref: string): Promise<Response> {
    const socket = this.socket
    if (!socket || this.state.phase !== 'open')
      return new Response('Not found', { status: 404 })
    try {
      const url = await socket.profilePictureUrl(ref, 'image')
      if (!url)
        return new Response('Not found', { status: 404 })
      const response = await fetch(url)
      return response.ok ? new Response(await response.arrayBuffer(), { headers: { 'content-type': response.headers.get('content-type') ?? 'image/jpeg' } }) : new Response('Not found', { status: 404 })
    }
    catch {
      return new Response('Not found', { status: 404 })
    }
  }

  private requireSocket(): WASocket {
    if (!this.socket || this.state.phase !== 'open')
      throw new Error('WhatsApp is not connected right now. Texts reconnects by itself; try again in a moment.')
    return this.socket
  }

  async send(conversationId: string, message: inbox.OutgoingMessage): Promise<inbox.SendOutcome> {
    const socket = this.requireSocket()
    const quotedRow = message.replyToId ? this.store.message(conversationId, message.replyToId) : null
    const quoted = quotedRow ? this.parse(quotedRow) : undefined
    const text = message.text?.trim() ?? ''
    const files = message.files ?? []
    let last: WAMessage | undefined
    // The text rides on the first photo, video or document as its caption.
    let caption = text
    for (const file of files) {
      const mimetype = file.mimeType || Bun.file(file.path).type || 'application/octet-stream'
      const source = { url: file.path }
      const fileName = file.name ?? basename(file.path)
      const content = mimetype.startsWith('image/') && !mimetype.includes('gif')
        ? { image: source, mimetype, caption: caption || undefined }
        : mimetype.startsWith('video/')
          ? { video: source, mimetype, caption: caption || undefined }
          : mimetype.startsWith('audio/')
            ? { audio: source, mimetype }
            : { document: source, mimetype, fileName, caption: caption || undefined }
      if ('caption' in content)
        caption = ''
      last = await socket.sendMessage(conversationId, content, { quoted: last ? undefined : quoted })
    }
    if (caption)
      last = await socket.sendMessage(conversationId, { text: caption }, { quoted: files.length > 0 ? undefined : quoted })
    return { id: last?.key.id ?? null, sentAt: toNumber(last?.messageTimestamp) * 1000 || Date.now() }
  }

  async react(conversationId: string, messageId: string, reaction: string, remove = false): Promise<void> {
    const socket = this.requireSocket()
    const row = this.store.message(conversationId, messageId)
    if (!row)
      throw new Error('That message is not in your WhatsApp archive.')
    await socket.sendMessage(conversationId, { react: { text: remove ? '' : reaction, key: this.parse(row).key } })
  }

  async markRead(conversationId: string): Promise<void> {
    const unread = this.store.chatRow(conversationId)?.unread ?? 0
    this.store.chat(conversationId, { unread: 0 })
    const socket = this.socket
    if (socket && this.state.phase === 'open' && unread > 0)
      await socket.readMessages(this.store.unreadKeys(conversationId, unread)).catch(() => {})
  }

  private lastMessages(jid: string): Array<{ key: WAMessageKey, messageTimestamp: number }> {
    const row = this.store.messages(jid, null, 1)[0]
    if (!row)
      return []
    const message = this.parse(row)
    return [{ key: message.key, messageTimestamp: toNumber(message.messageTimestamp) }]
  }

  async archive(conversationId: string): Promise<inbox.ArchiveOutcome> {
    const socket = this.requireSocket()
    await socket.chatModify({ archive: true, lastMessages: this.lastMessages(conversationId) }, conversationId)
    this.store.chat(conversationId, { archived: true })
    return { mode: 'native', removed: true, detail: 'Archived in WhatsApp.' }
  }

  async unarchive(conversationId: string): Promise<void> {
    const socket = this.requireSocket()
    await socket.chatModify({ archive: false, lastMessages: this.lastMessages(conversationId) }, conversationId)
    this.store.chat(conversationId, { archived: false })
  }
}
