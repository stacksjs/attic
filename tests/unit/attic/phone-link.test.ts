import type { PhoneOps } from '../../../app/Attic/phone-link'
import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PhoneLink } from '../../../app/Attic/phone-link'
import { ArchiveStore } from '../../../app/Attic/store'
import { decodePairing, fromBase64Url, pairingLink, seal, unseal } from '../../../resources/functions/sealed'

function setup() {
  const store = new ArchiveStore(join(mkdtempSync(join(tmpdir(), 'attic-phone-')), 'attic.sqlite'))
  const calls: string[] = []
  const ops: PhoneOps = {
    hello: async () => ({ name: 'Mac' }),
    pull: async since => ({ since }),
    inbox: async () => [],
    archive: async (key) => { calls.push(`archive ${key}`); return { ok: true } },
    unarchive: async key => ({ key }),
    avatar: async () => null,
  }
  // Port 0: an ephemeral port, so tests never collide with a running Attic.
  const link = new PhoneLink(store, ops, 0)
  return { store, link, calls }
}

async function ask(link: PhoneLink, device: string, key: Uint8Array, request: Record<string, unknown>, tamper = false) {
  const sealed = await seal(key, device, request)
  const body = { d: device, ...sealed, c: tamper ? `${sealed.c.slice(0, -2)}AA` : sealed.c }
  const response = await link.handle(new Request('http://mac.local/sync', { method: 'POST', body: JSON.stringify(body) }))
  return { status: response.status, reply: response.ok ? await unseal<{ ok: boolean, result?: unknown, error?: string }>(key, device, await response.json() as never) : null }
}

describe('phone link', () => {
  it('pairs through a code that carries the address and a fresh key, and answers sealed requests', async () => {
    const { link } = setup()
    const paired = link.pair('Chris\'s iPhone')
    if ('error' in paired)
      throw new Error(paired.error)
    expect(paired.svg).toStartWith('<svg')
    const pairing = decodePairing(paired.code)!
    expect(pairing.device).toBe(paired.pairing.device)
    const key = fromBase64Url(pairing.key)
    expect(key).toHaveLength(32)
    // The QR code carries the same pairing as a link the camera can open.
    expect(decodePairing(pairingLink(pairing))).toEqual(pairing)
    expect(decodePairing('https://example.com/attic')).toBeNull()

    const hello = await ask(link, pairing.device, key, { op: 'hello', t: Date.now(), r: 'one' })
    expect(hello).toEqual({ status: 200, reply: { ok: true, result: { name: 'Mac' } } })
    const pull = await ask(link, pairing.device, key, { op: 'pull', t: Date.now(), r: 'two', since: 41 })
    expect(pull.reply).toEqual({ ok: true, result: { since: 41 } })
    link.stop()
  })

  it('refuses replays, stale clocks, tampering, strangers and forgotten phones', async () => {
    const { link, calls } = setup()
    const paired = link.pair()
    if ('error' in paired)
      throw new Error(paired.error)
    const { device } = paired.pairing
    const key = fromBase64Url(paired.pairing.key)

    const request = { op: 'archive', key: 'imessage:direct:+15550001111', t: Date.now(), r: 'same' }
    expect((await ask(link, device, key, request)).status).toBe(200)
    expect((await ask(link, device, key, request)).status).toBe(409)
    expect(calls).toHaveLength(1)

    expect((await ask(link, device, key, { op: 'hello', t: Date.now() - 10 * 60_000, r: 'old' })).status).toBe(409)
    expect((await ask(link, device, key, { op: 'hello', t: Date.now(), r: 'bent' }, true)).status).toBe(403)
    expect((await ask(link, 'not-a-device', key, { op: 'hello', t: Date.now(), r: 'who' })).status).toBe(403)
    expect((await ask(link, device, new Uint8Array(32), { op: 'hello', t: Date.now(), r: 'wrong key' })).status).toBe(403)

    // The phone's page is another origin: preflight is answered, replies readable.
    const preflight = await link.handle(new Request('http://mac.local/sync', { method: 'OPTIONS' }))
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
    expect((await link.handle(new Request('http://mac.local/api/status'))).status).toBe(404)

    link.forget(device)
    expect((await ask(link, device, key, { op: 'hello', t: Date.now(), r: 'after' })).status).toBe(403)
    expect(link.listening).toBeNull()
  })
})
