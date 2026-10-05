import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchiveStore } from '../../../app/Attic/store'

function message(guid: string, sentAt: number, replyToGuid: string | null) {
  return {
    guid, kind: 'message' as const, text: guid, isFromMe: false, sentAt, sender: '+15550001111', senderName: 'Alice',
    targetGuid: null, reaction: null, reactionRemoved: false, replyToGuid, service: 'iMessage', editedAt: null, unsent: false, cursor: null,
  }
}

describe('archive store', () => {
  it('drops the reply links copied from reply_to_guid, and keeps real replies', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'attic-store-')), 'attic.sqlite')
    const key = 'imessage:direct:+15550001111'
    const before = new ArchiveStore(path)
    before.upsertConversation({ key, provider: 'imessage', kind: 'direct', title: 'Alice', participants: [], workspace: null, url: null, lastMessageAt: 4000 })
    // As 0.75.57 and earlier copied them: each message linked to the one before.
    before.upsertMessages(key, [
      message('a', 1000, null),
      message('b', 2000, 'a'),
      message('c', 3000, 'b'),
      // A real inline reply to the first message, two messages back.
      message('d', 4000, 'a'),
    ])
    before.close()
    // An archive from before the repair existed.
    const db = new Database(path)
    db.exec(`DELETE FROM settings WHERE key = 'repair:imessage-reply-links'`)
    db.close()

    const after = new ArchiveStore(path)
    const links = Object.fromEntries(after.messages(key).map(m => [m.guid, m.replyToGuid]))
    expect(links).toEqual({ a: null, b: null, c: null, d: 'a' })
    expect(after.messages(key)[0]!.service).toBe('iMessage')
    after.close()
  })
})
