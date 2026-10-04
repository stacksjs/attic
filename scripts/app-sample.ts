/**
 * `bun run app:sample`: Attic against invented conversations (scripts/sample.ts),
 * with its own data directory, so nothing real is read or written.
 */
import process from 'node:process'
import { buildSample } from './sample'

const sample = buildSample()
const child = Bun.spawn(['bun', 'app/Desktop/launcher.ts'], {
  stdio: ['inherit', 'inherit', 'inherit'],
  env: {
    ...process.env,
    ATTIC_MESSAGES_DB: sample.chatDb,
    ATTIC_ADDRESS_BOOK_DIR: sample.addressBook,
    ATTIC_DATA_DIR: sample.data,
  },
})
process.exit(await child.exited)
