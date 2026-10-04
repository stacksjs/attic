import type { Pairing } from './sealed'
import { decodePairing, fromBase64Url, seal, unseal } from './sealed'

/**
 * The phone app's own archive: a copy of everything Attic on the Mac keeps,
 * stored on the phone so it reads offline, and brought up to date whenever
 * the paired Mac is reachable on the same network.
 *
 * Storage is Craft's native SQLite (`craft.db`) in the app, and the browser's
 * localStorage when the page runs outside it (development). The pairing -
 * the Mac's address and the key - lives in Craft's secure storage.
 */

export interface PhoneConversation {
  key: string
  provider: string
  kind: string
  title: string
  subtitle: string
  initials: string
  avatar: string | null
  lastMessageAt: number | null
  preview: string | null
  previewFromMe: boolean
  state: string
  savedMessages: number
  inApp: boolean
}

export interface PhoneMessage {
  guid: string
  conversationKey: string
  kind: 'message' | 'reaction' | 'event'
  text: string | null
  isFromMe: boolean
  sentAt: number
  senderName: string | null
  targetGuid: string | null
  reaction: string | null
  reactionRemoved: boolean
  replyToGuid: string | null
  unsent: boolean
  attachments: Array<{ guid: string, name: string, mimeType: string | null, bytes: number, available: boolean }>
  rowid: number
}

interface Db {
  execute: (sql: string, params?: unknown[]) => Promise<unknown>
  query: (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>
}

interface CraftBridge {
  db?: Db
  secureStorage?: { get: (key: string) => Promise<string | null>, set: (key: string, value: string) => Promise<void>, delete: (key: string) => Promise<void> }
  scanQRCode?: () => Promise<string | { value?: string, text?: string } | null>
  platform?: string
}

const PAIRING_KEY = 'attic-pairing'
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS conversations (key TEXT PRIMARY KEY, last INTEGER, json TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS messages (guid TEXT PRIMARY KEY, conversation_key TEXT NOT NULL, sent_at INTEGER NOT NULL, json TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (conversation_key, sent_at)',
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)',
  'CREATE TABLE IF NOT EXISTS avatars (url TEXT PRIMARY KEY, data TEXT NOT NULL)',
]

function bridge(): CraftBridge | null {
  return (globalThis as { craft?: CraftBridge }).craft ?? null
}

/** Whether this is the phone app (Craft's bridge is present), not a browser tab. */
export function inPhoneApp(): boolean {
  const craft = bridge()
  return !!craft && (craft.platform === 'ios' || craft.platform === 'android')
}

/**
 * localStorage standing in for SQLite outside the app: tables as JSON maps,
 * answering only the statements this module issues.
 */
function browserDb(): Db {
  const read = (table: string): Record<string, Record<string, unknown>> => {
    try {
      return JSON.parse(localStorage.getItem(`attic:${table}`) ?? '{}')
    }
    catch {
      return {}
    }
  }
  const write = (table: string, rows: Record<string, Record<string, unknown>>): void => {
    try {
      localStorage.setItem(`attic:${table}`, JSON.stringify(rows))
    }
    catch {}
  }
  return {
    async execute(sql, params = []) {
      const insert = sql.match(/^INSERT OR REPLACE INTO (\w+) \(([^)]+)\)/)
      if (insert) {
        const [, table, columns] = insert
        const names = columns!.split(',').map(c => c.trim())
        const row = Object.fromEntries(names.map((n, i) => [n, params[i]]))
        const rows = read(table!)
        rows[String(params[0])] = row
        write(table!, rows)
      }
      const remove = sql.match(/^DELETE FROM (\w+)(?: WHERE (\w+) = \?)?/)
      if (remove) {
        const [, table, column] = remove
        const rows = read(table!)
        for (const id of Object.keys(rows)) {
          if (!column || rows[id]![column] === params[0])
            delete rows[id]
        }
        write(table!, rows)
      }
      return {}
    },
    async query(sql, params = []) {
      const table = sql.match(/FROM (\w+)/)?.[1] ?? ''
      let rows = Object.values(read(table))
      const where = sql.match(/WHERE (\w+) = \?/)
      if (where)
        rows = rows.filter(r => r[where[1]!] === params[0])
      const order = sql.match(/ORDER BY (\w+)( DESC)?/)
      if (order)
        rows.sort((a, b) => (Number(a[order[1]!] ?? 0) - Number(b[order[1]!] ?? 0)) * (order[2] ? -1 : 1))
      return rows
    },
  }
}

let opened: Promise<Db> | null = null

async function db(): Promise<Db> {
  opened ??= (async () => {
    const native = bridge()?.db
    const store = native ?? browserDb()
    if (native) {
      for (const statement of SCHEMA)
        await native.execute(statement)
    }
    return store
  })()
  return opened
}

export async function loadPairing(): Promise<Pairing | null> {
  const secure = bridge()?.secureStorage
  const raw = secure ? await secure.get(PAIRING_KEY).catch(() => null) : localStorage.getItem(PAIRING_KEY)
  return raw ? decodePairing(raw) : null
}

/** Keep a scanned or pasted pairing code; null when it is not one of Attic's. */
export async function savePairing(code: string): Promise<Pairing | null> {
  const pairing = decodePairing(code)
  if (!pairing)
    return null
  const secure = bridge()?.secureStorage
  if (secure)
    await secure.set(PAIRING_KEY, code.trim())
  else
    localStorage.setItem(PAIRING_KEY, code.trim())
  return pairing
}

/** Unpair: the phone forgets the Mac and its copy of the archive. */
export async function forgetPairing(): Promise<void> {
  const secure = bridge()?.secureStorage
  if (secure)
    await secure.delete(PAIRING_KEY).catch(() => undefined)
  else
    localStorage.removeItem(PAIRING_KEY)
  const store = await db()
  for (const table of ['conversations', 'messages', 'meta', 'avatars'])
    await store.execute(`DELETE FROM ${table}`)
}

/** The phone's camera reading the code on the Mac's screen; null when there is no scanner. */
export async function scanPairingCode(): Promise<string | null> {
  const scan = bridge()?.scanQRCode
  if (!scan)
    return null
  const result = await scan()
  return typeof result === 'string' ? result : (result?.value ?? result?.text ?? null)
}

/** One sealed request to the paired Mac. Throws when it cannot be reached or refuses. */
export async function askMac<T = unknown>(pairing: Pairing, op: string, args: Record<string, unknown> = {}, timeoutMs = 8000): Promise<T> {
  const key = fromBase64Url(pairing.key)
  const request = { op, t: Date.now(), r: Math.random().toString(36).slice(2) + Date.now().toString(36), ...args }
  const sealed = await seal(key, pairing.device, request)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://${pairing.host}:${pairing.port}/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ d: pairing.device, ...sealed }),
      signal: controller.signal,
    })
    if (response.status === 403)
      throw new Error('The Mac no longer knows this phone. Pair it again.')
    if (!response.ok)
      throw new Error(`The Mac answered ${response.status}`)
    const reply = await unseal<{ ok: boolean, result?: T, error?: string }>(key, pairing.device, await response.json())
    if (!reply.ok)
      throw new Error(reply.error ?? 'The Mac could not do that')
    return reply.result as T
  }
  finally {
    clearTimeout(timer)
  }
}

async function meta(k: string): Promise<string | null> {
  const rows = await (await db()).query('SELECT v FROM meta WHERE k = ?', [k])
  return (rows[0]?.v as string | undefined) ?? null
}

async function setMeta(k: string, v: string): Promise<void> {
  await (await db()).execute('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', [k, v])
}

/**
 * Bring the phone's archive up to date: every conversation the Mac keeps,
 * and every message after the phone's cursor, page by page. Conversations
 * the Mac no longer keeps are dropped here too.
 */
export async function syncArchive(pairing: Pairing): Promise<{ conversations: number, messages: number }> {
  const store = await db()
  let since = Number(await meta('cursor') ?? 0)
  let fetched = 0
  let conversations: PhoneConversation[] = []
  for (let page = 0; page < 200; page++) {
    const result = await askMac<{ conversations: PhoneConversation[], messages: PhoneMessage[], cursor: number, more: boolean }>(pairing, 'pull', { since }, 20_000)
    conversations = result.conversations
    for (const message of result.messages)
      await store.execute('INSERT OR REPLACE INTO messages (guid, conversation_key, sent_at, json) VALUES (?, ?, ?, ?)', [message.guid, message.conversationKey, message.sentAt, JSON.stringify(message)])
    fetched += result.messages.length
    since = result.cursor
    await setMeta('cursor', String(since))
    if (!result.more)
      break
  }
  const keep = new Set(conversations.map(c => c.key))
  for (const row of await store.query('SELECT key FROM conversations'))
    if (!keep.has(String(row.key))) {
      await store.execute('DELETE FROM conversations WHERE key = ?', [row.key])
      await store.execute('DELETE FROM messages WHERE conversation_key = ?', [row.key])
    }
  for (const c of conversations)
    await store.execute('INSERT OR REPLACE INTO conversations (key, last, json) VALUES (?, ?, ?)', [c.key, c.lastMessageAt ?? 0, JSON.stringify(c)])
  await setMeta('syncedAt', String(Date.now()))
  return { conversations: conversations.length, messages: fetched }
}

export async function lastSynced(): Promise<number | null> {
  const value = await meta('syncedAt')
  return value ? Number(value) : null
}

export async function localConversations(): Promise<PhoneConversation[]> {
  const rows = await (await db()).query('SELECT json FROM conversations ORDER BY last DESC')
  return rows.map(r => JSON.parse(String(r.json)) as PhoneConversation)
}

export async function localMessages(key: string): Promise<PhoneMessage[]> {
  const rows = await (await db()).query('SELECT json FROM messages WHERE conversation_key = ? ORDER BY sent_at', [key])
  return rows.map(r => JSON.parse(String(r.json)) as PhoneMessage).sort((a, b) => a.sentAt - b.sentAt)
}

/** A conversation's picture as a data URL, fetched from the Mac once and kept. */
export async function avatarFor(pairing: Pairing | null, url: string | null): Promise<string | null> {
  if (!url)
    return null
  const store = await db()
  const cached = await store.query('SELECT data FROM avatars WHERE url = ?', [url])
  if (cached[0])
    return String(cached[0].data)
  if (!pairing)
    return null
  try {
    const image = await askMac<{ type: string, data: string } | null>(pairing, 'avatar', { url })
    if (!image)
      return null
    const data = `data:${image.type};base64,${image.data}`
    await store.execute('INSERT OR REPLACE INTO avatars (url, data) VALUES (?, ?)', [url, data])
    return data
  }
  catch {
    return null
  }
}
