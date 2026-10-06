/**
 * Reactions that arrive as text.
 *
 * In an SMS or RCS conversation a tapback often travels as a sentence rather
 * than as a reaction: "Loved “See you at 6”", "Laughed at a movie", or, from
 * a phone set to Spanish, "Le dio risa un video". Messages stores those as
 * ordinary messages, so a group's birthday video comes back as a stack of
 * bubbles that each say someone laughed at it.
 *
 * This reads those sentences back into what they mean: a reaction on the
 * message it names, where that message can be found, and otherwise one quiet
 * line that says who reacted to what - however many people did. The Mac's
 * transcript and the phone's both use it, so they read a conversation alike.
 */

/** What a sentence says: which reaction, given or taken back, and on what. */
export interface FallbackReaction {
  reaction: string
  removed: boolean
  /** The quoted text, without its quotation marks or a trailing ellipsis. */
  quote: string | null
  /** For a reaction to a picture or a video rather than to words. */
  media: 'image' | 'video' | 'audio' | 'attachment' | null
}

/** The fields a transcript row needs here, on the Mac and on the phone alike. */
export interface FoldableRow {
  guid: string
  kind: string
  text: string | null
  isFromMe: boolean
  sentAt: number
  senderName: string | null
  attachments: ReadonlyArray<{ mimeType: string | null }>
}

export interface FoldedReaction {
  targetGuid: string
  reaction: string
  removed: boolean
  isFromMe: boolean
  senderName: string | null
  sentAt: number
}

export interface Folded {
  /** Reactions to put on the messages they name. */
  reactions: FoldedReaction[]
  /** Rows that were reactions, now shown as such or inside a note: leave them out. */
  hidden: Set<string>
  /** A row to show as one line instead, for reactions whose message is not here. */
  notes: Map<string, string>
}

/** The verbs Messages writes, in the languages seen so far, and the reaction each means. */
const VERBS: Array<{ pattern: string, reaction: string }> = [
  { pattern: 'Loved', reaction: '❤️' },
  { pattern: 'Liked', reaction: '👍' },
  { pattern: 'Disliked', reaction: '👎' },
  { pattern: 'Laughed at', reaction: '😂' },
  { pattern: 'Emphasized', reaction: '‼️' },
  { pattern: 'Questioned', reaction: '❓' },
  { pattern: 'Le encantó', reaction: '❤️' },
  { pattern: 'No le gustó', reaction: '👎' },
  { pattern: 'Le gustó', reaction: '👍' },
  { pattern: 'Le dio risa', reaction: '😂' },
  { pattern: 'Le hizo gracia', reaction: '😂' },
  { pattern: 'Enfatizó', reaction: '‼️' },
  { pattern: 'Cuestionó', reaction: '❓' },
]

/** What a taken-back tapback is called in "Removed a heart from …". */
const REMOVED_NOUNS: Record<string, string> = {
  'heart': '❤️',
  'like': '👍',
  'dislike': '👎',
  'laugh': '😂',
  'exclamation': '‼️',
  'emphasis': '‼️',
  'question mark': '❓',
}

/** How Messages names an attachment it cannot quote. */
const MEDIA: Array<{ pattern: RegExp, media: NonNullable<FallbackReaction['media']> }> = [
  { pattern: /^(?:an? )?(?:image|photo|picture|gif|sticker)$|^una (?:imagen|foto|fotografía)$/i, media: 'image' },
  { pattern: /^an? (?:movie|video)$|^un (?:video|vídeo)$|^una película$/i, media: 'video' },
  { pattern: /^an? audio(?: message)?$|^un (?:audio|mensaje de audio)$/i, media: 'audio' },
  { pattern: /^an? attachment$|^un archivo(?: adjunto)?$/i, media: 'attachment' },
]

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const VERB = new RegExp(`^(${VERBS.map(v => escape(v.pattern)).join('|')}) (.+)$`, 's')
const REACTED = /^(?:Reacted|Reaccionó con) (.+?) (?:to|a) (.+)$/s
const REMOVED = /^Removed (?:an? )?(.+?) from (.+)$/s

/** “quoted”, "quoted" or «quoted», ellipsis and all; null when it is not a quotation. */
function unquote(object: string): string | null {
  const match = object.match(/^[“"«](.*)[”"»]$/s)
  if (!match)
    return null
  return match[1]!.replace(/(?:…|\.\.\.)$/, '').trim()
}

/** The thing reacted to: a quotation or an attachment, or nothing this understands. */
function objectOf(object: string): Pick<FallbackReaction, 'quote' | 'media'> | null {
  const quote = unquote(object.trim())
  if (quote !== null)
    return quote ? { quote, media: null } : null
  const media = MEDIA.find(m => m.pattern.test(object.trim()))?.media
  return media ? { quote: null, media } : null
}

/** A tapback written out as a sentence, or null for an ordinary message. */
export function parseFallbackReaction(text: string | null): FallbackReaction | null {
  const line = text?.trim()
  // A reaction is one short line; a message that happens to start with
  // "Loved" and runs on is somebody talking.
  if (!line || line.length > 400 || (line.includes('\n') && !/^[^\n]+[“"«]/.test(line)))
    return null
  const removed = line.match(REMOVED)
  if (removed) {
    const noun = removed[1]!.toLowerCase()
    const object = objectOf(removed[2]!)
    const reaction = REMOVED_NOUNS[noun] ?? ([...removed[1]!].length <= 4 ? removed[1]! : null)
    return object && reaction ? { reaction, removed: true, ...object } : null
  }
  const reacted = line.match(REACTED)
  if (reacted) {
    const object = objectOf(reacted[2]!)
    return object && [...reacted[1]!].length <= 4 ? { reaction: reacted[1]!, removed: false, ...object } : null
  }
  const verb = line.match(VERB)
  if (verb) {
    const object = objectOf(verb[2]!)
    const reaction = VERBS.find(v => v.pattern === verb[1])!.reaction
    return object ? { reaction, removed: false, ...object } : null
  }
  return null
}

function normalize(text: string): string {
  return text.replace(/￼/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function mediaOf(mimeType: string | null): FallbackReaction['media'] {
  const type = mimeType ?? ''
  return type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : type.startsWith('audio/') ? 'audio' : 'attachment'
}

/** How far back a reaction's message can be: Messages only reacts to what is on screen. */
const LOOK_BACK = 400
const NOTE_WINDOW_MS = 12 * 60 * 60_000

/** "laughed at a video", "loved “See you at 6”": the note's verb and object. */
function describe(found: FallbackReaction): string {
  const verb: Record<string, string> = { '❤️': 'loved', '👍': 'liked', '👎': 'disliked', '😂': 'laughed at', '‼️': 'emphasized', '❓': 'questioned' }
  const object = found.quote !== null
    ? `“${found.quote.length > 60 ? `${found.quote.slice(0, 57).trimEnd()}…` : found.quote}”`
    : found.media === 'image' ? 'a photo' : found.media === 'video' ? 'a video' : found.media === 'audio' ? 'a voice message' : 'an attachment'
  const action = found.removed ? `took back a ${found.reaction} on` : verb[found.reaction] ?? `reacted ${found.reaction} to`
  // The message is not on this Mac; say so when it was a video or a photo,
  // which is what someone looks for and does not find.
  const missing = found.quote === null ? ' that is not on this device' : ''
  return `${action} ${object}${missing}`
}

function listNames(names: string[]): string {
  if (names.length <= 2)
    return names.join(' and ')
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/**
 * Read a conversation's written-out reactions back into reactions. Rows come
 * oldest first. Each one names its message by quoting it or by saying what
 * kind of attachment it was; the nearest earlier message that fits is it.
 * Reactions to the same thing whose message is not here become one note, at
 * the first of them.
 */
export function foldFallbackReactions(rows: ReadonlyArray<FoldableRow>): Folded {
  const folded: Folded = { reactions: [], hidden: new Set(), notes: new Map() }
  const groups = new Map<string, { anchor: string, at: number, names: string[], text: string }>()
  rows.forEach((row, index) => {
    if (row.kind !== 'message' || row.attachments.length > 0)
      return
    const found = parseFallbackReaction(row.text)
    if (!found)
      return
    let target: FoldableRow | undefined
    for (let i = index - 1; i >= 0 && i >= index - LOOK_BACK; i--) {
      const candidate = rows[i]!
      if (candidate.kind !== 'message' || folded.hidden.has(candidate.guid))
        continue
      if (found.quote !== null) {
        const said = normalize(candidate.text ?? '')
        const quoted = normalize(found.quote)
        if (said && (said === quoted || said.startsWith(quoted))) {
          target = candidate
          break
        }
      }
      else if (candidate.attachments.some(a => found.media === 'attachment' || mediaOf(a.mimeType) === found.media)) {
        target = candidate
        break
      }
    }
    folded.hidden.add(row.guid)
    const name = row.isFromMe ? 'You' : (row.senderName ?? 'Someone')
    if (target) {
      folded.reactions.push({ targetGuid: target.guid, reaction: found.reaction, removed: found.removed, isFromMe: row.isFromMe, senderName: row.senderName, sentAt: row.sentAt })
      return
    }
    const text = describe(found)
    const key = `${found.reaction}|${text}`
    const group = groups.get(key)
    if (group && row.sentAt - group.at <= NOTE_WINDOW_MS) {
      if (!group.names.includes(name))
        group.names.push(name)
      folded.notes.set(group.anchor, `${found.removed ? '' : `${found.reaction} `}${listNames(group.names)} ${text}`)
      return
    }
    groups.set(key, { anchor: row.guid, at: row.sentAt, names: [name], text })
    folded.notes.set(row.guid, `${found.removed ? '' : `${found.reaction} `}${name} ${text}`)
  })
  // A note's row is shown, as the note; every other reaction row is not.
  for (const guid of folded.notes.keys())
    folded.hidden.delete(guid)
  return folded
}
