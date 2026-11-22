import { dlopen, FFIType, ptr } from 'bun:ffi'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'

export function desktopNotifications(): ((id: string, title: string, body: string) => void) | undefined {
  if (process.platform !== 'darwin')
    return
  const name = 'attic-notifications.dylib'
  const library = [join(dirname(process.execPath), name), join(import.meta.dir, '../../storage/attic/bin', name)].find(path => existsSync(path))
  if (!library)
    return
  const native = dlopen(library, { texts_notify: { args: [FFIType.cstring, FFIType.cstring, FFIType.cstring], returns: FFIType.void } })
  return (id, title, body) => {
    const data = [id, title, body].map(value => Buffer.from(`${value.replace(/\0/g, '')}\0`))
    native.symbols.texts_notify(ptr(data[0]!), ptr(data[1]!), ptr(data[2]!))
  }
}
