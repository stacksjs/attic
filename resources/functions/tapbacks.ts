/**
 * Reacting to a message, shared by the Mac's window and the phone app: the
 * six tapbacks Messages offers, the press-and-hold that brings them up, and
 * how a conversation's reaction rows add up to what each bubble shows.
 */

/** Messages' tapbacks, and what Slack and Discord call them. Each driver maps the emoji to its app's own. */
export const TAPBACKS: ReadonlyArray<{ emoji: string, label: string }> = [
  { emoji: '❤️', label: 'Love' },
  { emoji: '👍', label: 'Like' },
  { emoji: '👎', label: 'Dislike' },
  { emoji: '😂', label: 'Laugh' },
  { emoji: '‼️', label: 'Emphasize' },
  { emoji: '❓', label: 'Question' },
]

/** About as long as Messages waits before a held bubble shows its tapbacks. */
export const HOLD_MS = 450
/** A finger or pointer that travels further than this is scrolling or selecting, not holding. */
export const HOLD_SLOP_PX = 8
/** The click a hold's release makes arrives a moment later; it is not a tap on what opened under it. */
const RELEASE_GRACE_MS = 400

interface PointerLike {
  button: number
  isPrimary: boolean
  clientX: number
  clientY: number
  currentTarget: EventTarget | null
}

export interface PressAndHold<T> {
  down: (event: PointerLike, subject: T) => void
  move: (event: PointerLike) => void
  /** Lifted, cancelled or left: a hold that has not fired yet never will. */
  up: () => void
  /** Whether a hold is under way or just ended, so its own release is not taken for a tap. */
  justHeld: () => boolean
}

/**
 * Press and hold on pointer events, which a mouse, a trackpad and a finger
 * all send: it fires once the pointer has stayed down and still for `ms`,
 * and not at all if it moves or lifts first.
 */
export function pressAndHold<T>(onHold: (subject: T, target: Element) => void, options: { ms?: number, slop?: number } = {}): PressAndHold<T> {
  const ms = options.ms ?? HOLD_MS
  const slop = options.slop ?? HOLD_SLOP_PX
  let timer: ReturnType<typeof setTimeout> | null = null
  let startX = 0
  let startY = 0
  let held = false
  let releasedAt = 0

  const cancel = (): void => {
    if (timer)
      clearTimeout(timer)
    timer = null
  }

  return {
    down(event, subject) {
      // The main button only: a right-click belongs to the context menu.
      if (event.button !== 0 || !event.isPrimary)
        return
      cancel()
      held = false
      startX = event.clientX
      startY = event.clientY
      // The event's target is gone by the time the timer fires: keep it now.
      const target = event.currentTarget as Element
      timer = setTimeout(() => {
        timer = null
        held = true
        onHold(subject, target)
      }, ms)
    },
    move(event) {
      if (timer && Math.hypot(event.clientX - startX, event.clientY - startY) > slop)
        cancel()
    },
    up() {
      cancel()
      if (held) {
        held = false
        releasedAt = Date.now()
      }
    },
    justHeld: () => held || Date.now() - releasedAt < RELEASE_GRACE_MS,
  }
}

export interface Reacted {
  reaction: string
  fromMe: boolean
  senderName: string | null
}

interface ReactionRow {
  kind: string
  targetGuid: string | null
  reaction: string | null
  reactionRemoved: boolean
  isFromMe: boolean
  senderName?: string | null
}

/**
 * Each message's reactions from a conversation's rows, oldest first, the way
 * the Mac's archive adds them up: a removal takes back the matching one.
 * Your own reaction counts once, so one sent from here and the same one
 * arriving with the next sync do not show twice.
 */
export function reactionsByMessage(rows: ReadonlyArray<ReactionRow>): Map<string, Reacted[]> {
  const out = new Map<string, Reacted[]>()
  for (const row of rows) {
    if (row.kind !== 'reaction' || !row.targetGuid || !row.reaction)
      continue
    const list = out.get(row.targetGuid) ?? []
    const at = list.findIndex(r => r.reaction === row.reaction && r.fromMe === row.isFromMe)
    if (row.reactionRemoved) {
      if (at !== -1)
        list.splice(at, 1)
    }
    else if (!(row.isFromMe && at !== -1)) {
      list.push({ reaction: row.reaction, fromMe: row.isFromMe, senderName: row.senderName ?? null })
    }
    out.set(row.targetGuid, list)
  }
  return out
}

/** Whether this tapback on a message is already yours: choosing it again takes it back. */
export function isMine(reactions: ReadonlyArray<{ reaction: string, fromMe: boolean }>, emoji: string): boolean {
  return reactions.some(r => r.reaction === emoji && r.fromMe)
}
