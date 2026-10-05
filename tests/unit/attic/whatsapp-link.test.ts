import type { inbox } from '@stacksjs/chat'
import type { BaileysEventMap, WAMessage } from 'baileys'
import type { LinkState } from '../../../app/Attic/whatsapp-link'
import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { proto } from 'baileys'
import { LinkStore, messageText, WhatsAppLink } from '../../../app/Attic/whatsapp-link'

type Events = Partial<BaileysEventMap>

const ME = '15550000001'
const MAYA = '15550000002@s.whatsapp.net'
const MAYA_LID = '99887766@lid'
const GROUP = '120363000000000001@g.us'

/** A stand-in for Baileys' socket: records what Attic asks of it and lets a test push events. */
function fakeSocket() {
  const calls: Array<{ method: string, args: unknown[] }> = []
  let handler: ((events: Events) => Promise<void>) | null = null
  let sent = 0
  const socket = {
    ev: { process: (h: (events: Events) => Promise<void>) => { handler = h } },
    end: () => calls.push({ method: 'end', args: [] }),
    logout: async () => calls.push({ method: 'logout', args: [] }),
    groupFetchAllParticipating: async () => ({ [GROUP]: { id: GROUP, subject: 'Climbing', participants: [{ id: MAYA }, { id: `${ME}@s.whatsapp.net` }] } }),
    sendMessage: async (jid: string, content: unknown, options?: unknown) => {
      calls.push({ method: 'sendMessage', args: [jid, content, options] })
      sent += 1
      return { key: { remoteJid: jid, id: `SENT${sent}`, fromMe: true }, messageTimestamp: 1_800_000_000 + sent }
    },
    chatModify: async (...args: unknown[]) => calls.push({ method: 'chatModify', args }),
    readMessages: async (...args: unknown[]) => calls.push({ method: 'readMessages', args }),
    profilePictureUrl: async () => undefined,
  }
  return {
    socket,
    calls,
    push: async (events: Events) => {
      if (!handler)
        throw new Error('Not connected')
      await handler(events)
    },
  }
}

function text(id: string, jid: string, body: string, at: number, extra: Partial<WAMessage['key']> & { pushName?: string, quote?: string } = {}): WAMessage {
  const { pushName, quote, ...key } = extra
  return {
    key: { remoteJid: jid, id, fromMe: false, ...key },
    messageTimestamp: at,
    pushName,
    message: quote ? { extendedTextMessage: { text: body, contextInfo: { stanzaId: quote } } } : { conversation: body },
  } as WAMessage
}

async function linked() {
  const dir = mkdtempSync(join(tmpdir(), 'attic-wa-'))
  const fake = fakeSocket()
  const states: LinkState[] = []
  const linkedChanges: boolean[] = []
  const link = new WhatsAppLink({
    dir,
    sealKey: async () => new Uint8Array(32).fill(7),
    onState: state => states.push(state),
    onLinked: value => linkedChanges.push(value),
    socket: (() => fake.socket) as never,
    checkVersion: false,
  })
  const events: inbox.InboxEvent[] = []
  link.watch(event => events.push(event))
  await link.link()
  await fake.push({ 'connection.update': { qr: 'https://wa.me/settings/linked_devices#code' } })
  expect(link.linkState()).toMatchObject({ phase: 'linking', qr: 'https://wa.me/settings/linked_devices#code' })
  await fake.push({ 'creds.update': { me: { id: `${ME}:4@s.whatsapp.net`, name: 'Me' } } })
  await fake.push({ 'connection.update': { connection: 'open' } })
  return { dir, link, fake, states, events, linkedChanges }
}

describe('whatsapp link', () => {
  it('links through a scanned code and reports the account', async () => {
    const { link, linkedChanges } = await linked()
    expect(link.linked).toBe(true)
    expect(link.linkState()).toMatchObject({ phase: 'open', qr: null, me: `+${ME}` })
    expect(linkedChanges).toEqual([true])
    expect(await link.status()).toEqual({ connected: true, detail: `Linked as +${ME}.` })
    expect(link.capabilities()).toMatchObject({ send: true, reactions: true, live: true })
  })

  it('keeps the session sealed: the database never holds it in the clear', async () => {
    const { dir } = await linked()
    const store = new LinkStore(join(dir, 'link.sqlite'))
    const raw = new TextDecoder().decode(store.authGet('creds')!)
    expect(raw).not.toContain(ME)
    store.close()
  })

  it('brings in history, then hears new messages, counting what is unread', async () => {
    const { link, fake, events } = await linked()
    await fake.push({
      'messaging-history.set': {
        chats: [{ id: MAYA, unreadCount: 0, conversationTimestamp: 1_700_000_000 }],
        contacts: [{ id: MAYA, name: 'Maya Chen' }],
        messages: [text('H1', MAYA, 'from history', 1_700_000_000)],
        isLatest: true,
      },
    })
    await fake.push({ 'messages.upsert': { type: 'notify', messages: [text('N1', MAYA, 'are you around?', 1_800_000_000, { pushName: 'Maya' })] } })

    const [chat] = await link.conversations()
    expect(chat).toMatchObject({ id: MAYA, kind: 'direct', preview: 'are you around?', previewFromMe: false, unread: 1, visible: true, url: 'https://wa.me/15550000002' })
    expect(chat!.participants[0]!.name).toBe('Maya Chen')
    const message = events.find(e => e.type === 'message')
    expect(message).toMatchObject({ type: 'message', conversationId: MAYA, message: { id: 'N1', text: 'are you around?', fromMe: false } })

    const transcript = await link.messages(MAYA)
    expect(transcript.map(m => m.text)).toEqual(['from history', 'are you around?'])
  })

  it('files a chat that arrives under a LID with the same person\'s number', async () => {
    const { link, fake } = await linked()
    await fake.push({ 'messages.upsert': { type: 'notify', messages: [text('L1', MAYA_LID, 'hi from a lid', 1_800_000_000)] } })
    expect((await link.conversations()).map(c => c.id)).toEqual([MAYA_LID])
    await fake.push({ 'lid-mapping.update': { lid: MAYA_LID, pn: MAYA } })
    await fake.push({ 'messages.upsert': { type: 'notify', messages: [text('L2', MAYA_LID, 'again', 1_800_000_100, { remoteJidAlt: MAYA })] } })
    const chats = await link.conversations()
    expect(chats.map(c => c.id)).toEqual([MAYA])
    expect((await link.messages(MAYA)).map(m => m.id)).toEqual(['L1', 'L2'])
  })

  it('applies edits and unsends, moving them past the archiver\'s cursor', async () => {
    const { link, fake } = await linked()
    await fake.push({ 'messages.upsert': { type: 'notify', messages: [text('E1', MAYA, 'tpyo', 1_800_000_000), text('E2', MAYA, 'second', 1_800_000_001)] } })
    const cursor = (await link.messages(MAYA)).at(-1)!.cursor
    const edit = {
      key: { remoteJid: MAYA, id: 'EDIT1', fromMe: false },
      messageTimestamp: 1_800_000_050,
      message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, key: { remoteJid: MAYA, id: 'E1' }, editedMessage: { conversation: 'typo' } } },
    } as WAMessage
    await fake.push({ 'messages.upsert': { type: 'notify', messages: [edit] } })
    const after = await link.messages(MAYA, { after: cursor })
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ id: 'E1', text: 'typo' })
    expect(after[0]!.editedAt).toBeGreaterThan(0)

    const revoke = {
      key: { remoteJid: MAYA, id: 'REV1', fromMe: false },
      messageTimestamp: 1_800_000_060,
      message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: { remoteJid: MAYA, id: 'E2' } } },
    } as WAMessage
    await fake.push({ 'messages.upsert': { type: 'notify', messages: [revoke] } })
    const unsent = (await link.messages(MAYA)).find(m => m.id === 'E2')!
    expect(unsent).toMatchObject({ unsent: true, text: null })
  })

  it('reads reactions, quoted replies and group senders', async () => {
    const { link, fake } = await linked()
    await fake.push({ 'contacts.upsert': [{ id: MAYA, name: 'Maya Chen' }] })
    await fake.push({ 'messages.upsert': { type: 'notify', messages: [
      text('G1', GROUP, 'who is in for saturday', 1_800_000_000, { participant: MAYA }),
      text('G2', GROUP, 'me', 1_800_000_010, { fromMe: true, quote: 'G1' }),
      { key: { remoteJid: GROUP, id: 'R1', fromMe: false, participant: MAYA }, messageTimestamp: 1_800_000_020, message: { reactionMessage: { key: { remoteJid: GROUP, id: 'G2' }, text: '👍' } } } as WAMessage,
    ] } })
    const [group] = await link.conversations()
    expect(group).toMatchObject({ id: GROUP, kind: 'group', title: 'Climbing', preview: 'me', previewFromMe: true, unread: 0 })
    const transcript = await link.messages(GROUP)
    expect(transcript[0]!.sender).toMatchObject({ id: MAYA, name: 'Maya Chen' })
    expect(transcript[1]).toMatchObject({ fromMe: true, replyToId: 'G1' })
    expect(transcript[2]).toMatchObject({ kind: 'reaction', targetId: 'G2', reaction: '👍', reactionRemoved: false })
  })

  it('describes media and offers it through the driver', async () => {
    const { link, fake } = await linked()
    const photo = {
      key: { remoteJid: MAYA, id: 'P1', fromMe: false },
      messageTimestamp: 1_800_000_000,
      message: { imageMessage: { caption: 'the view', mimetype: 'image/jpeg', fileLength: 2048 } },
    } as unknown as WAMessage
    await fake.push({ 'messages.upsert': { type: 'notify', messages: [photo] } })
    const [message] = await link.messages(MAYA)
    expect(message!.text).toBe('the view')
    expect(message!.attachments).toEqual([{ id: 'P1:media', name: 'Photo.jpg', mimeType: 'image/jpeg', bytes: 2048, path: null, url: `whatsapp-media:${encodeURIComponent(MAYA)}/P1` }])
  })

  it('sends, quotes, reacts, marks read and archives through WhatsApp', async () => {
    const { link, fake } = await linked()
    await fake.push({ 'messages.upsert': { type: 'notify', messages: [text('Q1', MAYA, 'lunch?', 1_800_000_000)] } })

    const outcome = await link.send(MAYA, { text: 'yes!', replyToId: 'Q1' })
    expect(outcome.id).toBe('SENT1')
    const send = fake.calls.find(c => c.method === 'sendMessage')!
    expect(send.args[0]).toBe(MAYA)
    expect(send.args[1]).toEqual({ text: 'yes!' })
    expect((send.args[2] as { quoted: WAMessage }).quoted.key.id).toBe('Q1')

    await link.react(MAYA, 'Q1', '❤️')
    expect(fake.calls.at(-1)!.args[1]).toMatchObject({ react: { text: '❤️', key: { id: 'Q1' } } })

    await link.markRead(MAYA)
    expect(fake.calls.at(-1)!.method).toBe('readMessages')
    expect((await link.conversations())[0]!.unread).toBe(0)

    const archived = await link.archive(MAYA)
    expect(archived).toMatchObject({ mode: 'native', removed: true })
    expect(fake.calls.at(-1)!.args[0]).toMatchObject({ archive: true })
    expect((await link.conversations())[0]!.visible).toBe(false)
  })

  it('forgets everything when WhatsApp unlinks it', async () => {
    const { link, fake, linkedChanges } = await linked()
    await fake.push({ 'messages.upsert': { type: 'notify', messages: [text('X1', MAYA, 'hello', 1_800_000_000)] } })
    await fake.push({ 'connection.update': { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } as never, date: new Date() } } })
    expect(link.linked).toBe(false)
    expect(await link.conversations()).toEqual([])
    expect((await link.status()).needs).toBe('signed-out')
    expect(linkedChanges).toEqual([true, false])
  })
})

describe('messageText', () => {
  it('reads text wherever WhatsApp puts it', () => {
    expect(messageText({ conversation: 'plain' })).toBe('plain')
    expect(messageText({ extendedTextMessage: { text: 'with a link' } })).toBe('with a link')
    expect(messageText({ ephemeralMessage: { message: { conversation: 'disappearing' } } })).toBe('disappearing')
    expect(messageText({ contactMessage: { displayName: 'Sam' } })).toBe('Contact: Sam')
    expect(messageText({ stickerMessage: {} })).toBeNull()
  })
})
