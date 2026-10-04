/**
 * The envelope a paired phone and the Mac exchange over the local network.
 *
 * Pairing hands the phone a random 256-bit key in a QR code, shown only on
 * the Mac's own screen. Every request and response after that is AES-256-GCM
 * sealed with it, the device id bound in as additional data, so messages
 * never cross the network in the clear and a request cannot be replayed to
 * another device. The same code runs in the agent (Bun) and on the phone
 * (WebCrypto in the app's web view).
 */

export interface Sealed {
  /** 12-byte nonce, base64url. */
  n: string
  /** Ciphertext with its tag, base64url. */
  c: string
}

export interface Pairing {
  /** The Mac's address on the local network, and the port Attic listens on there. */
  host: string
  port: number
  /** The id the Mac gave this phone, and the key only the two of them hold. */
  device: string
  key: string
  /** The Mac's name, to show on the phone. */
  name: string
}

const PAIRING_PREFIX = 'attic-pair:1:'

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes)
    binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  return Uint8Array.from(binary, ch => ch.charCodeAt(0))
}

export function randomKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function seal(key: Uint8Array, aad: string, value: unknown): Promise<Sealed> {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const plain = new TextEncoder().encode(JSON.stringify(value))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(aad) }, await aesKey(key), plain)
  return { n: toBase64Url(nonce), c: toBase64Url(new Uint8Array(cipher)) }
}

/** The sealed value, or a thrown error when the key, the device or the bytes do not match. */
export async function unseal<T = unknown>(key: Uint8Array, aad: string, sealed: Sealed): Promise<T> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(sealed.n) as BufferSource, additionalData: new TextEncoder().encode(aad) },
    await aesKey(key),
    fromBase64Url(sealed.c) as BufferSource,
  )
  return JSON.parse(new TextDecoder().decode(plain)) as T
}

export function encodePairing(pairing: Pairing): string {
  return PAIRING_PREFIX + toBase64Url(new TextEncoder().encode(JSON.stringify(pairing)))
}

/** The pairing in a scanned QR code or a pasted code, or null when it is not one. */
export function decodePairing(text: string): Pairing | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith(PAIRING_PREFIX))
    return null
  try {
    const value = JSON.parse(new TextDecoder().decode(fromBase64Url(trimmed.slice(PAIRING_PREFIX.length)))) as Pairing
    return typeof value.host === 'string' && typeof value.port === 'number' && typeof value.device === 'string' && typeof value.key === 'string' ? value : null
  }
  catch {
    return null
  }
}
