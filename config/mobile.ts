import type { MobileConfig } from '@stacksjs/types'

/**
 * Attic on the phone: the `mobile` page (resources/views/mobile.stx) bundled
 * into a native app. It keeps its own copy of the archive in Craft's SQLite
 * and syncs with the paired Mac on the local network, so it needs secure
 * storage for the pairing key, the local database, the QR scanner to pair,
 * and local network access. Build with `bun run build:ios` / `build:android`.
 */
const capabilities = {
  haptics: true,
  share: true,
  secureStorage: true,
  localDatabase: true,
  qrScanner: true,
  localNetwork: true,
  clipboard: true,
  deepLinks: true,
}

export default {
  ios: {
    appName: 'Attic',
    bundleId: 'com.stacksjs.attic.mobile',
    version: '0.2.0',
    buildNumber: '1',
    deploymentTarget: '16.0',
    webAssets: 'storage/attic/mobile',
    appearance: 'system',
    backgroundColor: '#f2f2f7',
    backgroundColorDark: '#000000',
    orientations: ['portrait'],
    // Scanning the Mac's pairing QR code opens attic://pair/…
    urlSchemes: ['attic'],
    capabilities,
  },
  android: {
    appName: 'Attic',
    packageName: 'com.stacksjs.attic',
    version: '0.2.0',
    versionCode: 1,
    webAssets: 'storage/attic/mobile',
    darkMode: true,
    backgroundColor: '#f2f2f7',
    urlSchemes: ['attic'],
    capabilities,
  },
} satisfies MobileConfig
