import type { TranscriptMessage } from '../../app/Attic/archiver'

/** A pause or a change of day gets one timestamp, instead of one on every bubble. */
export function messageTimeline(messages: TranscriptMessage[]) {
  return messages.map((message, index) => {
    const previous = messages[index - 1]
    const sameDay = previous && new Date(previous.sentAt).toDateString() === new Date(message.sentAt).toDateString()
    const paused = !previous || !sameDay || message.sentAt - previous.sentAt > 5 * 60_000
    return { message, timestamp: paused, joined: !paused && previous?.isFromMe === message.isFromMe && previous?.sender === message.sender, sender: message.senderName || message.sender || '' }
  })
}

export function transcriptStamp(value: number, now = Date.now()): string {
  const date = new Date(value)
  const today = new Date(now)
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const day = date.toDateString() === today.toDateString() ? 'Today' : date.toDateString() === yesterday.toDateString() ? 'Yesterday' : date.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return `${day} ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}
