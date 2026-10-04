import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Archiver } from '../../../app/Attic/archiver'
import { initialsOf } from '../../../app/Attic/contacts'
import { conversationKey, groupChats, messagesUrl } from '../../../app/Attic/conversations'
import { MessagesDb } from '../../../app/Attic/messages-db'
import { ArchiveStore, ftsQuery } from '../../../app/Attic/store'
import { ALICE, BOB, CAROL, FakeChatDb } from '../../../app/Attic/sample-db'

let chat: FakeChatDb
let store: ArchiveStore
let archiver: Archiver
let attachmentsDir: string

beforeEach(() => {
  chat = new FakeChatDb()
  const dir = mkdtempSync(join(tmpdir(), 'attic-store-'))
  attachmentsDir = join(dir, 'Attachments')
  store = new ArchiveStore(join(dir, 'attic.sqlite'))
  archiver = new Archiver({ store, openMessages: () => new MessagesDb(chat.path), attachmentsDir })
})

afterEach(() => {
  store.close()
  chat.close()
})

describe('conversations', () => {
  it('merges the per-service chat rows Messages shows as one conversation', () => {
    const imessage = chat.direct(ALICE, 'iMessage')
    const sms = chat.direct(ALICE, 'SMS')
    chat.add(imessage, { text: 'over iMessage' })
    chat.add(sms, { text: 'over SMS', read: false })

    const live = archiver.live()
    expect(live).toHaveLength(1)
    expect(live[0]!.key).toBe(`direct:${ALICE}`)
    expect(live[0]!.chatGuids).toHaveLength(2)
    expect(live[0]!.messageCount).toBe(2)
    expect(live[0]!.unreadCount).toBe(1)
    // Text comes out of attributedBody, since `text` is NULL as on modern macOS.
    expect(live[0]!.lastMessageText).toBe('over SMS')
    expect(live[0]!.services.sort()).toEqual(['SMS', 'iMessage'])
  })

  it('keys a group on its group id, which survives the chat row being replaced', () => {
    const group = chat.group('chat111', [ALICE, BOB], { name: 'Climbing', groupId: 'G-1' })
    chat.add(group, { text: 'saturday?', sender: ALICE })
    const [live] = archiver.live()
    expect(live!.key).toBe('group:G-1')
    expect(live!.displayName).toBe('Climbing')
    expect(live!.participants.sort()).toEqual([ALICE, BOB].sort())
    expect(conversationKey({ style: 43, identifier: 'chat222', groupId: 'G-1', guid: 'x' })).toBe('group:G-1')
  })

  it('builds the URLs Messages opens a conversation from', () => {
    expect(messagesUrl({ kind: 'group', groupId: 'G 1', participants: [] })).toBe('sms://open?groupid=G%201')
    expect(messagesUrl({ kind: 'direct', groupId: null, participants: [ALICE] })).toBe(`sms:${ALICE}`)
    expect(messagesUrl({ kind: 'direct', groupId: null, participants: ['22395'] })).toBeNull()
  })

  it('leaves out conversations with no messages from the grouping order', () => {
    chat.direct(CAROL)
    const alice = chat.direct(ALICE)
    chat.add(alice, { text: 'hi' })
    const live = groupChats(new MessagesDb(chat.path).chats())
    expect(live.map(c => c.key)).toEqual([`direct:${ALICE}`, `direct:${CAROL}`])
    expect(live[1]!.messageCount).toBe(0)
  })
})

describe('archiving', () => {
  it('copies every message, reaction and attachment, verifies, then archives', () => {
    const alice = chat.direct(ALICE)
    const first = chat.add(alice, { text: 'look at this', attachment: { name: 'IMG_0001.HEIC', mime: 'image/heic' } })
    chat.add(alice, { text: 'Loved “look at this”', reaction: { type: 2000, target: first }, fromMe: true })
    chat.add(alice, { text: 'never downloaded', attachment: { name: 'old.mov', mime: 'video/quicktime', bytes: null } })

    const result = archiver.archive(`direct:${ALICE}`)
    expect(result.verified).toBe(true)
    expect(result.messages).toBe(2)
    expect(result.attachmentsCopied).toBe(1)
    expect(result.attachmentsMissing).toBe(1)

    const stored = store.conversation(`direct:${ALICE}`)!
    expect(stored.state).toBe('archived')
    expect(stored.archivedAt).not.toBeNull()

    const copy = archiver.attachmentFile('ATT-1')!
    expect(copy.path.startsWith(attachmentsDir)).toBe(true)
    expect(readFileSync(copy.path, 'utf8')).toBe('bytes of IMG_0001.HEIC')
  })

  it('keeps the whole history readable after Messages deletes it for good', () => {
    const alice = chat.direct(ALICE)
    const first = chat.add(alice, { text: 'first', attachment: { name: 'a.jpg', mime: 'image/jpeg' } })
    chat.add(alice, { text: '👍', reaction: { type: 2001, target: first }, fromMe: true })
    chat.add(alice, { text: 'second', fromMe: true })
    archiver.archive(`direct:${ALICE}`)

    const original = chat.attachmentPath('ATT-1')!
    chat.deleteChat(alice)
    const report = archiver.sync()
    expect(report.removed).toEqual([`direct:${ALICE}`])
    expect(store.conversation(`direct:${ALICE}`)!.removedAt).not.toBeNull()

    chat.purge(alice)
    const transcript = archiver.transcript(`direct:${ALICE}`)
    expect(transcript.messages.map(m => m.text)).toEqual(['first', 'second'])
    expect(transcript.messages.every(m => !m.inMessages)).toBe(true)
    expect(transcript.messages[0]!.reactions).toEqual([{ type: 2001, fromMe: true, sender: null }])
    // The clone outlives Messages' file.
    expect(existsSync(original)).toBe(true)
    expect(archiver.attachmentFile('ATT-1')!.path.startsWith(attachmentsDir)).toBe(true)
  })

  it('brings an archived conversation back when someone writes again, history attached', () => {
    const alice = chat.direct(ALICE)
    chat.add(alice, { text: 'old news' })
    archiver.archive(`direct:${ALICE}`)
    chat.deleteChat(alice)
    chat.purge(alice)
    archiver.sync()

    // Messages starts a new chat row for the same person.
    const again = chat.direct(ALICE, 'any')
    chat.add(again, { text: 'are you around?' })
    const report = archiver.sync()
    expect(report.resurfaced).toEqual([`direct:${ALICE}`])
    expect(report.returned).toEqual([`direct:${ALICE}`])

    const stored = store.conversation(`direct:${ALICE}`)!
    expect(stored.state).toBe('unarchived')
    expect(stored.resurfacedAt).not.toBeNull()
    expect(stored.removedAt).toBeNull()

    const transcript = archiver.transcript(`direct:${ALICE}`)
    expect(transcript.messages.map(m => [m.text, m.inMessages])).toEqual([['old news', false], ['are you around?', true]])
  })

  it('keeps it archived in "stay" mode, but still copies what was said', () => {
    const alice = chat.direct(ALICE)
    chat.add(alice, { text: 'one' })
    archiver.archive(`direct:${ALICE}`)
    chat.add(alice, { text: 'two' })
    const report = archiver.sync('stay')
    expect(report.resurfaced).toEqual([])
    expect(report.copiedMessages).toBe(1)
    expect(store.conversation(`direct:${ALICE}`)!.state).toBe('archived')
    expect(store.messageCount(`direct:${ALICE}`)).toBe(2)
  })

  it('does not resurface for a reaction alone', () => {
    const alice = chat.direct(ALICE)
    const first = chat.add(alice, { text: 'one' })
    archiver.archive(`direct:${ALICE}`)
    chat.add(alice, { text: 'Liked “one”', reaction: { type: 2001, target: first } })
    expect(archiver.sync().resurfaced).toEqual([])
    expect(store.conversation(`direct:${ALICE}`)!.state).toBe('archived')
  })

  it('folds a removed reaction away', () => {
    const alice = chat.direct(ALICE)
    const first = chat.add(alice, { text: 'one' })
    chat.add(alice, { text: 'Laughed at “one”', reaction: { type: 2003, target: first } })
    chat.add(alice, { text: 'Removed a laugh', reaction: { type: 3003, target: first } })
    const transcript = archiver.transcript(`direct:${ALICE}`)
    expect(transcript.messages).toHaveLength(1)
    expect(transcript.messages[0]!.reactions).toEqual([])
  })

  it('unarchives and forgets on request', () => {
    const alice = chat.direct(ALICE)
    chat.add(alice, { text: 'hello', attachment: { name: 'b.png', mime: 'image/png' } })
    archiver.archive(`direct:${ALICE}`)
    archiver.unarchive(`direct:${ALICE}`)
    expect(store.conversation(`direct:${ALICE}`)!.state).toBe('unarchived')

    const copy = archiver.attachmentFile('ATT-1')!.path
    archiver.forget(`direct:${ALICE}`)
    expect(store.conversation(`direct:${ALICE}`)).toBeNull()
    expect(existsSync(copy)).toBe(false)
  })

  it('archives a conversation already gone from Messages from its copy', () => {
    const alice = chat.direct(ALICE)
    chat.add(alice, { text: 'kept' })
    archiver.archive(`direct:${ALICE}`)
    archiver.unarchive(`direct:${ALICE}`)
    chat.deleteChat(alice)
    chat.purge(alice)
    expect(archiver.archive(`direct:${ALICE}`).verified).toBe(true)
    expect(() => archiver.archive('direct:+19999999999')).toThrow()
  })
})

describe('search', () => {
  it('finds archived messages by word prefix, ignoring accents', () => {
    const alice = chat.direct(ALICE)
    chat.add(alice, { text: 'Dinner at the café on Friday' })
    chat.add(alice, { text: 'unrelated' })
    archiver.archive(`direct:${ALICE}`)
    const hits = store.search('cafe fri')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.snippet).toContain('\u0001café\u0002')
  })

  it('quotes free text so FTS syntax cannot break a query', () => {
    expect(ftsQuery('a "b" -c')).toBe('"a"* "b"* "-c"*')
    expect(ftsQuery('   ')).toBeNull()
    expect(store.search('AND OR NOT "')).toEqual([])
  })
})

describe('contacts', () => {
  it('derives avatar initials', () => {
    expect(initialsOf('Jane Appleseed')).toBe('JA')
    expect(initialsOf('Cher')).toBe('C')
    expect(initialsOf('Mary-Kate Olsen')).toBe('MO')
    expect(initialsOf('')).toBe('?')
  })
})
