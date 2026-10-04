import type { inbox } from '@stacksjs/chat'

/**
 * Invented WhatsApp, Slack and Discord conversations for `bun run
 * app:sample`, so the whole inbox can be worked on, demonstrated and
 * screenshotted without anyone's tokens or anyone's WhatsApp. Archiving
 * behaves as the real drivers do: a WhatsApp chat archives, a Slack DM
 * closes, a Discord thread archives, and a Discord channel says it cannot.
 * Every name and message here is made up.
 */

type Driver = inbox.InboxDriver
type Conversation = inbox.InboxConversation
type Message = inbox.InboxMessage

interface SampleThread {
  conversation: Omit<Conversation, 'cursor' | 'lastMessageAt' | 'preview' | 'previewFromMe'>
  messages: Array<{ text: string, from: { id: string, name: string } | null, minutesAgo: number }>
}

class SampleDriver implements Driver {
  private hidden = new Set<string>()

  constructor(
    readonly provider: 'whatsapp' | 'slack' | 'discord',
    readonly label: string,
    private threads: SampleThread[],
  ) {}

  private messagesOf(thread: SampleThread): Message[] {
    const now = Date.now()
    return thread.messages.map((m, index) => {
      const sentAt = now - m.minutesAgo * 60_000
      return {
        id: `${thread.conversation.id}-${index}`,
        conversationId: thread.conversation.id,
        kind: 'message',
        text: m.text,
        fromMe: m.from === null,
        sentAt,
        sender: m.from,
        targetId: null,
        reaction: null,
        reactionRemoved: false,
        replyToId: null,
        editedAt: null,
        unsent: false,
        attachments: [],
        cursor: String(1_000_000 + index),
      }
    })
  }

  async status() {
    return { connected: true, detail: `Sample ${this.label} data.` }
  }

  async conversations(): Promise<Conversation[]> {
    return this.threads.map((thread) => {
      const messages = this.messagesOf(thread)
      const last = messages.at(-1)
      return {
        ...thread.conversation,
        cursor: last?.cursor ?? '0',
        lastMessageAt: last?.sentAt ?? null,
        preview: last?.text ?? null,
        previewFromMe: !!last?.fromMe,
        visible: !this.hidden.has(thread.conversation.id),
      }
    })
  }

  async messages(id: string, query: inbox.MessageQuery = {}): Promise<Message[]> {
    const thread = this.threads.find(t => t.conversation.id === id)
    if (!thread)
      return []
    const after = Number(query.after ?? 0)
    const all = this.messagesOf(thread).filter(m => Number(m.cursor) > after)
    return query.limit && !query.after ? all.slice(-query.limit) : all
  }

  async archive(id: string): Promise<inbox.ArchiveOutcome> {
    const thread = this.threads.find(t => t.conversation.id === id)!
    if (thread.conversation.archive.mode !== 'native')
      return { mode: thread.conversation.archive.mode, removed: false, detail: thread.conversation.archive.detail }
    this.hidden.add(id)
    return { mode: 'native', removed: true, detail: thread.conversation.archive.detail }
  }

  async unarchive(id: string): Promise<void> {
    this.hidden.delete(id)
  }

  async attachment(): Promise<Response> {
    return new Response('Not found', { status: 404 })
  }
}

const priya = { id: 'U0PRIYA', name: 'Priya Nair' }
const dev = { id: 'U0DEV', name: 'Dev Okafor' }
const lena = { id: 'U0LENA', name: 'Lena Brandt' }
const ann = { id: '4401', name: 'ann' }
const kofi = { id: '4402', name: 'kofi' }

const rosa = { id: '15550007777@s.whatsapp.net', name: 'Rosa Lindqvist' }
const tomas = { id: '15550008888@s.whatsapp.net', name: 'Tomás Ferreira' }
const WHATSAPP_ARCHIVE = { mode: 'native' as const, detail: 'Archives the chat in WhatsApp. WhatsApp brings it back when a new message arrives, unless Keep chats archived is on.' }

export function sampleWhatsApp(): Driver {
  return new SampleDriver('whatsapp', 'WhatsApp', [
    {
      conversation: { provider: 'whatsapp', id: rosa.id, kind: 'direct', title: null, participants: [rosa], workspace: null, unread: 2, visible: true, url: null, archive: WHATSAPP_ARCHIVE },
      messages: [
        { text: 'Landed! The ferry is at 4', from: rosa, minutesAgo: 95 },
        { text: 'I will meet you at the pier', from: null, minutesAgo: 90 },
        { text: 'Bring a jacket, it is windy here', from: rosa, minutesAgo: 12 },
      ],
    },
    {
      conversation: { provider: 'whatsapp', id: '120363000000000002@g.us', kind: 'group', title: 'Family', participants: [rosa, tomas], workspace: null, unread: 0, visible: true, url: null, archive: WHATSAPP_ARCHIVE },
      messages: [
        { text: 'Sunday lunch at ours?', from: tomas, minutesAgo: 3000 },
        { text: 'Yes! I will bake', from: null, minutesAgo: 2950 },
      ],
    },
  ])
}

export function sampleSlack(): Driver {
  return new SampleDriver('slack', 'Slack', [
    {
      conversation: { provider: 'slack', id: 'D0PRIYA', kind: 'direct', title: null, participants: [priya], workspace: 'Northwind', unread: 1, visible: true, url: null, archive: { mode: 'native', detail: 'Closes the conversation in Slack. Slack reopens it when someone writes.' } },
      messages: [
        { text: 'Do you have the final copy for the onboarding emails?', from: priya, minutesAgo: 190 },
        { text: 'Sending it over after lunch', from: null, minutesAgo: 185 },
        { text: 'Perfect, thank you!', from: priya, minutesAgo: 25 },
      ],
    },
    {
      conversation: { provider: 'slack', id: 'C0DESIGN', kind: 'channel', title: '#design-review', participants: [], workspace: 'Northwind', unread: 3, visible: true, url: null, archive: { mode: 'native', detail: 'Leaves the channel in Slack, and rejoins it if you unarchive.' } },
      messages: [
        { text: 'New settings screens are up in the review board', from: lena, minutesAgo: 300 },
        { text: 'The spacing on the toggles looks much better', from: dev, minutesAgo: 120 },
      ],
    },
  ])
}

export function sampleDiscord(): Driver {
  return new SampleDriver('discord', 'Discord', [
    {
      conversation: { provider: 'discord', id: 'T0TRIP', kind: 'thread', title: 'Trip planning', participants: [], workspace: 'Weekend Climbers', unread: 0, visible: true, url: null, archive: { mode: 'native', detail: 'Archives the thread in Discord. It reopens when someone posts.' } },
      messages: [
        { text: 'Campsite is booked for the 14th', from: ann, minutesAgo: 2000 },
        { text: 'Who is bringing the stove?', from: kofi, minutesAgo: 1440 },
      ],
    },
    {
      conversation: { provider: 'discord', id: 'C0GENERAL', kind: 'channel', title: '#general', participants: [], workspace: 'Weekend Climbers', unread: 0, visible: true, url: null, archive: { mode: 'unsupported', detail: 'Discord cannot hide a channel for one person, so it stays in Discord.' } },
      messages: [
        { text: 'Gym is closed Monday for resetting', from: kofi, minutesAgo: 4300 },
      ],
    },
  ])
}
