import type { inbox } from '@stacksjs/chat'
import { describe, expect, it } from 'bun:test'
import { parseWorkspaces, SlackWorkspaces, upsertWorkspace } from '../../../app/Attic/slack-workspaces'

/** A workspace with the given conversations, recording what is asked of it. */
function workspace(team: string, ids: string[], calls: string[]): inbox.InboxDriver {
  const conversation = (id: string): inbox.InboxConversation => ({
    provider: 'slack',
    id,
    kind: 'direct',
    title: null,
    participants: [],
    workspace: team,
    lastMessageAt: 1,
    preview: null,
    previewFromMe: false,
    unread: 0,
    cursor: '1',
    visible: true,
    archive: { mode: 'native', detail: '' },
    url: null,
  })
  return {
    provider: 'slack',
    label: 'Slack',
    status: async () => ({ connected: true, detail: `Signed in to ${team}.` }),
    conversations: async () => ids.map(conversation),
    messages: async (id) => {
      calls.push(`${team} messages ${id}`)
      return [{ id: 'm1', conversationId: id, kind: 'message', text: 'hi', fromMe: false, sentAt: 1, sender: null, targetId: null, reaction: null, reactionRemoved: false, replyToId: null, editedAt: null, unsent: false, attachments: [{ id: `${team}-file`, name: 'f', mimeType: null, bytes: 1, path: null, url: 'https://files.slack.com/x' }], cursor: '1' }]
    },
    archive: async (id) => {
      calls.push(`${team} archive ${id}`)
      return { mode: 'native', removed: true, detail: '' }
    },
    unarchive: async () => {},
    attachment: async (a) => {
      calls.push(`${team} attachment ${a.id}`)
      return new Response(team)
    },
    send: async (id) => {
      calls.push(`${team} send ${id}`)
      return { id: 'sent', sentAt: 1 }
    },
  }
}

describe('slack workspaces', () => {
  it('lists every workspace and sends each action to the conversation\'s own', async () => {
    const calls: string[] = []
    const slack = new SlackWorkspaces([workspace('Acme', ['D1', 'C1'], calls), workspace('Side', ['D2'], calls)])
    expect((await slack.conversations()).map(c => `${c.workspace}:${c.id}`)).toEqual(['Acme:D1', 'Acme:C1', 'Side:D2'])
    await slack.send('D2', { text: 'hello' })
    await slack.archive('C1')
    await slack.messages('D2')
    expect(await (await slack.attachment({ id: 'Side-file', name: 'f', mimeType: null, bytes: 1, path: null, url: 'https://files.slack.com/x' })).text()).toBe('Side')
    expect(calls).toEqual(['Side send D2', 'Acme archive C1', 'Side messages D2', 'Side attachment Side-file'])
    expect(await slack.status()).toEqual({ connected: true, detail: 'Acme, Side.' })
  })

  it('finds a conversation\'s workspace before anything has been listed', async () => {
    const calls: string[] = []
    const slack = new SlackWorkspaces([workspace('Acme', ['D1'], calls), workspace('Side', ['D2'], calls)])
    await slack.messages('D2')
    expect(calls).toEqual(['Side messages D2'])
    await expect(slack.archive('NOPE')).rejects.toThrow('not in any signed-in workspace')
  })

  it('keeps one entry per workspace in the keychain list', () => {
    const list = upsertWorkspace(upsertWorkspace([], { teamId: 'T1', team: 'Acme', token: 'a' }), { teamId: 'T2', team: 'Side', token: 'b' })
    const replaced = upsertWorkspace(list, { teamId: 'T1', team: 'Acme', token: 'a2', appToken: 'x' })
    expect(replaced.map(w => `${w.teamId}:${w.token}`)).toEqual(['T2:b', 'T1:a2'])
    expect(parseWorkspaces(JSON.stringify(replaced))).toEqual(replaced)
    expect(parseWorkspaces('not json')).toEqual([])
    expect(parseWorkspaces(JSON.stringify([{ team: 'no id' }]))).toEqual([])
  })
})
