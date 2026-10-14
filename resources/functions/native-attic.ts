import type { NativeCraft, NativeDesktop } from '@stacksjs/stx/native'

export function nativeCraft(): NativeCraft {
  return (globalThis as unknown as { craft: NativeCraft }).craft
}

export function desktop(): NativeDesktop {
  const value = nativeCraft().desktop
  if (!value)
    throw new Error('Attic requires the Craft AppKit renderer.')
  return value
}

export async function nativeApi<T = any>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(path, nativeCraft().app.url).href, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  const data = await response.json()
  if (!response.ok)
    throw new Error(data.error || `Request failed (${response.status})`)
  return data as T
}

export function nativePost<T = any>(path: string, payload: unknown = {}): Promise<T> {
  return nativeApi<T>(path, { method: 'POST', body: JSON.stringify(payload) })
}

export function nativeEvents(handler: (event: Record<string, any>) => void | Promise<void>): () => void {
  const stream = new EventSource(new URL('/api/events', nativeCraft().app.url).href)
  stream.onmessage = (message) => {
    Promise.resolve(handler(JSON.parse(message.data))).catch(error => console.error(error.message))
  }
  return () => stream.close()
}

export function nativeDate(timestamp: number | null): string {
  if (!timestamp)
    return ''
  const date = new Date(timestamp)
  const today = new Date()
  if (date.toDateString() === today.toDateString())
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getMonth()]
  return `${month} ${date.getDate()}${date.getFullYear() === today.getFullYear() ? '' : `, ${date.getFullYear()}`}`
}

export const SOURCE_SYMBOLS = { imessage: 'message', whatsapp: 'phone.bubble', slack: 'number', discord: 'gamecontroller' }
export const SOURCE_NAMES = { imessage: 'Messages', whatsapp: 'WhatsApp', slack: 'Slack', discord: 'Discord' }

export function attachmentKind(mime: string | null): 'image' | 'video' | 'audio' | 'file' {
  return mime?.startsWith('image/') ? 'image' : mime?.startsWith('video/') ? 'video' : mime?.startsWith('audio/') ? 'audio' : 'file'
}
