import type { FoldableRow } from '../../../resources/functions/fallback-reactions'
import { describe, expect, it } from 'bun:test'
import { foldFallbackReactions, parseFallbackReaction } from '../../../resources/functions/fallback-reactions'

let clock = 1_800_000_000_000
function row(guid: string, senderName: string | null, text: string | null, extra: Partial<FoldableRow> = {}): FoldableRow {
  clock += 60_000
  return { guid, kind: 'message', text, isFromMe: senderName === null, sentAt: clock, senderName, attachments: [], ...extra }
}

describe('parseFallbackReaction', () => {
  it('reads tapbacks written out as sentences, in English and Spanish', () => {
    expect(parseFallbackReaction('Laughed at a movie')).toEqual({ reaction: '😂', removed: false, quote: null, media: 'video' })
    expect(parseFallbackReaction('Le dio risa un video')).toEqual({ reaction: '😂', removed: false, quote: null, media: 'video' })
    expect(parseFallbackReaction('Loved “See you at 6”')).toEqual({ reaction: '❤️', removed: false, quote: 'See you at 6', media: null })
    expect(parseFallbackReaction('Liked “Running a bit late, save me a…”')).toMatchObject({ reaction: '👍', quote: 'Running a bit late, save me a' })
    expect(parseFallbackReaction('Emphasized an image')).toMatchObject({ reaction: '‼️', media: 'image' })
    expect(parseFallbackReaction('Le encantó una foto')).toMatchObject({ reaction: '❤️', media: 'image' })
    expect(parseFallbackReaction('No le gustó “eso”')).toMatchObject({ reaction: '👎', quote: 'eso' })
    expect(parseFallbackReaction('Reacted 🔥 to “new place looks great”')).toMatchObject({ reaction: '🔥', quote: 'new place looks great' })
    expect(parseFallbackReaction('Removed a heart from “See you at 6”')).toMatchObject({ reaction: '❤️', removed: true, quote: 'See you at 6' })
  })

  it('leaves ordinary messages alone', () => {
    expect(parseFallbackReaction('Loved the movie last night')).toBeNull()
    expect(parseFallbackReaction('Laughed at a movie with Sam, then went home and slept for twelve hours')).toBeNull()
    expect(parseFallbackReaction('Zack wants Bijan anytime TD')).toBeNull()
    expect(parseFallbackReaction(null)).toBeNull()
    expect(parseFallbackReaction('Liked “”')).toBeNull()
  })
})

describe('foldFallbackReactions', () => {
  it('puts a quoted reaction on the message it quotes, even one Messages cut short', () => {
    const rows = [
      row('a', 'Sam', 'Running a bit late, save me a seat by the window please'),
      row('b', 'Ana', 'ok'),
      row('c', 'Ana', 'Liked “Running a bit late, save me a…”'),
      row('d', null, 'Loved “ok”'),
    ]
    const folded = foldFallbackReactions(rows)
    expect(folded.reactions.map(r => [r.targetGuid, r.reaction, r.senderName])).toEqual([['a', '👍', 'Ana'], ['b', '❤️', null]])
    expect([...folded.hidden].sort()).toEqual(['c', 'd'])
    expect(folded.notes.size).toBe(0)
  })

  it('puts a reaction to a video on the nearest earlier video', () => {
    const rows = [
      row('photo', 'Robbie', null, { attachments: [{ mimeType: 'image/jpeg' }] }),
      row('video', 'Robbie', 'happy birthday', { attachments: [{ mimeType: 'video/quicktime' }] }),
      row('r1', 'Ivan', 'Laughed at a movie'),
      row('r2', 'Max', 'Le dio risa un video'),
      row('r3', 'Geoff', 'Loved an image'),
    ]
    const folded = foldFallbackReactions(rows)
    expect(folded.reactions.map(r => [r.targetGuid, r.reaction])).toEqual([['video', '😂'], ['video', '😂'], ['photo', '❤️']])
    expect(folded.notes.size).toBe(0)
  })

  it('turns reactions to a video this device never got into one line, whoever wrote them and in whatever language', () => {
    // The birthday group: the video never reached the Mac, so only the reactions to it did.
    const rows = [
      row('wow', 'Robbie Betschart', 'Wow I ran into a special friend last month and he also wanted to say happy birthday 🎊'),
      row('ivan', 'Ivan Lukic', 'Laughed at a movie'),
      row('max', 'Max Mora', 'Le dio risa un video'),
      row('geoff', 'Geoff', 'Laughed at a movie'),
      row('isaac', 'Isaac', 'Laughed at a movie'),
      row('bijan', 'Ivan Lukic', 'Zack wants Bijan anytime TD'),
      row('jordan', 'Jordan Betschart', 'Laughed at a movie'),
    ]
    const folded = foldFallbackReactions(rows)
    expect(folded.reactions).toEqual([])
    expect(folded.notes).toEqual(new Map([['ivan', '😂 Ivan Lukic, Max Mora, Geoff, Isaac and Jordan Betschart laughed at a video that is not on this device']]))
    expect([...folded.hidden].sort()).toEqual(['geoff', 'isaac', 'jordan', 'max'])
  })

  it('takes a reaction back from the message it was on', () => {
    const rows = [row('a', 'Sam', 'See you at 6'), row('b', 'Ana', 'Removed a heart from “See you at 6”')]
    expect(foldFallbackReactions(rows).reactions).toEqual([{ targetGuid: 'a', reaction: '❤️', removed: true, isFromMe: false, senderName: 'Ana', sentAt: rows[1]!.sentAt }])
  })
})
