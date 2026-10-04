/* eslint-disable no-console */
import type { Server } from 'bun'
import type { ArchiveResult, ResurfaceMode, SyncReport, TranscriptMessage } from './archiver'
import type { LiveConversation } from './conversations'
import type { StoredConversation } from './store'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import process from 'node:process'
import { Archiver } from './archiver'
import { Contacts } from './contacts'
import { messagesUrl } from './conversations'
import { formatHandle } from './handles'
import { MessagesAccessError, MessagesDb } from './messages-db'
import { addressBookDir, ATTACHMENTS_DIR, DATABASE_PATH, DATA_DIR, messagesDbPath, PORT_FILE } from './paths'
import { ArchiveStore } from './store'

/**
 * The process behind Attic's window: a loopback HTTP server that owns every
 * permission-bound thing - reading chat.db and Contacts (Full Disk Access is
 * granted to Attic.app, whose executable this runs in), copying attachments,
 * opening Messages - and serves the UI the Craft window renders.
 *
 * Only the page Attic itself served may call it. Every API request must carry
 * the session cookie set with that page (SameSite=Strict, so another site's
 * form or fetch never has it) and name this server in its Host header (so a
 * DNS-rebinding page cannot pose as it).
 */

export type AccessState = 'granted' | 'needs-full-disk-access' | 'no-messages'

export interface ConversationSummary {
  key: string
  kind: 'direct' | 'group'
  title: string
  subtitle: string
  initials: string
  preview: string | null
  previewFromMe: boolean
  lastMessageAt: number | null
  unread: number
  state: 'inbox' | 'archived'
  /** Messages still lists it. False once removed (or never re-synced). */
  inMessages: boolean
  archivedAt: number | null
  resurfacedAt: number | null
  removedAt: number | null
  /** Attic holds a copy. */
  saved: boolean
  savedMessages: number
  openable: boolean
}

export interface AgentOptions {
  /** The built UI: index.html and its assets. */
  webRoot: string
  version: string
  port?: number
}

export interface Agent {
  port: number
  server: Server<undefined>
  stop: () => void
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

const SYNC_INTERVAL_MS = 2_000
const CONTACTS_TTL_MS = 10 * 60_000

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

function problem(message: string, status = 400): Response {
  return json({ error: message }, status)
}

/** The port used last time, so the page's origin - and its storage - stays put. */
function rememberedPort(): number {
  try {
    const port = Number(readFileSync(PORT_FILE, 'utf8'))
    return Number.isInteger(port) && port > 1024 && port < 65536 ? port : 0
  }
  catch {
    return 0
  }
}

function listFormat(names: string[]): string {
  if (names.length <= 2)
    return names.join(' & ')
  return `${names.slice(0, 2).join(', ')} & ${names.length - 2} other${names.length - 2 === 1 ? '' : 's'}`
}

export async function startAgent(options: AgentOptions): Promise<Agent> {
  mkdirSync(DATA_DIR, { recursive: true })
  const store = new ArchiveStore(DATABASE_PATH)
  const archiver = new Archiver({ store, openMessages: () => new MessagesDb(messagesDbPath()), attachmentsDir: ATTACHMENTS_DIR })
  const token = randomBytes(24).toString('hex')

  let contacts = new Contacts()
  let contactsLoadedAt = 0
  function names(): Contacts {
    const dir = addressBookDir()
    if (dir && Date.now() - contactsLoadedAt > CONTACTS_TTL_MS) {
      contacts = Contacts.load(dir)
      contactsLoadedAt = Date.now()
    }
    return contacts
  }

  function access(): AccessState {
    try {
      new MessagesDb(messagesDbPath()).close()
      return 'granted'
    }
    catch (error) {
      if (error instanceof MessagesAccessError && error.needsFullDiskAccess && existsSync(join(messagesDbPath(), '..')))
        return 'needs-full-disk-access'
      return 'no-messages'
    }
  }

  function personName(handle: string | null): string | null {
    if (!handle)
      return null
    return names().nameFor(handle) ?? formatHandle(handle)
  }

  function titleFor(kind: 'direct' | 'group', displayName: string | null, participants: string[]): string {
    if (kind === 'group')
      return displayName || listFormat(participants.map(p => personName(p)!)) || 'Group'
    return personName(participants[0] ?? null) ?? 'Unknown'
  }

  function summarize(live: LiveConversation | undefined, stored: StoredConversation | undefined): ConversationSummary {
    const kind = live?.kind ?? stored!.kind
    const participants = live?.participants ?? stored!.participants
    const title = titleFor(kind, live?.displayName ?? stored?.title ?? null, participants)
    const card = kind === 'direct' && participants[0] ? names().lookup(participants[0]) : null
    const words = title.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean)
    const initials = card?.initials ?? (kind === 'group' ? '' : (words.length > 0 ? (words[0]![0]! + (words.length > 1 ? words[words.length - 1]![0]! : '')).toUpperCase() : '#'))
    return {
      key: live?.key ?? stored!.key,
      kind,
      title,
      subtitle: kind === 'group' ? `${participants.length + 1} people` : (card ? formatHandle(participants[0]!) : (live?.services.join(' · ') ?? '')),
      initials: /\d/.test(initials) ? '#' : initials,
      preview: live && live.messageCount > 0 ? live.lastMessageText : null,
      previewFromMe: !!live?.lastMessageFromMe,
      lastMessageAt: live?.lastMessageAt ?? stored?.lastMessageAt ?? null,
      unread: live?.unreadCount ?? 0,
      state: stored?.state === 'archived' ? 'archived' : 'inbox',
      inMessages: !!live && live.messageCount > 0,
      archivedAt: stored?.archivedAt ?? null,
      resurfacedAt: stored?.resurfacedAt ?? null,
      removedAt: stored?.removedAt ?? null,
      saved: !!stored,
      savedMessages: stored?.messageCount ?? 0,
      openable: !!messagesUrl({ kind, groupId: live?.groupId ?? stored?.groupId ?? null, participants }),
    }
  }

  function conversations(view: 'inbox' | 'archived'): ConversationSummary[] {
    const stored = new Map(store.conversations().map(c => [c.key, c]))
    let live: LiveConversation[] = []
    try {
      live = archiver.live()
    }
    catch {}
    const liveKeys = new Map(live.map(c => [c.key, c]))
    const rows: ConversationSummary[] = []
    for (const conversation of live) {
      if (conversation.messageCount === 0 && !stored.has(conversation.key))
        continue
      rows.push(summarize(conversation, stored.get(conversation.key)))
    }
    // Conversations only Attic still has: removed from Messages, kept here.
    for (const [key, conversation] of stored) {
      if (!liveKeys.has(key))
        rows.push(summarize(undefined, conversation))
    }
    return rows
      .filter(row => row.state === view)
      .filter(row => row.inMessages || row.saved)
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
  }

  function summaryFor(key: string): ConversationSummary | null {
    const stored = store.conversation(key) ?? undefined
    let live: LiveConversation | undefined
    try {
      live = archiver.live().find(c => c.key === key)
    }
    catch {}
    if (!live && !stored)
      return null
    return summarize(live, stored)
  }

  function presentMessage(message: TranscriptMessage): Record<string, unknown> {
    return {
      ...message,
      senderName: message.isFromMe ? 'You' : personName(message.sender),
      reactions: message.reactions.map(r => ({ ...r, senderName: r.fromMe ? 'You' : personName(r.sender) })),
      attachments: message.attachments.map(a => ({
        guid: a.guid,
        name: a.name,
        mimeType: a.mimeType,
        bytes: a.bytes,
        isSticker: a.isSticker,
        available: a.status === 'copied',
        url: `/api/attachment?guid=${encodeURIComponent(a.guid)}`,
      })),
    }
  }

  // Server-sent events: the page refreshes its lists when Messages changes.
  const listeners = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const encoder = new TextEncoder()
  function broadcast(event: Record<string, unknown>): void {
    const chunk = encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
    for (const listener of listeners) {
      try {
        listener.enqueue(chunk)
      }
      catch {
        listeners.delete(listener)
      }
    }
  }

  function resurfaceMode(): ResurfaceMode {
    return store.setting('resurface') === 'stay' ? 'stay' : 'inbox'
  }

  let lastState: AccessState = access()
  let lastStamp = ''
  function stamp(): string {
    const path = messagesDbPath()
    let out = ''
    for (const file of [path, `${path}-wal`]) {
      try {
        const s = statSync(file)
        out += `${s.mtimeMs}:${s.size};`
      }
      catch {}
    }
    return out
  }

  function tick(): void {
    const state = access()
    if (state !== lastState) {
      lastState = state
      broadcast({ type: 'access', state })
    }
    if (state !== 'granted')
      return
    const current = stamp()
    if (current === lastStamp)
      return
    lastStamp = current
    let report: SyncReport = { resurfaced: [], removed: [], returned: [], copiedMessages: 0 }
    try {
      report = archiver.sync(resurfaceMode())
    }
    catch (error) {
      console.error(`[attic] sync failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    broadcast({
      type: 'changed',
      resurfaced: report.resurfaced.map(key => ({ key, title: summaryFor(key)?.title ?? key })),
      removed: report.removed,
    })
  }
  const timer = setInterval(tick, SYNC_INTERVAL_MS)

  function authorized(req: Request, port: number): boolean {
    const host = req.headers.get('host')
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
      return false
    const cookie = req.headers.get('cookie') ?? ''
    return cookie.split(/;\s*/).includes(`attic=${token}`)
  }

  function serveStatic(pathname: string): Response {
    const root = normalize(options.webRoot)
    const clean = decodeURIComponent(pathname).replace(/\/+$/, '') || '/index'
    const candidates = clean === '/index' ? ['index.html'] : [`${clean}.html`, `${clean}/index.html`, clean]
    for (const candidate of candidates) {
      const file = normalize(join(root, candidate))
      if (file !== root && !file.startsWith(`${root}${sep}`))
        continue
      if (existsSync(file) && statSync(file).isFile()) {
        const headers: Record<string, string> = { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }
        if (extname(file) === '.html') {
          headers['cache-control'] = 'no-store'
          headers['set-cookie'] = `attic=${token}; Path=/; HttpOnly; SameSite=Strict`
        }
        return new Response(Bun.file(file), { headers })
      }
    }
    return new Response('Not found', { status: 404 })
  }

  async function body(req: Request): Promise<Record<string, unknown>> {
    try {
      return await req.json() as Record<string, unknown>
    }
    catch {
      return {}
    }
  }

  function keyFrom(data: Record<string, unknown> | URLSearchParams): string | null {
    const key = data instanceof URLSearchParams ? data.get('key') : data.key
    return typeof key === 'string' && key.length > 0 ? key : null
  }

  function openUrl(url: string): void {
    Bun.spawn(['/usr/bin/open', url], { stdio: ['ignore', 'ignore', 'ignore'] })
  }

  let port = 0
  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    if (!url.pathname.startsWith('/api/'))
      return serveStatic(url.pathname)
    if (!authorized(req, port))
      return problem('Forbidden', 403)

    try {
      switch (`${req.method} ${url.pathname}`) {
        case 'GET /api/status': {
          const stored = store.conversations()
          return json({
            version: options.version,
            access: access(),
            fixture: !!process.env.ATTIC_MESSAGES_DB,
            archived: stored.filter(c => c.state === 'archived').length,
            saved: stored.length,
            settings: { resurface: resurfaceMode() },
          })
        }
        case 'GET /api/conversations': {
          const view = url.searchParams.get('view') === 'archived' ? 'archived' : 'inbox'
          return json(access() === 'granted' || store.conversations().length > 0 ? conversations(view) : [])
        }
        case 'GET /api/conversation': {
          const key = keyFrom(url.searchParams)
          const summary = key ? summaryFor(key) : null
          if (!summary)
            return problem('No such conversation', 404)
          const stored = store.conversation(summary.key)
          const participants = (stored?.participants ?? []).length > 0 ? stored!.participants : []
          return json({
            ...summary,
            participants: participants.map(handle => ({ handle, name: personName(handle) })),
            attachments: stored?.attachmentCount ?? 0,
            attachmentBytes: stored?.attachmentBytes ?? 0,
            missingAttachments: stored?.missingAttachments ?? 0,
          })
        }
        case 'GET /api/messages': {
          const key = keyFrom(url.searchParams)
          if (!key)
            return problem('key is required')
          const before = Number(url.searchParams.get('before')) || undefined
          const transcript = archiver.transcript(key, { beforeMs: before, limit: 250 })
          return json({ ...transcript, messages: transcript.messages.map(presentMessage) })
        }
        case 'POST /api/archive': {
          const key = keyFrom(await body(req))
          if (!key)
            return problem('key is required')
          const result: ArchiveResult = archiver.archive(key)
          broadcast({ type: 'changed', resurfaced: [], removed: [] })
          return json(result)
        }
        case 'POST /api/unarchive': {
          const key = keyFrom(await body(req))
          if (!key)
            return problem('key is required')
          archiver.unarchive(key)
          broadcast({ type: 'changed', resurfaced: [], removed: [] })
          return json({ ok: true })
        }
        case 'POST /api/forget': {
          const key = keyFrom(await body(req))
          if (!key)
            return problem('key is required')
          archiver.forget(key)
          broadcast({ type: 'changed', resurfaced: [], removed: [] })
          return json({ ok: true })
        }
        case 'POST /api/open': {
          const key = keyFrom(await body(req))
          const summary = key ? summaryFor(key) : null
          const stored = key ? store.conversation(key) : null
          const live = key ? archiver.live().find(c => c.key === key) : undefined
          const target = summary && messagesUrl({ kind: summary.kind, groupId: live?.groupId ?? stored?.groupId ?? null, participants: live?.participants ?? stored?.participants ?? [] })
          if (!target)
            return problem('Messages cannot open this conversation by address', 422)
          openUrl(target)
          return json({ ok: true })
        }
        case 'GET /api/search': {
          const q = url.searchParams.get('q') ?? ''
          const hits = store.search(q, 60).map(hit => ({
            ...hit,
            title: summaryFor(hit.conversationKey)?.title ?? hit.conversationKey,
            senderName: hit.isFromMe ? 'You' : personName(hit.sender),
          }))
          return json(hits)
        }
        case 'GET /api/attachment': {
          const guid = url.searchParams.get('guid')
          const file = guid ? archiver.attachmentFile(guid) : null
          if (!file)
            return new Response('Not found', { status: 404 })
          return new Response(Bun.file(file.path), {
            headers: {
              'content-type': file.mimeType ?? 'application/octet-stream',
              'content-disposition': `inline; filename="${encodeURIComponent(file.name)}"`,
              'cache-control': 'private, max-age=3600',
            },
          })
        }
        case 'POST /api/settings': {
          const data = await body(req)
          if (data.resurface === 'inbox' || data.resurface === 'stay')
            store.setSetting('resurface', data.resurface)
          return json({ resurface: resurfaceMode() })
        }
        case 'POST /api/privacy': {
          openUrl('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles')
          return json({ ok: true })
        }
        case 'GET /api/events': {
          let controller: ReadableStreamDefaultController<Uint8Array> | null = null
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              controller = c
              listeners.add(c)
              c.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'hello', access: access() })}\n\n`))
            },
            cancel() {
              if (controller)
                listeners.delete(controller)
            },
          })
          return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'connection': 'keep-alive' } })
        }
      }
      return problem('Not found', 404)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[attic] ${req.method} ${url.pathname}: ${message}`)
      return problem(message, error instanceof MessagesAccessError ? 403 : 500)
    }
  }

  const tryServe = (wanted: number): Server<undefined> => Bun.serve({ hostname: '127.0.0.1', port: wanted, idleTimeout: 0, fetch: handler })
  let server: Server<undefined>
  try {
    server = tryServe(options.port ?? rememberedPort())
  }
  catch {
    server = tryServe(0)
  }
  port = server.port ?? 0
  try {
    writeFileSync(PORT_FILE, String(port))
  }
  catch {}

  tick()
  return {
    port,
    server,
    stop() {
      clearInterval(timer)
      for (const listener of listeners) {
        try {
          listener.close()
        }
        catch {}
      }
      server.stop(true)
      store.close()
    },
  }
}
