import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

/**
 * Where Attic keeps its data. In `~/Library/Application Support`, never next
 * to the binary: an app in /Applications is not writable by its user and is
 * replaced wholesale on update, and an archive is the one thing that must
 * survive both.
 *
 * `ATTIC_DATA_DIR`, `ATTIC_MESSAGES_DB` and `ATTIC_WHATSAPP_DB` exist for
 * development and tests, so the app can run against fixtures without touching
 * the real databases.
 */
export const DATA_DIR = process.env.ATTIC_DATA_DIR || join(homedir(), 'Library', 'Application Support', 'Attic')
export const DATABASE_PATH = join(DATA_DIR, 'attic.sqlite')
export const ATTACHMENTS_DIR = join(DATA_DIR, 'Attachments')
/** JPEG renderings of HEIC photos, for viewers that cannot decode HEIC. Disposable. */
export const PREVIEWS_DIR = join(DATA_DIR, 'Previews')
export const PORT_FILE = join(DATA_DIR, 'port')
export const LOCK_FILE = join(DATA_DIR, 'attic.pid')
export const LOG_FILE = join(homedir(), 'Library', 'Logs', 'Attic.log')

export function messagesDbPath(): string {
  return process.env.ATTIC_MESSAGES_DB || join(homedir(), 'Library', 'Messages', 'chat.db')
}

/** WhatsApp for Mac's database; a fixture chat.db implies a fixture (or no) WhatsApp too. */
export function whatsappDbPath(): string {
  if (process.env.ATTIC_MESSAGES_DB && !process.env.ATTIC_WHATSAPP_DB)
    return join(DATA_DIR, 'no-whatsapp', 'ChatStorage.sqlite')
  return process.env.ATTIC_WHATSAPP_DB || join(homedir(), 'Library', 'Group Containers', 'group.net.whatsapp.WhatsApp.shared', 'ChatStorage.sqlite')
}

export function addressBookDir(): string | undefined {
  // A fixture chat.db implies fixture contacts, or none: never mix a test
  // conversation list with the real address book.
  if (process.env.ATTIC_MESSAGES_DB)
    return process.env.ATTIC_ADDRESS_BOOK_DIR
  return process.env.ATTIC_ADDRESS_BOOK_DIR || join(homedir(), 'Library', 'Application Support', 'AddressBook')
}
