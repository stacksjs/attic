import type { TranscriptMessage } from '../../../app/Attic/archiver'
import { expect, it } from 'bun:test'
import { messageTimeline, transcriptStamp } from '../../../resources/functions/native-timeline'

function message(sentAt: number, isFromMe = false, sender = 'Maya'): TranscriptMessage {
  return { sentAt, isFromMe, sender, senderName: sender } as TranscriptMessage
}

it('groups consecutive messages while marking pauses, sender changes and midnight', () => {
  const at = new Date(2026, 9, 25, 12, 0).getTime()
  const rows = messageTimeline([message(at), message(at + 60_000), message(at + 120_000, true), message(at + 8 * 60_000), message(at + 9 * 60_000)])
  expect(rows.map(row => row.timestamp)).toEqual([true, false, false, true, false])
  expect(rows.map(row => !!row.joined)).toEqual([false, true, false, false, true])
  const midnight = messageTimeline([message(new Date(2026, 9, 25, 23, 59).getTime()), message(new Date(2026, 9, 26, 0, 1).getTime())])
  expect(midnight.map(row => row.timestamp)).toEqual([true, true])
})

it('labels today and yesterday relative to the supplied date', () => {
  const now = new Date(2026, 9, 25, 12).getTime()
  expect(transcriptStamp(now, now)).toStartWith('Today ')
  expect(transcriptStamp(new Date(2026, 9, 24, 12).getTime(), now)).toStartWith('Yesterday ')
})
