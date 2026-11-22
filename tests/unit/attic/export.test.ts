import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportArchive, exportFolder, renderConversation, safeFileName } from '../../../app/Attic/export'
import { ArchiveStore } from '../../../app/Attic/store'

const directories: string[] = []
function workspace(): { root: string, store: ArchiveStore, attachments: string, out: string } {
  const root = mkdtempSync(join(tmpdir(), 'attic-export-'))
  directories.push(root)
  const attachments = join(root, 'Attachments')
  mkdirSync(attachments, { recursive: true })
  return { root, store: new ArchiveStore(join(root, 'attic.sqlite')), attachments, out: join(root, 'out') }
}

afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function message(fields: Partial<Parameters<ArchiveStore['upsertMessages']>[1][number]> & { guid: string, sentAt: number }) {
  return {
    kind: 'message' as const,
    text: null,
    isFromMe: false,
    sender: '+15550001111',
    senderName: 'Alice',
    targetGuid: null,
    reaction: null,
    reactionRemoved: false,
    replyToGuid: null,
    service: 'iMessage',
    editedAt: null,
    unsent: false,
    cursor: null,
    ...fields,
  }
}

describe('export', () => {
  it('writes a readable page per conversation, with its attachments beside it', async () => {
    const { store, attachments, out } = workspace()
    const key = 'imessage:direct:+15550001111'
    store.upsertConversation({ key, provider: 'imessage', kind: 'direct', title: null, participants: [{ id: '+15550001111', name: 'Alice Chen' }], workspace: null, url: null, lastMessageAt: 3000 })
    store.upsertMessages(key, [
      message({ guid: 'a', sentAt: 1000, text: 'Dinner at 7 <ok>?' }),
      message({ guid: 'b', sentAt: 2000, text: 'Works for me', isFromMe: true, sender: null, senderName: null }),
      // A reaction belongs on the message it names, not in the list.
      message({ guid: 'r', sentAt: 2500, kind: 'reaction', targetGuid: 'a', reaction: '❤️', isFromMe: true, sender: null, senderName: null }),
      message({ guid: 'c', sentAt: 3000, text: null }),
    ])
    writeFileSync(join(attachments, 'photo.jpg'), 'jpeg-bytes')
    store.upsertAttachment(key, { guid: 'att-1', messageGuid: 'c', name: 'Sunset.jpg', mimeType: 'image/jpeg', bytes: 10, isSticker: false, storedPath: 'photo.jpg', status: 'copied' })
    store.upsertAttachment(key, { guid: 'att-2', messageGuid: 'c', name: 'Gone.pdf', mimeType: 'application/pdf', bytes: 0, isSticker: false, storedPath: null, status: 'missing' })

    const result = await exportArchive({ store, attachmentsDir: attachments, destination: out, now: Date.UTC(2026, 10, 6, 18) })

    expect(result.conversations).toHaveLength(1)
    expect(result.messages).toBe(3)
    expect(result.attachments).toBe(1)
    expect(result.missingAttachments).toBe(1)
    // One conversation needs no contents page.
    expect(result.index).toBeNull()
    expect(result.conversations[0]!.file).toBe('Alice Chen.html')

    const html = readFileSync(join(out, 'Alice Chen.html'), 'utf8')
    expect(html).toStartWith('<!doctype html>')
    expect(html).toContain('<title>Alice Chen</title>')
    expect(html).toContain('Works for me')
    // Text from a conversation is never markup.
    expect(html).toContain('Dinner at 7 &lt;ok&gt;?')
    expect(html).not.toContain('Dinner at 7 <ok>')
    // The reaction is a tag on its message, and not a row of its own.
    expect(html).toContain('❤️')
    expect(html.match(/class="row /g)).toHaveLength(3)
    // The picture is a relative link into this conversation's folder.
    expect(html).toContain('src="Attachments/Alice%20Chen/att-1-photo.jpg"')
    expect(readFileSync(join(out, 'Attachments', 'Alice Chen', 'att-1-photo.jpg'), 'utf8')).toBe('jpeg-bytes')
    // What the app had already thrown away says so rather than breaking a link.
    expect(html).toContain('Gone.pdf was no longer on this Mac')
    expect(html).not.toContain('Gone.pdf"')
    // The one design rule the whole app follows.
    expect(html).not.toContain('—')
    store.close()
  })

  it('writes a contents page for a whole archive, and keeps two Alices apart', async () => {
    const { store, attachments, out } = workspace()
    for (const [index, id] of ['+15550001111', '+15550002222'].entries()) {
      const key = `imessage:direct:${id}`
      store.upsertConversation({ key, provider: 'imessage', kind: 'direct', title: 'Alice', participants: [{ id, name: 'Alice' }], workspace: null, url: null, lastMessageAt: 1000 })
      store.upsertMessages(key, [message({ guid: `m${index}`, sentAt: 1000, text: `Hello from ${id}` })])
    }
    store.upsertConversation({ key: 'slack:C0DESIGN', provider: 'slack', kind: 'channel', title: '#design', participants: [], workspace: 'Studio', url: null, lastMessageAt: 2000 })
    store.upsertMessages('slack:C0DESIGN', [message({ guid: 's1', sentAt: 2000, text: 'Shipping today' })])

    const result = await exportArchive({ store, attachmentsDir: attachments, destination: out })

    expect(result.conversations.map(c => c.file).sort()).toEqual(['#design.html', 'Alice 2.html', 'Alice.html'])
    expect(result.index).toBe('index.html')
    const index = readFileSync(join(out, 'index.html'), 'utf8')
    expect(index).toContain('3 conversations')
    expect(index).toContain('href="Alice%202.html"')
    // Each page links back to the contents page of its export.
    expect(readFileSync(join(out, 'Alice.html'), 'utf8')).toContain('href="index.html"')
    // A channel's page names the app and the workspace it came from.
    const design = readFileSync(join(out, '#design.html'), 'utf8')
    expect(design).toContain('<span>Slack</span>')
    expect(design).toContain('<span>Studio</span>')
    store.close()
  })

  it('exports only the conversation asked for', async () => {
    const { store, attachments, out } = workspace()
    for (const id of ['a', 'b']) {
      store.upsertConversation({ key: `imessage:direct:${id}`, provider: 'imessage', kind: 'direct', title: id, participants: [], workspace: null, url: null, lastMessageAt: 1000 })
      store.upsertMessages(`imessage:direct:${id}`, [message({ guid: id, sentAt: 1000, text: id })])
    }
    const result = await exportArchive({ store, attachmentsDir: attachments, destination: out, keys: ['imessage:direct:b'] })
    expect(result.conversations.map(c => c.key)).toEqual(['imessage:direct:b'])
    expect(result.index).toBeNull()
    store.close()
  })

  it('never writes outside the export folder, whatever a conversation is called', () => {
    expect(safeFileName('../../etc/passwd')).toBe('etc passwd')
    // A slash in a name keeps both halves rather than losing the first.
    expect(safeFileName('Mum/Dad')).toBe('Mum Dad')
    expect(safeFileName('Dad: home/work')).toBe('Dad home work')
    expect(safeFileName('   ')).toBe('Conversation')
    expect(safeFileName('.hidden')).toBe('hidden')
  })

  it('numbers a second export of the same day instead of writing over the first', () => {
    const existing = new Set(['/exports/Texts Export 2026-11-06'])
    expect(exportFolder('/exports', Date.UTC(2026, 10, 6, 18), path => existing.has(path)))
      .toBe('/exports/Texts Export 2026-11-06 2')
  })

  it('says so when a conversation was archived with nothing in it', () => {
    const html = renderConversation({
      conversation: {
        key: 'slack:C0EMPTY', provider: 'slack', id: 'C0EMPTY', kind: 'channel', title: '#empty', participants: [], workspace: 'Studio',
        avatar: null, url: null, state: 'archived', archivedAt: 1000, unarchivedAt: null, resurfacedAt: null, removedAt: null,
        goneBefore: null, lastMessageAt: null, syncedCursor: null, messageCount: 0, attachmentCount: 0, attachmentBytes: 0, missingAttachments: 0,
      },
      messages: [],
      folder: 'Attachments/%23empty',
    })
    expect(html).toContain('Texts kept no messages for this conversation.')
  })
})
