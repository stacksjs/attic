import { afterEach, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { IMessageNotices, iMessageSendTarget } from '../../../app/Attic/imessage-local'
import { ALICE, BOB, FakeChatDb } from '../../../app/Attic/sample-db'

let fixture: FakeChatDb | undefined

afterEach(() => {
  if (fixture) {
    fixture.close()
    rmSync(fixture.dir, { recursive: true, force: true })
    fixture = undefined
  }
})

it('sends through the latest service in a merged conversation and keeps group replies in their group', () => {
  const db = fixture = new FakeChatDb()
  const direct = db.direct(ALICE)
  const sms = db.direct(ALICE, 'SMS')
  const group = db.group('work', [ALICE, BOB], { groupId: 'group-key' })
  db.add(direct, { text: 'Earlier iMessage' })
  const smsMessage = db.add(sms, { text: 'Latest SMS' })
  db.db.run("UPDATE message SET service = 'SMS' WHERE guid = ?", [smsMessage])
  expect(iMessageSendTarget(db.path, `direct:${ALICE}`)).toEqual({
    guid: `SMS;-;${ALICE}`, handle: ALICE, service: 'SMS',
  })
  expect(iMessageSendTarget(db.path, 'group:group-key')).toEqual({
    guid: 'iMessage;+;work', handle: '', service: 'iMessage',
  })
  expect(iMessageSendTarget(db.path, 'direct:missing@example.com')).toBeNull()
})

it('reports fresh unread Messages rows without replaying history, outgoing messages, or tapbacks', () => {
  const db = fixture = new FakeChatDb()
  const chat = db.direct(ALICE)
  const earlier = db.add(chat, { text: 'Older unread message', read: false })
  const notices = new IMessageNotices(db.path)
  expect(notices.read()).toEqual([])
  db.add(chat, { text: 'Already seen' })
  db.add(chat, { text: 'Sent from this Mac', fromMe: true, read: false })
  db.add(chat, { text: 'Liked', reaction: { type: 2001, target: earlier }, read: false })
  const at = Date.UTC(2026, 1, 2, 12)
  db.add(chat, { text: 'New text from a contact', at, read: false })
  expect(notices.read()).toEqual([expect.objectContaining({
    key: `imessage:direct:${ALICE}`, text: 'New text from a contact', at, group: false,
  })])
  expect(notices.read()).toEqual([])
})
