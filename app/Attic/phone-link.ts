/* eslint-disable no-console */
import type { Server } from 'bun'
import type { Pairing, Sealed } from '../../resources/functions/sealed'
import type { ArchiveStore } from './store'
import { randomBytes } from 'node:crypto'
import { hostname, networkInterfaces } from 'node:os'
import { toSvg } from 'ts-qr-codes'
import { encodePairing, randomKey, toBase64Url, unseal, seal } from '../../resources/functions/sealed'

/**
 * The phone app's way in. A paired phone keeps its own copy of the archive
 * and reaches the Mac over the local network: one POST endpoint that only
 * answers AES-GCM sealed requests from a paired device (see
 * resources/functions/sealed.ts). It listens on the network only once a phone
 * is paired, and never serves the window's own API.
 */

/** What a paired phone can ask for. */
export interface PhoneOps {
  hello: () => Promise<unknown>
  pull: (since: number) => Promise<unknown>
  inbox: () => Promise<unknown>
  archive: (key: string) => Promise<unknown>
  unarchive: (key: string) => Promise<unknown>
  avatar: (url: string) => Promise<{ type: string, data: string } | null>
}

interface Request {
  op: keyof PhoneOps
  /** When the phone sent it (Unix ms); stale requests are refused. */
  t: number
  /** A one-time id, so a captured request cannot be replayed. */
  r: string
  since?: number
  key?: string
  url?: string
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
}

/** How far a request's clock may be from the Mac's. */
const MAX_SKEW_MS = 5 * 60_000
export const DEFAULT_PHONE_PORT = 47_630

/** The Mac's address on the local network: Wi-Fi or Ethernet first. */
export function lanAddress(): string | null {
  const interfaces = networkInterfaces()
  const order = Object.keys(interfaces).sort((a, b) => Number(!a.startsWith('en')) - Number(!b.startsWith('en')) || a.localeCompare(b))
  for (const name of order) {
    for (const address of interfaces[name] ?? []) {
      if (address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.'))
        return address.address
    }
  }
  return null
}

export class PhoneLink {
  private server: Server<undefined> | null = null
  private seen = new Map<string, number>()

  constructor(
    private readonly store: ArchiveStore,
    private readonly ops: PhoneOps,
    private readonly port = DEFAULT_PHONE_PORT,
  ) {}

  get listening(): number | null {
    return this.server?.port ?? null
  }

  /** Listen on the local network; only while at least one phone is paired. */
  start(): void {
    if (this.server || this.store.devices().length === 0)
      return
    try {
      this.server = Bun.serve({ hostname: '0.0.0.0', port: this.port, fetch: req => this.handle(req) })
      console.log(`[attic] phone link on port ${this.server.port}`)
    }
    catch (error) {
      console.error(`[attic] phone link could not listen: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  stop(): void {
    this.server?.stop(true)
    this.server = null
  }

  /**
   * Pair a new phone: a device id and key, and the QR code carrying them
   * with the Mac's address. Only the Mac's own window can ask for this.
   */
  pair(name = 'Phone'): { code: string, svg: string, pairing: Pairing } | { error: string } {
    const host = lanAddress()
    if (!host)
      return { error: 'This Mac is not on a network the phone can reach.' }
    const device = toBase64Url(new Uint8Array(randomBytes(12)))
    const key = randomKey()
    this.store.addDevice({ id: device, name, key })
    this.start()
    const pairing: Pairing = { host, port: this.listening ?? this.port, device, key: toBase64Url(key), name: hostname().replace(/\.local$/, '') }
    const code = encodePairing(pairing)
    return { code, svg: toSvg(code), pairing }
  }

  forget(id: string): void {
    this.store.revokeDevice(id)
    if (this.store.devices().length === 0)
      this.stop()
  }

  /** One sealed request in, one sealed response out; anything else is refused. */
  async handle(req: globalThis.Request): Promise<Response> {
    const url = new URL(req.url)
    // The phone's page is another origin. Every request is sealed with the
    // device's key, so letting any origin send one grants nothing.
    if (req.method === 'OPTIONS' && url.pathname === '/sync')
      return new Response(null, { status: 204, headers: CORS })
    if (req.method !== 'POST' || url.pathname !== '/sync')
      return new Response('Not found', { status: 404 })
    const response = await this.answer(req)
    for (const [name, value] of Object.entries(CORS))
      response.headers.set(name, value)
    return response
  }

  private async answer(req: globalThis.Request): Promise<Response> {
    let body: { d?: string } & Partial<Sealed>
    try {
      body = await req.json() as typeof body
    }
    catch {
      return new Response('Bad request', { status: 400 })
    }
    const device = body.d ? this.store.device(body.d) : null
    if (!device || !body.n || !body.c)
      return new Response('Unknown device', { status: 403 })

    let request: Request
    try {
      request = await unseal<Request>(device.key, device.id, { n: body.n, c: body.c })
    }
    catch {
      return new Response('Unknown device', { status: 403 })
    }
    if (!this.fresh(device.id, request))
      return new Response('Stale request', { status: 409 })

    this.store.touchDevice(device.id)
    let reply: unknown
    try {
      reply = { ok: true, result: await this.run(request) }
    }
    catch (error) {
      reply = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    return Response.json(await seal(device.key, device.id, reply))
  }

  private fresh(device: string, request: Request): boolean {
    const now = Date.now()
    if (typeof request.t !== 'number' || Math.abs(now - request.t) > MAX_SKEW_MS || typeof request.r !== 'string')
      return false
    const id = `${device}:${request.r}`
    if (this.seen.has(id))
      return false
    this.seen.set(id, now)
    // Forget ids older than the skew window: those requests are refused as stale anyway.
    if (this.seen.size > 5000) {
      for (const [seenId, at] of this.seen) {
        if (now - at > MAX_SKEW_MS)
          this.seen.delete(seenId)
      }
    }
    return true
  }

  private run(request: Request): Promise<unknown> {
    switch (request.op) {
      case 'hello': return this.ops.hello()
      case 'pull': return this.ops.pull(Number(request.since) || 0)
      case 'inbox': return this.ops.inbox()
      case 'archive': return this.ops.archive(String(request.key ?? ''))
      case 'unarchive': return this.ops.unarchive(String(request.key ?? ''))
      case 'avatar': return this.ops.avatar(String(request.url ?? ''))
      default: throw new Error(`Unknown request ${String(request.op)}`)
    }
  }
}
