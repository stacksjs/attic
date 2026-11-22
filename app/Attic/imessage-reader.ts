import type { inbox } from '@stacksjs/chat'
import { inbox as chat } from '@stacksjs/chat'
import process from 'node:process'
import { addressBookDir, messagesDbPath } from './paths'

type Request =
  | { id: number, operation: 'conversations' }
  | { id: number, operation: 'messages', conversation: string, query?: inbox.MessageQuery }
type Reply = { id: number, entries: inbox.InboxConversation[] | inbox.InboxMessage[] } | { id: number, error: string }
type Pending = { resolve: (reply: Reply) => void, reject: (error: Error) => void }

/** Run the synchronous Messages history queries in a separate process. */
export function serveIMessageReads(): void {
  const driver = chat.createInboxDriver('imessage', {
    databasePath: messagesDbPath(),
    addressBookDir: addressBookDir() ?? false,
  })
  process.on('disconnect', () => process.exit(0))
  process.on('message', (request: Request) => {
    const result = request.operation === 'conversations'
      ? driver.conversations()
      : driver.messages(request.conversation, request.query)
    void result.then(
      entries => process.send?.({ id: request.id, entries } satisfies Reply),
      error => process.send?.({ id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies Reply),
    )
  })
}

export class IMessageReader {
  private child: ReturnType<typeof Bun.spawn> | undefined
  private readonly pending = new Map<number, Pending>()
  private next = 0

  private start(): ReturnType<typeof Bun.spawn> {
    const command = import.meta.path.startsWith('/$bunfs/')
      ? [process.execPath, '--imessage-reader']
      : [process.execPath, import.meta.path, '--imessage-reader-source']
    const child = Bun.spawn(command, {
      env: { ...process.env },
      stdio: ['ignore', 'ignore', 'inherit'],
      ipc: (reply: Reply) => {
        const request = this.pending.get(reply.id)
        this.pending.delete(reply.id)
        request?.resolve(reply)
      },
      onExit: () => {
        if (child !== this.child)
          return
        this.child = undefined
        this.failPending()
      },
    })
    return child
  }

  private async request(request: Request): Promise<inbox.InboxConversation[] | inbox.InboxMessage[]> {
    const child = this.child ??= this.start()
    const reply = await new Promise<Reply>((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject })
      try {
        child.send(request)
      }
      catch (error) {
        this.pending.delete(request.id)
        reject(error)
      }
    })
    if ('error' in reply)
      throw new Error(reply.error)
    return reply.entries
  }

  conversations(): Promise<inbox.InboxConversation[]> {
    return this.request({ id: ++this.next, operation: 'conversations' }) as Promise<inbox.InboxConversation[]>
  }

  messages(conversation: string, query?: inbox.MessageQuery): Promise<inbox.InboxMessage[]> {
    return this.request({ id: ++this.next, operation: 'messages', conversation, query }) as Promise<inbox.InboxMessage[]>
  }

  private failPending(): void {
    for (const request of this.pending.values())
      request.reject(new Error('The Messages history reader stopped.'))
    this.pending.clear()
  }

  close(): void {
    this.child?.kill()
    this.child = undefined
    this.failPending()
  }
}

if (process.argv.includes('--imessage-reader-source'))
  serveIMessageReads()
