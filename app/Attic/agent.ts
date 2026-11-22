/* eslint-disable no-console */
import type { Server } from 'bun'
import type { ResurfaceMode, SyncReport, TranscriptMessage } from './archiver'
import type { LiveEntry } from './sources'
import type { Provider, StoredConversation } from './store'
import type { LinkState } from './whatsapp-link'
import { inbox } from '@stacksjs/chat'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { hostname } from 'node:os'
import process from 'node:process'
import { decode, encode, resize } from 'ts-images'
import { toSvg } from 'ts-qr-codes'
import { Archiver, ruleFor, ruleValue } from './archiver'
import { exportArchive, exportFolder } from './export'
import { IMessageNotices } from './imessage-local'
import { deleteSecret, writeSecret } from './keychain'
import { accessibilityTrusted, MessagesControlDeferred } from './messages-app'
import { PhoneLink } from './phone-link'
import { ATTACHMENTS_DIR, AVATARS_DIR, DATA_DIR, DATABASE_PATH, EXPORTS_PARENT, messagesDbPath, OUTGOING_DIR, PORT_FILE, PREVIEWS_DIR, whatsappDbPath } from './paths'
import { slackIdentity, upsertWorkspace } from './slack-workspaces'
import { Sources } from './sources'
import { ArchiveStore, splitKey } from './store'
import { createAtticUpdater } from './updates'

/**
 * The process behind Attic's window: a loopback HTTP server that owns every
 * credential and permission - reading Messages and Contacts (Full Disk Access
 * is granted to Attic.app, whose executable this runs in), the Slack and
 * Discord tokens in the keychain, the WhatsApp device, the archive - and serves the UI the Craft
 * window renders.
 *
 * Only the page Attic itself served may call it. Every API request must carry
 * the session cookie set with that page (SameSite=Strict, so another site's
 * form or fetch never has it) and name this server in its Host header (so a
 * DNS-rebinding page cannot pose as it).
 */

export type RemovalMode = 'auto' | 'confirm' | 'off'

export interface ConversationSummary {
  key: string
  provider: Provider
  kind: StoredConversation['kind']
  title: string
  /** The person's or group's picture, served by this agent; null to show initials. */
  avatar: string | null
  /** The "always archive" rule covering it, if any. */
  rule: { id: number, kind: 'person' | 'conversation' } | null
  subtitle: string
  initials: string
  preview: string | null
  previewFromMe: boolean
  lastMessageAt: number | null
  unread: number
  state: 'inbox' | 'archived'
  /** The real app lists it right now. */
  inApp: boolean
  archivedAt: number | null
  resurfacedAt: number | null
  removedAt: number | null
  /** Attic holds a copy. */
  saved: boolean
  savedMessages: number
  url: string | null
  /** What archiving does in the real app: 'native', 'confirm' or 'unsupported'. */
  archiveMode: string
  /** Messages in the app's Recently Deleted, not yet purged. */
  deleted: number
  archiveDetail: string
}

export interface AgentOptions {
  /** The built UI: index.html and its assets. */
  webRoot: string
  version: string
  port?: number
  onUpdateRelaunch?: () => void
  notify?: (id: string, title: string, body: string) => void
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

/** iMessage is checked every tick (a local stat); Slack and Discord every minute. */
const TICK_MS = 2_000
const IMESSAGE_NOTICE_MS = 1_000
const REMOTE_SYNC_MS = 60_000
const LABELS: Record<Provider, string> = { imessage: 'iMessage', whatsapp: 'WhatsApp', slack: 'Slack', discord: 'Discord' }

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

function initialsOf(title: string): string {
  const words = title.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0 || /^\d/.test(words[0]!))
    return '#'
  return (words[0]![0]! + (words.length > 1 ? words[words.length - 1]![0]! : '')).toUpperCase()
}

/** Longest edge of a display preview: sharp in a full-window view, a fraction of the original's weight. */
const PREVIEW_EDGE = 2048

/** A cached picture is refreshed from the app after a week; people change their photos. */
const AVATAR_TTL_MS = 7 * 24 * 60 * 60_000

/**
 * A profile picture through a disk cache. The app is asked first when the
 * copy is missing or old; if it has nothing now (an archived chat whose
 * person left, a source disconnected) the cached copy still answers.
 */
async function avatarResponse(provider: Provider, ref: string, driver: inbox.InboxDriver | undefined): Promise<Response> {
  const file = join(AVATARS_DIR, createHash('sha256').update(`${provider}:${ref}`).digest('hex').slice(0, 32))
  const cached = Bun.file(file)
  const fresh = existsSync(file) && Date.now() - statSync(file).mtimeMs < AVATAR_TTL_MS
  if (!fresh && driver?.avatar) {
    try {
      const response = await driver.avatar(ref)
      let bytes: Uint8Array | null = response.ok ? new Uint8Array(await response.arrayBuffer()) : null
      // Group photos arrive as iPhone HEIC: kept as a small JPEG any viewer reads.
      if (bytes && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp') {
        const decoded = await decode(bytes)
        bytes = await encode(resize(decoded, { width: 256, height: 256, fit: 'cover' }), 'jpeg', { quality: 85 })
      }
      if (bytes && bytes.length > 0 && bytes.length < 5_000_000) {
        mkdirSync(AVATARS_DIR, { recursive: true })
        await Bun.write(file, bytes)
      }
    }
    catch {}
  }
  if (!existsSync(file))
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'private, max-age=300' } })
  const head = new Uint8Array(await cached.slice(0, 12).arrayBuffer())
  const type = head[0] === 0x89 ? 'image/png' : head[0] === 0x47 ? 'image/gif' : head[8] === 0x57 ? 'image/webp' : String.fromCharCode(...head.subarray(4, 8)) === 'ftyp' ? 'image/heic' : 'image/jpeg'
  return new Response(cached, { headers: { 'content-type': type, 'cache-control': 'private, max-age=86400' } })
}

/** Photos ts-images could not decode this run, so a failure is not retried on every view. */
const undecodable = new Set<string>()

/**
 * A cached JPEG rendering of a HEIC photo, decoded and encoded by ts-images.
 * Made once per attachment; null when the photo cannot be decoded, and the
 * caller then serves the original as it is.
 */
async function heicPreview(guid: string, original: Response): Promise<string | null> {
  const out = join(PREVIEWS_DIR, `${guid.replace(/[^\w-]/g, '_')}.jpg`)
  if (existsSync(out))
    return out
  if (undecodable.has(guid))
    return null
  try {
    const decoded = await decode(new Uint8Array(await original.arrayBuffer()))
    const fitted = decoded.width > PREVIEW_EDGE || decoded.height > PREVIEW_EDGE
      ? resize(decoded, { width: PREVIEW_EDGE, height: PREVIEW_EDGE, fit: 'inside' })
      : decoded
    mkdirSync(PREVIEWS_DIR, { recursive: true })
    await Bun.write(out, await encode(fitted, 'jpeg', { quality: 85 }))
    return out
  }
  catch (error) {
    undecodable.add(guid)
    console.warn(`[attic] no preview for ${guid}: ${error instanceof Error ? error.message : error}`)
    return null
  }
}

async function waitUntil(check: () => Promise<boolean>, ms = 12_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check())
      return true
    await Bun.sleep(400)
  }
  return check()
}

export async function startAgent(options: AgentOptions): Promise<Agent> {
  mkdirSync(DATA_DIR, { recursive: true })
  const store = new ArchiveStore(DATABASE_PATH)
  const usingSample = !!process.env.ATTIC_MESSAGES_DB
  const token = randomBytes(24).toString('hex')

  function removalMode(): RemovalMode {
    const value = store.setting('removal')
    return value === 'auto' || value === 'off' ? value : 'confirm'
  }
  function resurfaceMode(): ResurfaceMode {
    return store.setting('resurface') === 'stay' ? 'stay' : 'inbox'
  }

  // The WhatsApp link reports its progress before the event stream below
  // exists; until it does, there is no window to tell.
  let linkListener: ((state: LinkState) => void) | null = null
  const sources = new Sources({ confirmDeletes: () => removalMode() === 'auto', sample: usingSample, onWhatsAppLink: state => linkListener?.(state) })
  await sources.load()
  const archiver = new Archiver({ store, sources, attachmentsDir: ATTACHMENTS_DIR })

  /** A phone number or address as people write it; WhatsApp ids are `<number>@s.whatsapp.net`. */
  function handleLabel(id: string): string {
    return inbox.formatHandle(id.includes('@s.whatsapp.net') ? inbox.formatJid(id) : id)
  }

  function personLabel(person: { id: string, name: string | null }): string {
    return person.name ?? handleLabel(person.id)
  }

  /** Where the page loads a picture from: the agent, which caches it. */
  function avatarUrl(provider: Provider, ref: string | null | undefined): string | null {
    return ref ? `/api/avatar?provider=${provider}&ref=${encodeURIComponent(ref)}` : null
  }

  // Rules are read once per request burst; they change only through the endpoints below.
  let currentRules = store.rules()

  function summarize(live: LiveEntry | undefined, stored: StoredConversation | undefined): ConversationSummary {
    const conversation = live?.conversation
    const provider = live?.provider ?? stored!.provider
    const kind = conversation?.kind ?? stored!.kind
    const participants = conversation?.participants?.length ? conversation.participants : (stored?.participants ?? [])
    const named = conversation?.title ?? stored?.title ?? null
    const title = named
      ?? (kind === 'direct' && participants[0] ? personLabel(participants[0]) : null)
      ?? (participants.length > 0 ? listFormat(participants.map(personLabel)) : 'Conversation')
    const workspace = conversation?.workspace ?? stored?.workspace ?? null
    const subtitle = workspace
      ? `${LABELS[provider]} · ${workspace}`
      : kind === 'group' ? `${participants.length + 1} people` : (participants[0]?.name ? handleLabel(participants[0].id) : LABELS[provider])
    const archive = conversation?.archive ?? (provider === 'imessage' ? { mode: 'confirm', detail: '' } : { mode: 'unsupported', detail: '' })
    return {
      key: live?.key ?? stored!.key,
      provider,
      kind,
      title,
      avatar: avatarUrl(provider, kind === 'direct' ? participants[0]?.avatar : (conversation?.avatar ?? stored?.avatar)),
      rule: (() => {
        const rule = ruleFor(currentRules, live?.key ?? stored!.key, kind, participants)
        return rule ? { id: rule.id, kind: rule.kind } : null
      })(),
      subtitle,
      initials: kind === 'direct' ? initialsOf(title) : '',
      preview: conversation?.visible ? conversation.preview : null,
      previewFromMe: !!conversation?.previewFromMe,
      lastMessageAt: conversation?.lastMessageAt ?? stored?.lastMessageAt ?? null,
      unread: conversation?.unread ?? 0,
      state: stored?.state === 'archived' ? 'archived' : 'inbox',
      inApp: !!conversation?.visible,
      archivedAt: stored?.archivedAt ?? null,
      resurfacedAt: stored?.resurfacedAt ?? null,
      removedAt: stored?.removedAt ?? null,
      saved: !!stored,
      savedMessages: stored?.messageCount ?? 0,
      url: conversation?.url ?? stored?.url ?? null,
      archiveMode: archive.mode,
      archiveDetail: archive.detail,
      deleted: conversation?.deleted ?? 0,
    }
  }

  async function conversations(view: 'inbox' | 'archived' | 'deleted', source: Provider | 'all'): Promise<ConversationSummary[]> {
    const stored = new Map(store.conversations().map(c => [c.key, c]))
    const live = await sources.live()
    // Deleted in the app but still recoverable there, and not yet kept by
    // Attic: the ones to rescue before the app purges them.
    if (view === 'deleted') {
      return live
        .filter(e => !e.conversation.visible && (e.conversation.deleted ?? 0) > 0 && stored.get(e.key)?.state !== 'archived')
        .filter(e => source === 'all' || e.provider === source)
        .map(e => summarize(e, stored.get(e.key)))
        .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
    }
    const liveKeys = new Set(live.map(e => e.key))
    const rows: ConversationSummary[] = []
    for (const entry of live) {
      // The real app hides it and Attic has no copy: nothing to show.
      if (!entry.conversation.visible && !stored.has(entry.key))
        continue
      rows.push(summarize(entry, stored.get(entry.key)))
    }
    // Conversations only Attic still has.
    for (const [key, conversation] of stored) {
      if (!liveKeys.has(key))
        rows.push(summarize(undefined, conversation))
    }
    return rows
      .filter(row => row.state === view && (source === 'all' || row.provider === source))
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
  }

  async function summaryFor(key: string): Promise<ConversationSummary | null> {
    const stored = store.conversation(key) ?? undefined
    const live = (await sources.live()).find(e => e.key === key)
    if (!live && !stored)
      return null
    return summarize(live, stored)
  }

  async function visibleInApp(key: string): Promise<boolean> {
    return !!(await sources.live(true)).find(e => e.key === key)?.conversation.visible
  }

  /** Pictures of the people in a conversation, by their provider id, for the transcript. */
  async function avatarsFor(key: string): Promise<Map<string, string>> {
    const { provider } = splitKey(key)
    const live = (await sources.live()).find(e => e.key === key)?.conversation.participants ?? []
    const stored = store.conversation(key)?.participants ?? []
    const avatars = new Map<string, string>()
    for (const person of [...stored, ...live]) {
      const url = avatarUrl(provider, person.avatar)
      if (url)
        avatars.set(person.id, url)
    }
    return avatars
  }

  function presentMessage(message: TranscriptMessage, avatars: Map<string, string> = new Map()): Record<string, unknown> {
    // Belt and braces for the attachment placeholder: never an empty bubble.
    const text = message.text?.replace(/\uFFFC/g, '').trim() || null
    return {
      ...message,
      text,
      senderAvatar: !message.isFromMe && message.sender ? avatars.get(message.sender) ?? null : null,
      senderName: message.isFromMe ? 'You' : (message.senderName ?? (message.sender ? inbox.formatHandle(message.sender) : null)),
      reactions: message.reactions.map(r => ({ ...r, senderName: r.fromMe ? 'You' : r.senderName })),
      attachments: message.attachments.map(a => ({
        guid: a.guid,
        name: a.name,
        mimeType: a.mimeType,
        bytes: a.bytes,
        available: a.status === 'copied',
        url: `/api/attachment?guid=${encodeURIComponent(a.guid)}`,
      })),
    }
  }

  // Server-sent events: the page refreshes its lists when an app changes.
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

  const updates = createAtticUpdater(options.version, !!options.onUpdateRelaunch, status => broadcast({ type: 'update', status }))
  let restarting = false

  /** A sync that follows the "When you archive" setting, for what rules archive. */
  function syncArchive(force = false): Promise<SyncReport> {
    return archiver.sync(resurfaceMode(), Date.now(), force, { removeFromApps: removalMode() !== 'off' })
  }

  async function announce(report: SyncReport): Promise<void> {
    broadcast({
      type: 'changed',
      resurfaced: await Promise.all(report.resurfaced.map(async key => ({ key, title: (await summaryFor(key))?.title ?? key }))),
      removed: report.removed,
    })
  }

  /** The WhatsApp link as the Connect sheet draws it, with the code to scan as an SVG. */
  function linkView(state: LinkState | null = sources.whatsappLink()?.linkState() ?? null): Record<string, unknown> {
    if (!state)
      return { available: false, phase: 'signed-out', qr: null, me: null, error: 'Sample data has no WhatsApp to link.' }
    return { available: true, phase: state.phase, me: state.me, error: state.error, qr: state.qr ? toSvg(state.qr) : null }
  }
  linkListener = state => broadcast({ type: 'whatsapp', link: linkView(state) })

  // iMessage changes are noticed from chat.db's own files; the rest on a timer.
  let lastStamp = ''
  let lastRemote = 0
  let lastStates = ''
  function stamp(): string {
    // Messages and WhatsApp both write locally: either changing means a sync.
    let out = ''
    for (const file of [messagesDbPath(), whatsappDbPath()].flatMap(path => [path, `${path}-wal`])) {
      try {
        const s = statSync(file)
        out += `${s.mtimeMs}:${s.size};`
      }
      catch {}
    }
    return out
  }

  let ticking = false
  async function tick(): Promise<void> {
    if (ticking)
      return
    ticking = true
    try {
      const states = JSON.stringify(await sources.refreshStates())
      if (states !== lastStates) {
        lastStates = states
        broadcast({ type: 'sources' })
      }
      const local = stamp()
      const remoteDue = Date.now() - lastRemote > REMOTE_SYNC_MS
      if (local === lastStamp && !remoteDue)
        return
      lastStamp = local
      if (remoteDue) {
        lastRemote = Date.now()
        sources.invalidate('slack')
        sources.invalidate('discord')
      }
      await announce(await syncArchive())
      await noticeIncoming()
    }
    catch (error) {
      console.error(`[attic] sync failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    finally {
      ticking = false
    }
  }
  const timer = setInterval(() => void tick(), TICK_MS)

  // ── New messages, for notifications ─────────────────────────────────
  //
  // Two ways in, one rule. Apps that push (Slack over Socket Mode, Discord's
  // gateway) report each message as it arrives. The rest - Messages and
  // WhatsApp on this Mac, Slack without Socket Mode - are compared after each
  // sync: a conversation whose newest message is newer than before, someone
  // else's, and unread. Each conversation remembers the newest message it was
  // announced for, so the two never announce one message twice.
  const announced = new Map<string, number>()
  let primed = false
  const imessageNotices = new IMessageNotices(messagesDbPath())

  function announceIncoming(key: string, details: { title: string, sender: string | null, text: string, at: number, group: boolean }): void {
    if ((announced.get(key) ?? 0) >= details.at)
      return
    announced.set(key, details.at)
    broadcast({ type: 'incoming', key, provider: splitKey(key).provider, ...details })
    options.notify?.(`attic-${key}-${details.at}`, details.title, details.text)
  }

  async function noticeIncoming(): Promise<void> {
    for (const entry of await sources.live()) {
      if (entry.provider === 'imessage')
        continue
      const conversation = entry.conversation
      const at = conversation.lastMessageAt ?? 0
      const seen = announced.get(entry.key) ?? 0
      // The first pass learns where everything stands; it announces nothing.
      if (!primed || at <= seen || conversation.previewFromMe || conversation.unread === 0) {
        announced.set(entry.key, Math.max(seen, at))
        continue
      }
      announceIncoming(entry.key, {
        title: summarize(entry, store.conversation(entry.key) ?? undefined).title,
        sender: null,
        text: conversation.preview ?? 'New message',
        at,
        group: conversation.kind !== 'direct',
      })
    }
    primed = true
  }

  function noticeMessages(): void {
    if (!sources.connected('imessage'))
      return
    try {
      for (const { key, ...notice } of imessageNotices.read())
        announceIncoming(key, notice)
    }
    catch {
      // Messages may be syncing its database or Full Disk Access may have changed.
    }
  }

  const stopListening = sources.listen(({ provider, event }) => {
    // Something changed in a pushing app: sync it on the next tick.
    lastRemote = 0
    if (event.type !== 'message' || event.message.fromMe || event.message.kind !== 'message')
      return
    const key = `${provider}:${event.conversationId}`
    const message = event.message
    void (async () => {
      const entry = (await sources.live()).find(e => e.key === key)
      announceIncoming(key, {
        title: entry ? summarize(entry, store.conversation(key) ?? undefined).title : (message.sender?.name ?? 'New message'),
        sender: message.sender?.name ?? null,
        text: message.text ?? (message.attachments.length > 0 ? (message.attachments.length === 1 ? 'Attachment' : `${message.attachments.length} attachments`) : 'New message'),
        at: message.sentAt,
        group: !!entry && entry.conversation.kind !== 'direct',
      })
    })()
  })

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

  interface AppOutcome {
    attempted: boolean
    removed: boolean
    detail: string
  }

  /** After a verified copy: out of the real app, as far as it allows. */
  async function takeOutOfApp(key: string, options: { background?: boolean } = {}): Promise<AppOutcome> {
    const mode = removalMode()
    if (mode === 'off')
      return { attempted: false, removed: false, detail: 'Kept in the app, as set.' }
    const { provider } = splitKey(key)
    if (!(await visibleInApp(key)))
      return { attempted: false, removed: true, detail: '' }
    const outcome = await archiver.removeFromApp(key, options).catch((error: unknown) => {
      if (!(error instanceof MessagesControlDeferred))
        throw error
      return null
    })
    if (!outcome)
      return { attempted: false, removed: false, detail: `Kept in ${LABELS[provider]}.` }
    if (outcome.mode === 'unsupported')
      return { attempted: false, removed: false, detail: outcome.detail }
    let removed = outcome.removed
    // A delete Attic confirmed lands in chat.db a moment later.
    if (!removed && provider === 'imessage' && mode === 'auto' && !usingSample)
      removed = await waitUntil(async () => !(await visibleInApp(key)))
    if (!options.background)
      await announce(await syncArchive(true))
    return { attempted: true, removed, detail: removed ? `Removed from ${LABELS[provider]}.` : outcome.detail }
  }

  /*
   * Bulk archive: everything in the Inbox quiet for longer than a cutoff, one
   * conversation at a time through the same copy-verify-archive path as a
   * single archive. A real history has thousands of these, so it runs as a
   * job the page follows over the event stream and can cancel. Taking them
   * out of the apps follows Settings and must never open or focus a local app
   * while the job runs.
   */
  interface BulkJob {
    total: number
    done: number
    archived: number
    removed: number
    failed: number
    cancelled: boolean
    finished: boolean
    startedAt: number
  }
  let bulk: BulkJob | null = null
  /** One export at a time: two at once would write into the same folder. */
  let exporting = false

  async function bulkCandidates(olderThanDays: number, source: Provider | 'all'): Promise<ConversationSummary[]> {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60_000
    return (await conversations('inbox', source)).filter(c => c.state !== 'archived' && (c.lastMessageAt ?? 0) < cutoff)
  }

  function bulkState(): Record<string, unknown> | null {
    return bulk ? { ...bulk } : null
  }

  async function runBulk(job: BulkJob, keys: string[]): Promise<void> {
    let lastBroadcast = 0
    for (const key of keys) {
      if (job.cancelled)
        break
      try {
        const result = await archiver.archive(key)
        if (result.verified) {
          job.archived++
          if ((await takeOutOfApp(key, { background: true })).removed)
            job.removed++
        }
        else {
          job.failed++
        }
      }
      catch (error) {
        job.failed++
        console.error(`[attic] bulk archive ${key}: ${error instanceof Error ? error.message : String(error)}`)
      }
      job.done++
      // Progress at most a few times a second, and the list once in a while.
      if (Date.now() - lastBroadcast > 400) {
        lastBroadcast = Date.now()
        broadcast({ type: 'bulk', job: bulkState() })
      }
    }
    job.finished = true
    await announce(await syncArchive(true))
    broadcast({ type: 'bulk', job: bulkState() })
    broadcast({ type: 'changed', resurfaced: [], removed: [] })
  }

  /** Archive one conversation: copy, verify, then out of the app. The window and the phone both come here. */
  async function archiveConversation(key: string): Promise<Record<string, unknown>> {
    const result = await archiver.archive(key)
    // Only a complete, verified copy may leave the real app.
    const app = result.verified ? await takeOutOfApp(key) : { attempted: false, removed: false, detail: 'The copy is not complete yet, so the app was not touched.' }
    broadcast({ type: 'changed', resurfaced: [], removed: [] })
    return { ...result, app }
  }

  async function unarchiveConversation(key: string): Promise<Record<string, unknown>> {
    const before = store.conversation(key)
    // Moving a conversation back to the Inbox ends the rule that would
    // archive it again on the next sync.
    const covering = (await summaryFor(key))?.rule ?? null
    if (covering) {
      store.deleteRule(covering.id)
      currentRules = store.rules()
    }
    await archiver.unarchive(key)
    let detail = covering ? 'It is no longer archived automatically.' : ''
    const { provider } = splitKey(key)
    if (before?.removedAt && provider === 'imessage' && !usingSample) {
      const back = await waitUntil(() => visibleInApp(key))
      detail = `${back ? 'Recovered in Messages.' : 'Messages did not bring it back. If it has left Recently Deleted, your local copy in Texts is the one that remains.'} ${detail}`.trim()
    }
    else if (before?.removedAt && !usingSample) {
      detail = `${await visibleInApp(key) ? `Back in ${LABELS[provider]}.` : `${LABELS[provider]} did not bring it back.`} ${detail}`.trim()
    }
    await announce(await syncArchive(true))
    return { ok: true, app: { detail } }
  }

  /** React to a message: the window's menu, its press-and-hold, and the phone's long-press all come here. */
  async function reactTo(key: string, messageId: string, reaction: string, remove: boolean): Promise<{ ok: true }> {
    if (!key || !messageId || !reaction)
      throw new Error('key, messageId and reaction are required')
    const { provider, id } = splitKey(key)
    const driver = sources.driver(provider)
    if (!driver?.react || !driver.capabilities?.().reactions)
      throw new Error(`Texts cannot react in ${driver?.label ?? provider} yet.`)
    await driver.react(id, messageId, reaction, remove)
    sources.invalidate(provider)
    // The reaction lands in the app's own store: look again on the next tick.
    lastStamp = ''
    lastRemote = 0
    return { ok: true }
  }

  /*
   * The phone app: a paired phone keeps its own copy of the archive and
   * reaches this Mac over the local network through PhoneLink, every request
   * sealed with the key it got at pairing.
   */
  function phoneSummary(c: ConversationSummary): Record<string, unknown> {
    const { archiveDetail: _, ...rest } = c
    return rest
  }

  const phone = new PhoneLink(store, {
    hello: async () => ({ name: hostname().replace(/\.local$/, ''), version: options.version }),
    pull: async (since) => {
      const live = new Map((await sources.live()).map(e => [e.key, e]))
      const stored = store.conversations()
      const page = store.messagesAfter(since, 1500)
      return {
        conversations: stored.map(c => phoneSummary(summarize(live.get(c.key), c))),
        messages: page.map(({ rowid, message }) => ({
          ...message,
          rowid,
          attachments: message.attachments.map(a => ({ guid: a.guid, name: a.name, mimeType: a.mimeType, bytes: a.bytes, available: a.status === 'copied' })),
        })),
        cursor: page.at(-1)?.rowid ?? since,
        more: page.length === 1500,
      }
    },
    inbox: async () => (await conversations('inbox', 'all')).slice(0, 300).map(phoneSummary),
    archive: key => archiveConversation(key),
    unarchive: key => unarchiveConversation(key),
    react: (key, messageId, reaction, remove) => reactTo(key, messageId, reaction, remove),
    avatar: async (url) => {
      const query = new URL(url, 'http://attic.local').searchParams
      const provider = query.get('provider') as Provider | null
      const ref = query.get('ref')
      if (!provider || !ref || !LABELS[provider])
        return null
      const response = await avatarResponse(provider, ref, sources.driver(provider))
      if (!response.ok)
        return null
      return { type: response.headers.get('content-type') ?? 'image/jpeg', data: Buffer.from(await response.arrayBuffer()).toString('base64') }
    },
  })
  phone.start()

  let port = 0
  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    // AppKit uses a shared, ephemeral URLSession cookie store. Issue the same
    // HttpOnly session as the web shell without loading or rendering HTML.
    if (req.method === 'GET' && url.pathname === '/native/session') {
      if (req.headers.get('host') !== `127.0.0.1:${port}` && req.headers.get('host') !== `localhost:${port}`)
        return problem('Forbidden', 403)
      const response = json({ version: options.version, renderer: 'appkit' })
      response.headers.set('set-cookie', `attic=${token}; Path=/; HttpOnly; SameSite=Strict`)
      return response
    }
    if (!url.pathname.startsWith('/api/'))
      return serveStatic(url.pathname)
    if (!authorized(req, port))
      return problem('Forbidden', 403)

    try {
      switch (`${req.method} ${url.pathname}`) {
        case 'GET /api/updates':
          return json(updates.status())
        case 'POST /api/updates/check':
          return json(await updates.run('check'))
        case 'POST /api/updates/install':
          return json(await updates.run('install'))
        case 'POST /api/updates/relaunch': {
          if (!options.onUpdateRelaunch || updates.status().state !== 'installed')
            return problem('An update must be installed before restarting.', 409)
          if (!restarting) {
            restarting = true
            try { await updates.relaunch() }
            catch (error) { restarting = false; throw error }
            setTimeout(options.onUpdateRelaunch, 100)
          }
          return json({ ok: true })
        }
        case 'GET /api/status': {
          const stored = store.conversations()
          const states = sources.statesList()
          const imessage = states.find(s => s.provider === 'imessage')?.status
          return json({
            version: options.version,
            access: imessage?.connected ? 'granted' : imessage?.needs === 'full-disk-access' ? 'needs-full-disk-access' : 'no-messages',
            sources: states,
            fixture: usingSample,
            archived: stored.filter(c => c.state === 'archived').length,
            saved: stored.length,
            settings: { resurface: resurfaceMode(), removal: removalMode() },
            accessibility: usingSample ? true : await accessibilityTrusted(false),
          })
        }
        case 'GET /api/conversations': {
          const requested = url.searchParams.get('view')
          const view = requested === 'archived' || requested === 'deleted' ? requested : 'inbox'
          const source = url.searchParams.get('source')
          const listed = await conversations(view, source === 'imessage' || source === 'whatsapp' || source === 'slack' || source === 'discord' ? source : 'all')
          // The list shows two lines of preview and no archive hint (the
          // selected conversation's detail carries that): thousands of rows
          // otherwise ship megabytes nobody reads.
          return json(listed.map(c => ({ ...c, archiveDetail: undefined, preview: c.preview && c.preview.length > 160 ? `${c.preview.slice(0, 160)}…` : c.preview })))
        }
        case 'GET /api/conversation': {
          const key = keyFrom(url.searchParams)
          const summary = key ? await summaryFor(key) : null
          if (!summary)
            return problem('No such conversation', 404)
          const stored = store.conversation(summary.key)
          return json({
            ...summary,
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
          const transcript = await archiver.transcript(key, { before })
          const avatars = await avatarsFor(key)
          return json({ ...transcript, messages: transcript.messages.map(m => presentMessage(m, avatars)) })
        }
        case 'POST /api/archive': {
          const key = keyFrom(await body(req))
          if (!key)
            return problem('key is required')
          return json(await archiveConversation(key))
        }
        case 'POST /api/bulk/preview': {
          const data = await body(req)
          const days = Number(data.olderThanDays) || 365
          const source = data.source === 'imessage' || data.source === 'whatsapp' || data.source === 'slack' || data.source === 'discord' ? data.source : 'all'
          const candidates = await bulkCandidates(days, source)
          const byProvider: Record<string, number> = {}
          for (const c of candidates)
            byProvider[c.provider] = (byProvider[c.provider] ?? 0) + 1
          return json({ total: candidates.length, byProvider, running: bulkState() })
        }
        case 'POST /api/bulk/archive': {
          if (bulk && !bulk.finished)
            return problem('A bulk archive is already running', 409)
          const data = await body(req)
          const days = Number(data.olderThanDays) || 365
          const source = data.source === 'imessage' || data.source === 'whatsapp' || data.source === 'slack' || data.source === 'discord' ? data.source : 'all'
          const keys = (await bulkCandidates(days, source)).map(c => c.key)
          const job: BulkJob = { total: keys.length, done: 0, archived: 0, removed: 0, failed: 0, cancelled: false, finished: false, startedAt: Date.now() }
          bulk = job
          void runBulk(job, keys)
          return json({ job: bulkState() })
        }
        case 'POST /api/bulk/cancel': {
          if (bulk && !bulk.finished)
            bulk.cancelled = true
          return json({ job: bulkState() })
        }
        case 'GET /api/bulk': {
          return json({ job: bulkState() })
        }
        case 'POST /api/phone/pair': {
          const data = await body(req)
          const paired = phone.pair(typeof data.name === 'string' && data.name.trim() ? data.name.trim() : 'Phone')
          broadcast({ type: 'phones' })
          return json(paired)
        }
        case 'GET /api/phone/devices': {
          return json({ listening: phone.listening, devices: store.devices().map(d => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt })) })
        }
        case 'POST /api/phone/forget': {
          const data = await body(req)
          phone.forget(String(data.id ?? ''))
          broadcast({ type: 'phones' })
          return json({ ok: true })
        }
        case 'GET /api/rules': {
          return json(currentRules)
        }
        case 'POST /api/rules/for-conversation': {
          // "Always archive" from a conversation: its person when it is one
          // to one, the conversation itself when it is a group.
          const data = await body(req)
          const key = keyFrom(data)
          if (!key)
            return problem('key is required')
          const { provider } = splitKey(key)
          const live = (await sources.live()).find(e => e.key === key)
          const stored = store.conversation(key)
          const kind = live?.conversation.kind ?? stored?.kind
          const person = (live?.conversation.participants ?? stored?.participants ?? [])[0]
          const summary = await summaryFor(key)
          const rule = kind === 'direct' && person
            ? store.addRule({ provider, kind: 'person', value: ruleValue(provider, person.id), label: summary?.title ?? person.name ?? person.id })
            : store.addRule({ provider, kind: 'conversation', value: key, label: summary?.title ?? key })
          currentRules = store.rules()
          // Apply it now rather than on the next change.
          await announce(await syncArchive(true))
          return json({ rule, rules: currentRules })
        }
        case 'POST /api/rules/delete': {
          const data = await body(req)
          store.deleteRule(Number(data.id))
          currentRules = store.rules()
          broadcast({ type: 'changed', resurfaced: [], removed: [] })
          return json({ rules: currentRules })
        }
        case 'POST /api/unarchive': {
          const key = keyFrom(await body(req))
          if (!key)
            return problem('key is required')
          return json(await unarchiveConversation(key))
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
          const summary = key ? await summaryFor(key) : null
          if (!summary?.url)
            return problem('This app cannot open the conversation by link', 422)
          openUrl(summary.url)
          return json({ ok: true })
        }
        // One conversation, or the whole archive, written out as pages
        // anyone can read. The folder is revealed in the Finder rather than
        // handed back as a download: an export is a folder of files, and
        // AppKit's save panel takes one file at a time.
        case 'POST /api/export': {
          if (exporting)
            return problem('An export is already running', 409)
          const data = await body(req)
          const key = keyFrom(data)
          if (key && !store.conversation(key))
            return problem('Texts has kept no copy of this conversation yet', 422)
          const keys = key ? [key] : undefined
          if (!keys && store.conversations().length === 0)
            return problem('There is nothing in the archive to export yet', 422)
          exporting = true
          try {
            const result = await exportArchive({
              store,
              attachmentsDir: ATTACHMENTS_DIR,
              destination: exportFolder(EXPORTS_PARENT),
              keys,
            })
            if (data.reveal !== false)
              openUrl(result.folder)
            return json(result)
          }
          finally {
            exporting = false
          }
        }
        case 'GET /api/search': {
          const q = url.searchParams.get('q') ?? ''
          const hits = await Promise.all(store.search(q, 60).map(async hit => ({
            ...hit,
            provider: splitKey(hit.conversationKey).provider,
            title: (await summaryFor(hit.conversationKey))?.title ?? hit.conversationKey,
            senderName: hit.isFromMe ? 'You' : (hit.senderName ?? (hit.sender ? inbox.formatHandle(hit.sender) : null)),
          })))
          return json(hits)
        }
        case 'GET /api/avatar': {
          const provider = url.searchParams.get('provider') as Provider | null
          const ref = url.searchParams.get('ref')
          const driver = provider && ref ? sources.driver(provider) : undefined
          if (!provider || !ref || !LABELS[provider])
            return new Response('Not found', { status: 404 })
          return avatarResponse(provider, ref, driver)
        }

        case 'GET /api/attachment': {
          const guid = url.searchParams.get('guid')
          const response = guid ? await archiver.attachmentResponse(guid) : null
          if (!response || !response.ok)
            return new Response('Not found', { status: 404 })
          // iPhones send HEIC, which WebKit decodes and most other viewers do
          // not. Serve a cached JPEG rendering instead; the archived original
          // is never touched.
          const type = response.headers.get('content-type') ?? ''
          if (guid && /^image\/hei[cf]/.test(type)) {
            const preview = await heicPreview(guid, response)
            if (preview)
              return new Response(Bun.file(preview), { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400' } })
          }
          return new Response(response.body, {
            headers: { 'content-type': response.headers.get('content-type') ?? 'application/octet-stream', 'cache-control': 'private, max-age=3600' },
          })
        }
        case 'POST /api/settings': {
          const data = await body(req)
          if (data.resurface === 'inbox' || data.resurface === 'stay')
            store.setSetting('resurface', data.resurface)
          if (data.removal === 'auto' || data.removal === 'confirm' || data.removal === 'off') {
            store.setSetting('removal', data.removal)
            await sources.load()
          }
          // The Settings window and the main window both follow these.
          broadcast({ type: 'settings' })
          return json({ resurface: resurfaceMode(), removal: removalMode() })
        }
        case 'POST /api/sources/connect': {
          const data = await body(req)
          const provider = data.provider
          const secret = typeof data.token === 'string' ? data.token.trim() : ''
          if ((provider !== 'slack' && provider !== 'discord') || !secret)
            return problem('A provider and a token are required')
          if (provider === 'slack') {
            // One more workspace, or new tokens for one already signed in.
            // Socket Mode's app-level token brings messages as they are sent.
            const identity = await slackIdentity(secret)
            if ('error' in identity)
              return problem(identity.error)
            const appToken = typeof data.appToken === 'string' && data.appToken.trim() ? data.appToken.trim() : undefined
            const list = upsertWorkspace(await sources.slackWorkspaces(), { ...identity, token: secret, appToken })
            if (!(await writeSecret('slack-workspaces', JSON.stringify(list))))
              return problem('Texts could not keep the Slack token in the keychain.', 500)
            // The list now holds the workspace Attic used to keep on its own.
            await deleteSecret('slack')
            await deleteSecret('slack-app')
          }
          else {
            await writeSecret(provider, secret)
          }
          if (provider === 'discord') {
            await writeSecret('discord-account', data.account === 'bot' ? 'bot' : 'user')
            if (typeof data.userId === 'string' && data.userId.trim())
              await writeSecret('discord-user', data.userId.trim())
            else
              await deleteSecret('discord-user')
          }
          await sources.load()
          broadcast({ type: 'sources' })
          return json({ sources: sources.statesList() })
        }
        case 'GET /api/slack/workspaces': {
          // Names only: tokens never leave the keychain for the page.
          return json({ workspaces: (await sources.slackWorkspaces()).map(w => ({ teamId: w.teamId, team: w.team, live: !!w.appToken })) })
        }
        case 'GET /api/whatsapp': {
          return json(linkView())
        }
        case 'POST /api/whatsapp/link': {
          const link = sources.whatsappLink()
          if (!link)
            return problem('Sample data has no WhatsApp to link.')
          return json(linkView(await link.link()))
        }
        case 'POST /api/whatsapp/cancel': {
          sources.whatsappLink()?.cancelLink()
          return json(linkView())
        }
        case 'POST /api/sources/disconnect': {
          const data = await body(req)
          if (data.provider === 'whatsapp') {
            // Unlinks Attic in WhatsApp too; it leaves the phone's list of devices.
            await sources.whatsappLink()?.logout()
            await sources.load()
            broadcast({ type: 'sources' })
            return json({ sources: sources.statesList() })
          }
          if (data.provider !== 'slack' && data.provider !== 'discord')
            return problem('Only WhatsApp, Slack and Discord can be disconnected')
          if (data.provider === 'slack') {
            // One workspace when it is named, every one otherwise.
            const remaining = typeof data.teamId === 'string' ? (await sources.slackWorkspaces()).filter(w => w.teamId !== data.teamId) : []
            if (remaining.length > 0)
              await writeSecret('slack-workspaces', JSON.stringify(remaining))
            else
              await deleteSecret('slack-workspaces')
            await deleteSecret('slack')
            await deleteSecret('slack-app')
          }
          if (data.provider === 'discord') {
            await deleteSecret('discord')
            await deleteSecret('discord-user')
            await deleteSecret('discord-account')
          }
          await sources.load()
          broadcast({ type: 'sources' })
          return json({ sources: sources.statesList() })
        }
        case 'POST /api/send': {
          const data = await body(req)
          const key = keyFrom(data)
          if (!key)
            return problem('key is required')
          const { provider, id } = splitKey(key)
          const driver = sources.driver(provider)
          if (!driver?.send)
            return problem(`Texts cannot send to ${driver?.label ?? provider} yet.`)
          // Only files that came through /api/upload: never an arbitrary path.
          const files = (Array.isArray(data.files) ? data.files : [])
            .filter((f): f is { path: string, name?: string, mimeType?: string } => !!f && typeof (f as { path?: unknown }).path === 'string')
            .filter(f => normalize(f.path).startsWith(`${OUTGOING_DIR}${sep}`) && existsSync(f.path))
          const outcome = await driver.send(id, {
            text: typeof data.text === 'string' ? data.text : '',
            replyToId: typeof data.replyToId === 'string' ? data.replyToId : null,
            files,
          })
          // A reply settles the conversation: nothing new to announce in it.
          announced.set(key, Math.max(announced.get(key) ?? 0, outcome.sentAt))
          if (provider !== 'imessage') {
            sources.invalidate(provider)
            lastRemote = 0
          }
          lastStamp = ''
          return json(outcome)
        }
        case 'POST /api/react': {
          const data = await body(req)
          const key = keyFrom(data)
          if (!key || typeof data.messageId !== 'string' || typeof data.reaction !== 'string')
            return problem('key, messageId and reaction are required')
          return json(await reactTo(key, data.messageId, data.reaction, data.remove === true))
        }
        case 'POST /api/read': {
          const key = keyFrom(await body(req))
          if (!key)
            return problem('key is required')
          const { provider, id } = splitKey(key)
          const driver = sources.driver(provider)
          if (driver?.markRead) {
            await driver.markRead(id)
            sources.invalidate(provider)
          }
          return json({ ok: true })
        }
        case 'POST /api/upload': {
          // A file picked in the compose field, held until it is sent.
          const name = (req.headers.get('x-filename') ?? 'file').replace(/[/\\:]/g, '_').slice(0, 200) || 'file'
          const folder = join(OUTGOING_DIR, randomBytes(8).toString('hex'))
          mkdirSync(folder, { recursive: true })
          const path = join(folder, name)
          writeFileSync(path, new Uint8Array(await req.arrayBuffer()))
          return json({ path, name, mimeType: req.headers.get('content-type') || null })
        }
        case 'POST /api/client-error': {
          // The window's own errors, which WebKit keeps to itself in a build
          // without devtools: a page that stops responding says why here.
          const data = await body(req).catch(() => ({} as Record<string, unknown>))
          const text = `${String(data.message ?? 'unknown').slice(0, 500)}${data.stack ? `\n${String(data.stack).slice(0, 2000)}` : ''}`
          console.error(`[attic] window error (${String(data.source ?? 'page').slice(0, 40)}): ${text}`)
          return json({ ok: true })
        }
        case 'POST /api/privacy': {
          openUrl('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles')
          return json({ ok: true })
        }
        case 'POST /api/accessibility': {
          return json({ trusted: await accessibilityTrusted(true) })
        }
        case 'GET /api/events': {
          let controller: ReadableStreamDefaultController<Uint8Array> | null = null
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              controller = c
              listeners.add(c)
              c.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'hello' })}\n\n`))
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
      return problem(message, 500)
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

  noticeMessages()
  const noticeTimer = setInterval(noticeMessages, IMESSAGE_NOTICE_MS)
  void tick()
  if (!usingSample)
    void updates.run('check')
  return {
    port,
    server,
    stop() {
      clearInterval(timer)
      clearInterval(noticeTimer)
      stopListening()
      sources.close()
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
