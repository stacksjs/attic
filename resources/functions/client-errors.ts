/**
 * Send the window's uncaught errors to the agent, which writes them to
 * Attic's log. A release build has no devtools, so without this a page that
 * stops updating fails in silence.
 */
export function reportClientErrors(): void {
  if (typeof window === 'undefined')
    return
  const send = (message: string, stack?: string, source = 'page'): void => {
    try {
      void fetch('/api/client-error', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, stack, source }),
      })
    }
    catch {}
  }
  window.addEventListener('error', event => send(event.message, event.error?.stack, `${event.filename ?? ''}:${event.lineno ?? ''}`))
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason as { message?: string, stack?: string } | string | undefined
    send(typeof reason === 'string' ? reason : reason?.message ?? 'Unhandled rejection', typeof reason === 'string' ? undefined : reason?.stack, 'promise')
  })
  // stx reports a binding that throws on the console and carries on.
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      const error = args.find(a => a instanceof Error) as Error | undefined
      send(args.map(a => (a instanceof Error ? a.message : String(a))).join(' ').slice(0, 500), error?.stack, `console.${level}`)
    }
  }
}
