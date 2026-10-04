import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inbox } from '@stacksjs/chat'
import { Archiver } from '../../../app/Attic/archiver'
import { ALICE, BOB, FakeChatDb } from '../../../app/Attic/sample-db'
import { Sources } from '../../../app/Attic/sources'
import { ArchiveStore, ftsQuery, splitKey } from '../../../app/Attic/store'

/** A Slack-shaped driver held in memory: archive closes, a new message reopens. */
class FakeSlack implements inbox.InboxDriver {
  readonly provider = 'slack' as const
  readonly label = 'Slack'
  open = true
  messagesById: inbox.InboxMessage[] = []
  archived: string[] = []
  unarchived: string[] = []

  post(text: string, fromMe = false): void {
    const ts = String(1_700_000_000 + this.messagesById.length)
    this.messagesById.push({ id: ts, conversationId: 'D1', kind: 'message', text, fromMe, sentAt: Number(ts) * 1000, sender: fromMe ? null : { id: 'UANN', name: 'Ann' }, targetId: null, reaction: null, reactionRemoved: false, replyToId: null, editedAt: null, unsent: false, attachments: [], cursor: ts })
    if (!fromMe)
      this.open = true
  }

  async status() {
    return { connected: true, detail: 'ok' }
  }

  async conversations(): Promise<inbox.InboxConversation[]> {
    const last = this.messagesById.at(-1)
    return [{ provider: 'slack', id: 'D1', kind: 'direct', title: null, participants: [{ id: 'UANN', name: 'Ann' }], workspace: 'Acme', lastMessageAt: last?.sentAt ?? null, preview: last?.text ?? null, previewFromMe: !!last?.fromMe, unread: 0, cursor: last?.cursor ?? '0', visible: this.open, archive: { mode: 'native', detail: 'Closes it in Slack.' }, url: 'slack://channel?team=T1&id=D1' }]
  }

  async messages(_id: string, query: inbox.MessageQuery = {}): Promise<inbox.InboxMessage[]> {
    const after = Number(query.after ?? 0)
    return this.messagesById.filter(m => Number(m.cursor) > after)
  }

  async archive(id: string): Promise<inbox.ArchiveOutcome> {
    this.archived.push(id)
    this.open = false
    return { mode: 'native', removed: true, detail: 'Closes it in Slack.' }
  }

  async unarchive(id: string): Promise<void> {
    this.unarchived.push(id)
    this.open = true
  }

  async attachment(): Promise<Response> {
    return new Response('nope', { status: 404 })
  }
}

let chat: FakeChatDb
let store: ArchiveStore
let archiver: Archiver
let attachmentsDir: string
let slack: FakeSlack
let controllerCalls: string[]

beforeEach(async () => {
  chat = new FakeChatDb()
  const dir = mkdtempSync(join(tmpdir(), 'attic-store-'))
  attachmentsDir = join(dir, 'Attachments')
  store = new ArchiveStore(join(dir, 'attic.sqlite'))
  slack = new FakeSlack()
  controllerCalls = []
  const imessage = inbox.createInboxDriver('imessage', {
    databasePath: chat.path,
    addressBookDir: false,
    confirmDeletes: true,
    controller: {
      remove: async (names, url, confirm) => {
        controllerCalls.push(`remove ${names[0]} ${url} ${confirm}`)
        return { ok: true, detail: '' }
      },
      recover: async (names) => {
        controllerCalls.push(`recover ${names[0]}`)
        return { ok: true, detail: '' }
      },
    },
  })
  const sources = new Sources({ confirmDeletes: () => true, sample: true, drivers: { imessage, slack } })
  await sources.load()
  archiver = new Archiver({ store, sources, attachmentsDir })
})

afterEach(() => {
  store.close()
  chat.close()
})

describe('archiving iMessage', () => {
  it('copies every message, reaction and attachment, verifies, then archives', async () => {
    const alice = chat.direct(ALICE)
    const first = chat.add(alice, { text: 'look at this', attachment: { name: 'IMG_0001.HEIC', mime: 'image/heic' } })
    chat.add(alice, { text: 'Loved “look at this”', reaction: { type: 2000, target: first }, fromMe: true })
    chat.add(alice, { text: 'never downloaded', attachment: { name: 'old.mov', mime: 'video/quicktime', bytes: null } })

    const key = `imessage:direct:${ALICE}`
    const result = await archiver.archive(key)
    expect(result).toMatchObject({ verified: true, messages: 2, attachmentsCopied: 1, attachmentsMissing: 1 })
    expect(store.conversation(key)!.state).toBe('archived')

    const response = await archiver.attachmentResponse('ATT-1')
    expect(await response!.text()).toBe('bytes of IMG_0001.HEIC')
  })

  it('takes it out of Messages through the controller, and recovers it on unarchive', async () => {
    const alice = chat.direct(ALICE)
    chat.add(alice, { text: 'hello' })
    const key = `imessage:direct:${ALICE}`
    await archiver.archive(key)
    expect((await archiver.removeFromApp(key)).mode).toBe('confirm')
    chat.deleteChat(alice)
    await archiver.sync()
    expect(store.conversation(key)!.removedAt).not.toBeNull()
    await archiver.unarchive(key)
    expect(controllerCalls).toEqual([`remove +1 (555) 000-2222 sms:${ALICE} true`, 'recover +1 (555) 000-2222'])
    expect(store.conversation(key)!.state).toBe('unarchived')
  })

  it('keeps the whole history readable after Messages deletes it for good', async () => {
    const alice = chat.direct(ALICE)
    const first = chat.add(alice, { text: 'first', attachment: { name: 'a.jpg', mime: 'image/jpeg' } })
    chat.add(alice, { text: '👍', reaction: { type: 2001, target: first }, fromMe: true })
    chat.add(alice, { text: 'second', fromMe: true })
    const key = `imessage:direct:${ALICE}`
    await archiver.archive(key)

    chat.deleteChat(alice)
    expect((await archiver.sync()).removed).toEqual([key])
    chat.purge(alice)

    const transcript = await archiver.transcript(key)
    expect(transcript.messages.map(m => m.text)).toEqual(['first', 'second'])
    expect(transcript.messages.every(m => !m.inApp)).toBe(true)
    expect(transcript.messages[0]!.reactions).toEqual([{ reaction: '👍', fromMe: true, senderName: null }])
  })

  it('brings an archived conversation back when someone writes again, history attached', async () => {
    const alice = chat.direct(ALICE)
    chat.add(alice, { text: 'old news' })
    const key = `imessage:direct:${ALICE}`
    await archiver.archive(key)
    chat.deleteChat(alice)
    chat.purge(alice)
    await archiver.sync()

    chat.add(chat.direct(ALICE, 'any'), { text: 'are you around?' })
    const report = await archiver.sync()
    expect(report.resurfaced).toEqual([key])
    expect(store.conversation(key)).toMatchObject({ state: 'unarchived', removedAt: null })
    const transcript = await archiver.transcript(key)
    expect(transcript.messages.map(m => [m.text, m.inApp])).toEqual([['old news', false], ['are you around?', true]])
  })

  it('does not resurface for a reaction alone, and stays put in "stay" mode', async () => {
    const alice = chat.direct(ALICE)
    const first = chat.add(alice, { text: 'one' })
    const key = `imessage:direct:${ALICE}`
    await archiver.archive(key)
    chat.add(alice, { text: 'Liked “one”', reaction: { type: 2001, target: first } })
    expect((await archiver.sync()).resurfaced).toEqual([])
    chat.add(alice, { text: 'two' })
    expect((await archiver.sync('stay')).resurfaced).toEqual([])
    expect(store.conversation(key)!.state).toBe('archived')
    expect(store.messageCount(key)).toBe(3)
  })

  it('forgets a copy, attachments included', async () => {
    const alice = chat.direct(ALICE)
    chat.add(alice, { text: 'hello', attachment: { name: 'b.png', mime: 'image/png' } })
    const key = `imessage:direct:${ALICE}`
    await archiver.archive(key)
    const kept = store.attachment('ATT-1')!
    archiver.forget(key)
    expect(store.conversation(key)).toBeNull()
    expect(existsSync(join(attachmentsDir, kept.storedPath!))).toBe(false)
  })
})

describe('archiving Slack', () => {
  it('copies the DM, closes it in Slack, and reopens it on unarchive', async () => {
    slack.post('lunch?')
    slack.post('sure', true)
    const key = 'slack:D1'
    expect((await archiver.archive(key)).verified).toBe(true)
    expect(await archiver.removeFromApp(key)).toMatchObject({ mode: 'native', removed: true })
    expect(slack.archived).toEqual(['D1'])
    expect((await archiver.sync()).removed).toEqual([key])
    // Closing a Slack DM hides it; the history is still Slack's too.
    expect(store.conversation(key)!.goneBefore).toBeNull()

    await archiver.unarchive(key)
    expect(slack.unarchived).toEqual(['D1'])
    expect(store.conversation(key)!.state).toBe('unarchived')
  })

  it('resurfaces when someone writes in a closed DM', async () => {
    slack.post('lunch?')
    await archiver.archive('slack:D1')
    await archiver.removeFromApp('slack:D1')
    await archiver.sync()
    slack.post('still hungry?')
    // Slack's list is cached for a minute; the agent's timer forces the re-read.
    expect((await archiver.sync('inbox', Date.now(), true)).resurfaced).toEqual(['slack:D1'])
    expect(store.messageCount('slack:D1')).toBe(2)
  })
})

describe('store', () => {
  it('upgrades a 0.1 archive in place, keys and all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'attic-old-'))
    const path = join(dir, 'attic.sqlite')
    const old = new Database(path)
    old.exec(`
      CREATE TABLE conversations (key TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT, participants TEXT NOT NULL DEFAULT '[]', chat_guids TEXT NOT NULL DEFAULT '[]', group_id TEXT, state TEXT NOT NULL DEFAULT 'archived', archived_at INTEGER, unarchived_at INTEGER, resurfaced_at INTEGER, removed_at INTEGER, last_message_at INTEGER, synced_rowid INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE messages (guid TEXT PRIMARY KEY, conversation_key TEXT NOT NULL, chat_guid TEXT NOT NULL, kind TEXT NOT NULL, text TEXT, is_from_me INTEGER NOT NULL, sent_at INTEGER NOT NULL, sender TEXT, service TEXT, target_guid TEXT, reaction_type INTEGER NOT NULL DEFAULT 0, reply_to_guid TEXT, edited_at INTEGER, unsent INTEGER NOT NULL DEFAULT 0, event_type INTEGER NOT NULL DEFAULT 0, group_title TEXT, source_rowid INTEGER);
      INSERT INTO conversations (key, kind, participants, synced_rowid) VALUES ('direct:${BOB}', 'direct', '["${BOB}"]', 7);
      INSERT INTO messages (guid, conversation_key, chat_guid, kind, is_from_me, sent_at, target_guid, reaction_type) VALUES ('R1', 'direct:${BOB}', 'g', 'reaction', 1, 1, 'M1', 2000);
    `)
    old.close()

    const upgraded = new ArchiveStore(path)
    const conversation = upgraded.conversation(`imessage:direct:${BOB}`)!
    expect(conversation).toMatchObject({ provider: 'imessage', syncedCursor: '7', participants: [{ id: BOB, name: null }] })
    expect(upgraded.messages(`imessage:direct:${BOB}`)[0]).toMatchObject({ reaction: '❤️', reactionRemoved: false })
    upgraded.close()
  })

  it('splits keys, including iMessage ids that hold colons', () => {
    expect(splitKey('imessage:group:G-1')).toEqual({ provider: 'imessage', id: 'group:G-1' })
    expect(splitKey('slack:D1')).toEqual({ provider: 'slack', id: 'D1' })
  })

  it('finds archived messages by word prefix, ignoring accents', async () => {
    const alice = chat.direct(ALICE)
    chat.add(alice, { text: 'Dinner at the café on Friday' })
    await archiver.archive(`imessage:direct:${ALICE}`)
    const hits = store.search('cafe fri')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.snippet).toContain('\u0001café\u0002')
    expect(ftsQuery('a "b"')).toBe('"a"* "b"*')
    expect(readFileSync(chat.path).length).toBeGreaterThan(0)
  })
})
