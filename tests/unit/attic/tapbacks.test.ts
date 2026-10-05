import { describe, expect, it } from 'bun:test'
import { isMine, pressAndHold, reactionsByMessage } from '../../../resources/functions/tapbacks'

const bubble = {} as EventTarget
const at = (x: number, y: number, button = 0) => ({ button, isPrimary: true, clientX: x, clientY: y, currentTarget: bubble })
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('press and hold', () => {
  it('fires once the pointer has stayed down and still, with the bubble it started on', async () => {
    const held: Array<[string, unknown]> = []
    const hold = pressAndHold<string>((subject, target) => held.push([subject, target]), { ms: 20 })
    hold.down(at(10, 10), 'm1')
    hold.move(at(14, 13))
    await wait(40)
    expect(held).toEqual([['m1', bubble]])
    // Its own release is not a tap on what opened under the finger.
    hold.up()
    expect(hold.justHeld()).toBe(true)
  })

  it('does nothing when the pointer moves, lifts early, or is not the main button', async () => {
    const held: string[] = []
    const hold = pressAndHold<string>(subject => held.push(subject), { ms: 20 })
    hold.down(at(10, 10), 'scrolled')
    hold.move(at(10, 30))
    hold.down(at(10, 10), 'tapped')
    hold.up()
    hold.down(at(10, 10, 2), 'right-click')
    await wait(40)
    expect(held).toEqual([])
    expect(hold.justHeld()).toBe(false)
  })
})

describe('reactions by message', () => {
  const row = (targetGuid: string, reaction: string, isFromMe: boolean, reactionRemoved = false) =>
    ({ kind: 'reaction', targetGuid, reaction, isFromMe, reactionRemoved, senderName: isFromMe ? null : 'Ana' })

  it('adds them up the way the Mac does, a removal taking back the matching one', () => {
    const reactions = reactionsByMessage([
      { kind: 'message', targetGuid: null, reaction: null, isFromMe: false, reactionRemoved: false },
      row('a', '❤️', false),
      row('a', '❤️', true),
      row('a', '👍', true),
      row('a', '❤️', true, true),
      row('b', '😂', false),
    ])
    expect(reactions.get('a')).toEqual([
      { reaction: '❤️', fromMe: false, senderName: 'Ana' },
      { reaction: '👍', fromMe: true, senderName: null },
    ])
    expect(isMine(reactions.get('a')!, '👍')).toBe(true)
    expect(isMine(reactions.get('a')!, '❤️')).toBe(false)
    expect(reactions.get('b')).toHaveLength(1)
  })

  it('counts your own reaction once when it arrives again with a sync', () => {
    const reactions = reactionsByMessage([row('a', '‼️', true), row('a', '‼️', true), row('a', '‼️', false), row('a', '‼️', false)])
    expect(reactions.get('a')!.filter(r => r.fromMe)).toHaveLength(1)
    expect(reactions.get('a')!.filter(r => !r.fromMe)).toHaveLength(2)
  })
})
