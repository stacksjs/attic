import { inbox } from '@stacksjs/chat'
import type { TranscriptMessage } from './archiver'
import type { ArchiveStore, Person, Provider, StoredConversation } from './store'
import { constants, existsSync } from 'node:fs'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { foldTranscript } from './archiver'

/**
 * The archive, written out as files anyone can read: one HTML page per
 * conversation, with its attachments beside it.
 *
 * An archive nobody can get out of is a trap, and Attic's own SQLite file is
 * not something a person reads. The page it writes needs no app, no server
 * and no network: plain HTML, styles inside it, pictures and files as
 * relative links into an `Attachments` folder, and dark mode through
 * `prefers-color-scheme`. It opens in any browser, prints to PDF, and keeps
 * working after Attic is deleted.
 *
 * Export reads only Attic's own copy. What is still in Messages or WhatsApp
 * is the app's to export; what Attic kept is what Attic can promise.
 */

const SOURCE_NAMES: Record<Provider, string> = { imessage: 'Messages', whatsapp: 'WhatsApp', slack: 'Slack', discord: 'Discord' }

export interface ExportOptions {
  store: ArchiveStore
  /** Where Attic keeps attachment copies (`ATTACHMENTS_DIR`). */
  attachmentsDir: string
  /** The folder to write into. Created when missing. */
  destination: string
  /** Conversation keys to write; every conversation Attic kept when omitted. */
  keys?: string[]
  /** Stamped into each page, and used for the folder's own name upstream. */
  now?: number
}

export interface ExportedConversation {
  key: string
  title: string
  /** The page's path, relative to the export folder. */
  file: string
  messages: number
  attachments: number
  /** Attachments the original app had already thrown away. */
  missingAttachments: number
}

export interface ExportResult {
  folder: string
  /** The contents page, written when more than one conversation is exported. */
  index: string | null
  conversations: ExportedConversation[]
  messages: number
  attachments: number
  missingAttachments: number
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'))
}

function handleLabel(id: string): string {
  return inbox.formatHandle(id.includes('@s.whatsapp.net') ? inbox.formatJid(id) : id)
}

function personLabel(person: Person): string {
  return person.name ?? handleLabel(person.id)
}

/** The title the window shows, from the stored copy alone. */
export function conversationTitle(conversation: StoredConversation): string {
  if (conversation.title)
    return conversation.title
  const people = conversation.participants
  if (conversation.kind === 'direct' && people[0])
    return personLabel(people[0])
  if (people.length === 0)
    return 'Conversation'
  if (people.length <= 2)
    return people.map(personLabel).join(' & ')
  return `${people.slice(0, 2).map(personLabel).join(', ')} & ${people.length - 2} other${people.length - 2 === 1 ? '' : 's'}`
}

/**
 * A file or folder name a person can read and every filesystem accepts.
 * Colons and slashes are the ones that matter on macOS: the Finder shows a
 * colon as a slash and a slash is a path separator.
 */
export function safeFileName(name: string, fallback = 'Conversation'): string {
  const cleaned = name
    // Separators go before anything else: a conversation called "Mum/Dad"
    // keeps both names rather than losing everything up to the slash.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    // A leading dot hides the file, and a name of dots walks out of the folder.
    .replace(/^[.\s]+/, '')
    .trim()
  return basename(cleaned.length > 0 ? cleaned : fallback).slice(0, 80).trim() || fallback
}

/** `Sam Rivera`, `Sam Rivera 2`, ...: two people can share a name. */
function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name
  for (let n = 2; taken.has(candidate.toLowerCase()); n++)
    candidate = `${name} ${n}`
  taken.add(candidate.toLowerCase())
  return candidate
}

function dayLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
}

function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function dateLabel(timestamp: number | null): string {
  return timestamp ? new Date(timestamp).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' }) : 'unknown'
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} bytes`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/** Mail and the Finder both show plain text; a page has to be told about newlines. */
function paragraphs(text: string): string {
  return escapeHtml(text).replace(/\r\n|\r|\n/g, '<br>')
}

const STYLES = `
  :root { color-scheme: light dark; --page: #f5f5f7; --card: #ffffff; --ink: #1d1d1f; --muted: #6e6e73; --line: #dededf; --mine: #0b84ff; --mine-ink: #ffffff; --theirs: #e9e9eb; }
  @media (prefers-color-scheme: dark) {
    :root { --page: #161617; --card: #1e1e20; --ink: #f4f4f6; --muted: #9a9aa0; --line: #343436; --mine: #0a7cf0; --mine-ink: #ffffff; --theirs: #2c2c2e; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 20px 64px; background: var(--page); color: var(--ink);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width: 740px; margin: 0 auto; }
  header { margin-bottom: 28px; padding-bottom: 20px; border-bottom: 1px solid var(--line); }
  h1 { margin: 0 0 6px; font-size: 26px; letter-spacing: -0.4px; }
  .meta { color: var(--muted); font-size: 13px; }
  .meta span + span::before { content: " · "; }
  .day { margin: 28px 0 14px; text-align: center; color: var(--muted); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.6px; }
  .event { margin: 14px 0; text-align: center; color: var(--muted); font-size: 12.5px; }
  .row { display: flex; flex-direction: column; align-items: flex-start; margin: 2px 0 10px; }
  .row.mine { align-items: flex-end; }
  .who { margin: 0 8px 3px; color: var(--muted); font-size: 11.5px; }
  .bubble { max-width: 76%; padding: 9px 13px; border-radius: 18px; background: var(--theirs); overflow-wrap: anywhere; }
  .row.mine .bubble { background: var(--mine); color: var(--mine-ink); }
  .bubble.media, .row.mine .bubble.media { padding: 0; background: none; }
  .bubble.media .files { margin-top: 0; }
  .quote { margin: -2px 0 7px; padding-left: 9px; border-left: 2px solid currentColor; opacity: 0.6; font-size: 13px; }
  .stamp { margin: 4px 9px 0; color: var(--muted); font-size: 11px; }
  .tags { margin: 3px 8px 0; font-size: 13px; }
  .tag { display: inline-block; padding: 1px 7px; margin-right: 4px; border: 1px solid var(--line); border-radius: 11px; background: var(--card); }
  .files { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 7px; }
  .files img, .files video { max-width: 260px; max-height: 320px; border-radius: 12px; display: block; }
  .file { display: inline-block; padding: 7px 11px; border: 1px solid var(--line); border-radius: 12px; background: var(--card); color: inherit; font-size: 13px; text-decoration: none; }
  .gone { color: var(--muted); font-size: 12.5px; font-style: italic; }
  .edited { opacity: 0.7; font-size: 11.5px; }
  .unsent { font-style: italic; opacity: 0.75; }
  footer { margin-top: 40px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
  ul.contents { list-style: none; margin: 0; padding: 0; }
  ul.contents li { padding: 11px 2px; border-bottom: 1px solid var(--line); }
  ul.contents a { color: inherit; font-weight: 500; text-decoration: none; }
  ul.contents a:hover { text-decoration: underline; }
  @media print { body { background: #fff; padding: 0; } .bubble { border: 1px solid var(--line); } }
`

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`
}

function attachmentHtml(message: TranscriptMessage, folder: string): string {
  if (message.attachments.length === 0)
    return ''
  const items = message.attachments.map((a) => {
    const name = escapeHtml(a.name)
    if (a.status !== 'copied' || !a.storedPath)
      return `<span class="gone">${name} was no longer on this Mac when Attic copied the conversation.</span>`
    const href = `${folder}/${encodeURIComponent(basename(a.storedPath))}`
    if (a.mimeType?.startsWith('image/'))
      return `<a href="${href}"><img src="${href}" alt="${name}" loading="lazy"></a>`
    if (a.mimeType?.startsWith('video/'))
      return `<video src="${href}" controls preload="metadata"></video>`
    if (a.mimeType?.startsWith('audio/'))
      return `<audio src="${href}" controls preload="metadata"></audio>`
    return `<a class="file" href="${href}">${name}${a.bytes ? ` (${formatBytes(a.bytes)})` : ''}</a>`
  })
  return `<div class="files">${items.join('')}</div>`
}

/**
 * One conversation as a page. Pure, so a test reads the markup rather than
 * the filesystem: the caller copies the attachments `folder` holds.
 */
export function renderConversation(options: {
  conversation: StoredConversation
  messages: TranscriptMessage[]
  /** Where this conversation's attachments sit, relative to the page. */
  folder: string
  now?: number
  /** Links back to the contents page of a full export. */
  index?: string | null
}): string {
  const { conversation, messages, folder } = options
  const title = conversationTitle(conversation)
  const people = conversation.participants.map(personLabel)
  const group = conversation.kind !== 'direct'
  const first = messages[0]?.sentAt ?? conversation.lastMessageAt
  const last = messages[messages.length - 1]?.sentAt ?? conversation.lastMessageAt
  const quoted = new Map(messages.map(m => [m.guid, m]))

  const body: string[] = []
  let day = ''
  for (const message of messages) {
    const stamp = dayLabel(message.sentAt)
    if (stamp !== day) {
      body.push(`<div class="day">${escapeHtml(stamp)}</div>`)
      day = stamp
    }
    const text = message.text?.replace(/￼/g, '').trim() ?? ''
    if (message.kind === 'event') {
      body.push(`<div class="event">${paragraphs(text)}</div>`)
      continue
    }
    const sender = message.isFromMe ? 'You' : (message.senderName ?? (message.sender ? handleLabel(message.sender) : 'Unknown'))
    const parts: string[] = []
    const replied = message.replyToGuid ? quoted.get(message.replyToGuid) : undefined
    if (replied?.text)
      parts.push(`<div class="quote">${paragraphs(replied.text.slice(0, 180))}</div>`)
    if (text)
      parts.push(`<div class="${message.unsent ? 'unsent' : 'text'}">${paragraphs(text)}</div>`)
    if (message.unsent && !text)
      parts.push(`<div class="unsent">This message was unsent.</div>`)
    parts.push(attachmentHtml(message, folder))
    if (message.editedAt)
      parts.push(`<div class="edited">Edited</div>`)
    const tags = message.reactions.length
      ? `<div class="tags">${message.reactions.map(r => `<span class="tag" title="${escapeHtml(r.fromMe ? 'You' : r.senderName ?? '')}">${escapeHtml(r.reaction)}</span>`).join('')}</div>`
      : ''
    // A bubble around a photo and nothing else is a frame around a frame.
    const mediaOnly = !text && !replied && !message.editedAt && message.attachments.some(a => a.status === 'copied')
    // In a group the sender's name is already above the bubble; repeating it
    // under every line is noise, so the stamp there is the time alone.
    const byline = group && !message.isFromMe ? timeLabel(message.sentAt) : `${sender} · ${timeLabel(message.sentAt)}`
    body.push(`<div class="row ${message.isFromMe ? 'mine' : 'theirs'}">`
      + `${group && !message.isFromMe ? `<div class="who">${escapeHtml(sender)}</div>` : ''}`
      + `<div class="bubble${mediaOnly ? ' media' : ''}">${parts.filter(Boolean).join('')}</div>`
      + tags
      + `<div class="stamp">${escapeHtml(byline)}</div>`
      + `</div>`)
  }

  const counted = messages.filter(m => m.kind !== 'event').length
  const meta = [
    SOURCE_NAMES[conversation.provider],
    conversation.workspace,
    group && people.length ? `with ${people.join(', ')}` : null,
    `${counted} message${counted === 1 ? '' : 's'}`,
    counted ? `${dateLabel(first)} to ${dateLabel(last)}` : null,
  ].filter((value): value is string => !!value).map(value => `<span>${escapeHtml(value)}</span>`).join('')

  const header = `<header>`
    + `${options.index ? `<div class="meta"><a href="${options.index}">All conversations</a></div>` : ''}`
    + `<h1>${escapeHtml(title)}</h1><div class="meta">${meta}</div></header>`
  const empty = `<div class="event">Attic kept no messages for this conversation.</div>`
  const footer = `<footer>Exported from Attic on ${escapeHtml(dateLabel(options.now ?? Date.now()))}. `
    + `This page and the files beside it need no app and no network.</footer>`
  return page(title, header + (body.length ? body.join('\n') : empty) + footer)
}

/** The contents page of a full export. */
export function renderIndex(entries: ExportedConversation[], now = Date.now()): string {
  const list = entries.map(entry => `<li><a href="${encodeURI(entry.file)}">${escapeHtml(entry.title)}</a>`
    + `<div class="meta">${entry.messages} message${entry.messages === 1 ? '' : 's'}`
    + `${entry.attachments ? ` · ${entry.attachments} attachment${entry.attachments === 1 ? '' : 's'}` : ''}</div></li>`).join('\n')
  const total = entries.reduce((sum, entry) => sum + entry.messages, 0)
  const header = `<header><h1>Attic export</h1><div class="meta">`
    + `<span>${entries.length} conversation${entries.length === 1 ? '' : 's'}</span><span>${total} message${total === 1 ? '' : 's'}</span>`
    + `<span>${escapeHtml(dateLabel(now))}</span></div></header>`
  return page('Attic export', `${header}<ul class="contents">${list}</ul>`
    + `<footer>Every page here reads on its own, with its attachments in the folder beside it.</footer>`)
}

/**
 * Write the conversations out. Attachments are cloned rather than read into
 * memory, so a photo-heavy decade of messages costs no more than the disk it
 * already uses (on APFS a clone shares its blocks until one side changes).
 */
export async function exportArchive(options: ExportOptions): Promise<ExportResult> {
  const now = options.now ?? Date.now()
  const stored = options.store.conversations()
  const wanted = options.keys
    ? options.keys.map(key => stored.find(c => c.key === key)).filter((c): c is StoredConversation => !!c)
    : stored
  await mkdir(options.destination, { recursive: true })

  const taken = new Set<string>()
  const entries: ExportedConversation[] = []
  let attachments = 0
  let missing = 0
  let messages = 0

  for (const conversation of wanted) {
    const title = conversationTitle(conversation)
    const name = uniqueName(safeFileName(title), taken)
    const folder = join('Attachments', name)
    const rows = foldTranscript(options.store.messages(conversation.key).map((message) => {
      const { conversationKey: _, cursor: __, ...rest } = message
      return { ...rest, inApp: conversation.removedAt === null, reactions: [] }
    }))

    let copied = 0
    let gone = 0
    for (const message of rows) {
      for (const attachment of message.attachments) {
        if (attachment.status !== 'copied' || !attachment.storedPath) {
          gone++
          continue
        }
        const source = join(options.attachmentsDir, attachment.storedPath)
        if (!existsSync(source)) {
          gone++
          continue
        }
        // Keep the name the sender gave it, prefixed so that three photos
        // called IMG_0001.heic stay three files. The rows are this call's
        // own copies, so pointing them at the exported file is local.
        const base = safeFileName(basename(attachment.storedPath), 'attachment')
        const unique = `${attachment.guid.replace(/[^\w-]/g, '_').slice(0, 24)}-${base}`
        await mkdir(join(options.destination, folder), { recursive: true })
        try {
          await copyFile(source, join(options.destination, folder, unique), constants.COPYFILE_FICLONE)
          attachment.storedPath = unique
          copied++
        }
        catch {
          attachment.status = 'missing'
          gone++
        }
      }
    }

    const file = `${name}.html`
    const counted = rows.filter(m => m.kind !== 'event').length
    const entry: ExportedConversation = { key: conversation.key, title, file, messages: counted, attachments: copied, missingAttachments: gone }
    await writeFile(join(options.destination, file), renderConversation({
      conversation,
      messages: rows,
      folder: encodeURI(folder.replaceAll('\\', '/')),
      now,
      index: wanted.length > 1 ? 'index.html' : null,
    }))
    entries.push(entry)
    attachments += copied
    missing += gone
    messages += counted
  }

  const index = entries.length > 1 ? 'index.html' : null
  if (index)
    await writeFile(join(options.destination, index), renderIndex(entries, now))

  return { folder: options.destination, index, conversations: entries, messages, attachments, missingAttachments: missing }
}

/**
 * Where one export goes: `Attic Export 2026-11-06` inside `parent`, with a
 * number added when that folder is already there, so a second export of the
 * day never writes over the first.
 */
export function exportFolder(parent: string, now = Date.now(), exists: (path: string) => boolean = existsSync): string {
  const date = new Date(now)
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const base = `Attic Export ${stamp}`
  let candidate = base
  for (let n = 2; exists(join(parent, candidate)); n++)
    candidate = `${base} ${n}`
  return join(parent, candidate)
}
