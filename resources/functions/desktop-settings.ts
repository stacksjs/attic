import { nativeWindow } from '@stacksjs/desktop/browser'

/** Craft's native navigation needs an absolute URL and shared app cookies. */
export function openSettingsWindow(): Promise<{ name: string }> {
  return nativeWindow.open({
    name: 'settings',
    url: new URL('/settings', globalThis.location.href).href,
    title: 'Settings',
    width: 560,
    height: 620,
    minWidth: 480,
    minHeight: 420,
    minimizable: false,
    persistentStorage: true,
  })
}
