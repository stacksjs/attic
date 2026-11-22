import type { inbox as inboxTypes } from '@stacksjs/chat'
import { Database } from 'bun:sqlite'
import { inbox } from '@stacksjs/chat'
import { runMessagesScript } from './messages-script'

const GROUP_STYLE = 43
const APPLE_EPOCH = Date.UTC(2001, 0, 1)

interface Chat {
  rowid: number
  guid: string
  handle: string | null
}

/** A reply only needs this chat and its last service, rather than a full inbox scan. */
export function iMessageSendTarget(databasePath: string, id: string): { guid: string, handle: string, service: string } | null {
  const db = new Database(databasePath, { readonly: true })
  try {
    const direct = id.startsWith('direct:')
    const group = id.startsWith('group:')
    if (!direct && !group)
      return null
    const key = id.slice(direct ? 7 : 6)
    const matches = direct
      ? db.query<Chat, [number]>(`SELECT ROWID AS rowid, guid, chat_identifier AS handle FROM chat WHERE style IS NOT ?`)
        .all(GROUP_STYLE).filter(chat => (chat.handle ? inbox.normalizeHandle(chat.handle) : chat.guid) === key)
      : db.query<Chat, [number, string]>(`SELECT ROWID AS rowid, guid, chat_identifier AS handle
          FROM chat WHERE style = ? AND COALESCE(NULLIF(group_id, ''), guid) = ?`).all(GROUP_STYLE, key)
    if (!matches.length)
      return null

    const recent = db.query<{ date: number, service: string | null }, [number]>(`
      SELECT m.date, m.service FROM chat_message_join j JOIN message m ON m.ROWID = j.message_id
      WHERE j.chat_id = ? ORDER BY m.date DESC, m.ROWID DESC LIMIT 1
    `)
    let newest: { date: number, service: string | null } | null = null
    let guid = matches[0]!.guid
    for (const match of matches) {
      const message = recent.get(match.rowid)
      if (message && (!newest || message.date > newest.date)) {
        newest = message
        guid = match.guid
      }
    }
    return { guid, handle: direct && matches[0]?.handle ? key : '', service: newest?.service === 'SMS' ? 'SMS' : 'iMessage' }
  }
  finally {
    db.close()
  }
}

// Text and attachment paths travel as arguments, never as AppleScript source.
const SEND = `on run argv
  set chatId to item 1 of argv
  set theHandle to item 2 of argv
  set serviceName to item 3 of argv
  set theText to item 4 of argv
  tell application "Messages"
    try
      set target to chat id chatId
    on error
      if theHandle is "" then error "Messages has no chat " & chatId
      if serviceName is "SMS" then
        set target to participant theHandle of (1st account whose service type = SMS)
      else
        set target to participant theHandle of (1st account whose service type = iMessage)
      end if
    end try
    if theText is not "" then send theText to target
    repeat with i from 5 to (count of argv)
      send (POSIX file (item i of argv)) to target
    end repeat
  end tell
end run`

export async function sendIMessage(databasePath: string, id: string, message: inboxTypes.OutgoingMessage): Promise<inboxTypes.SendOutcome> {
  const text = message.text?.trim() ?? ''
  const files = message.files ?? []
  if (!text && !files.length)
    throw new Error('Nothing to send.')
  const target = iMessageSendTarget(databasePath, id)
  if (!target)
    throw new Error('Messages has no chat for this conversation.')
  const result = await runMessagesScript(SEND, [target.guid, target.handle, target.service, text, ...files.map(file => file.path)])
  if (!result.ok)
    throw new Error(`Messages did not send it: ${result.output || 'no reason given'}`)
  return { id: null, sentAt: Date.now() }
}

interface RecentRow {
  id: number
  date: number
  text: string | null
  attributedBody: Uint8Array | null
  incoming: number
  attachments: number
  chatGuid: string | null
  handle: string | null
  sender: string | null
  title: string | null
  style: number | null
  groupId: string | null
}

export interface IMessageNotice {
  key: string
  at: number
  text: string
  sender: string | null
  title: string
  group: boolean
}

/** Read only the new rows, even while a full inbox scan is in progress. */
export class IMessageNotices {
  private cursor: number | undefined

  constructor(private readonly databasePath: string) {}

  read(): IMessageNotice[] {
    const db = new Database(this.databasePath, { readonly: true })
    try {
      if (this.cursor === undefined) {
        this.cursor = db.query<{ id: number | null }, []>('SELECT MAX(ROWID) AS id FROM message').get()?.id ?? 0
        return []
      }
      const rows = db.query<RecentRow, [number]>(`
        WITH recent AS MATERIALIZED (
          SELECT ROWID AS id, date, text, attributedBody, handle_id, cache_has_attachments,
            (is_from_me = 0 AND is_read = 0 AND item_type = 0
              AND COALESCE(associated_message_type, 0) = 0) AS incoming
          FROM message WHERE ROWID > ? ORDER BY ROWID LIMIT 200
        )
        SELECT r.*, c.guid AS chatGuid, c.chat_identifier AS handle, c.style,
          c.display_name AS title, c.group_id AS groupId, h.id AS sender,
          r.cache_has_attachments AS attachments
        FROM recent r
        LEFT JOIN chat_message_join j ON r.incoming AND j.message_id = r.id
        LEFT JOIN chat c ON c.ROWID = j.chat_id
        LEFT JOIN handle h ON h.ROWID = r.handle_id
        ORDER BY r.id
      `).all(this.cursor)
      this.cursor = rows.at(-1)?.id ?? this.cursor
      return rows.flatMap((row) => {
        if (!row.incoming || !row.chatGuid)
          return []
        const group = row.style === GROUP_STYLE
        const id = group ? row.groupId || row.chatGuid : (row.handle ? inbox.normalizeHandle(row.handle) : row.chatGuid)
        const sender = row.sender ? inbox.formatHandle(row.sender) : null
        const text = row.text || (row.attributedBody && inbox.decodeAttributedBody(row.attributedBody))
        return [{
          key: `imessage:${group ? 'group' : 'direct'}:${id}`,
          at: APPLE_EPOCH + (Math.abs(row.date) > 1e12 ? row.date / 1e6 : row.date * 1000),
          text: text?.replace(/\uFFFC/g, '').trim() || (row.attachments ? 'Attachment' : 'New message'),
          sender,
          title: row.title?.trim() || (group ? 'Group message' : sender) || 'New message',
          group,
        }]
      })
    }
    finally {
      db.close()
    }
  }
}
