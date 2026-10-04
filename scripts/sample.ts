/* eslint-disable no-console */
/**
 * Invented conversations for running Attic without anyone's real messages:
 * `bun run app:sample` builds them into storage/attic/sample and points the
 * app there (ATTIC_MESSAGES_DB, ATTIC_ADDRESS_BOOK_DIR, ATTIC_DATA_DIR), so
 * development, screenshots and QA never open the real chat.db.
 *
 * Every person, number and message here is made up.
 */
import { Database } from 'bun:sqlite'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createImageData, encode } from 'ts-images'
import { FakeChatDb } from '../app/Attic/sample-db'

const ROOT = join(import.meta.dir, '..', 'storage', 'attic', 'sample')
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const people = {
  maya: { name: ['Maya', 'Chen'], handle: '+14155550142' },
  jordan: { name: ['Jordan', 'Ellis'], handle: 'jordan.ellis@example.com' },
  sam: { name: ['Sam', 'Rivera'], handle: '+14155550178' },
  mom: { name: ['Mom', ''], handle: '+14155550101' },
  priya: { name: ['Priya', 'Nair'], handle: '+14155550199' },
} as const

function picture(label: string, from: string, to: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="340" viewBox="0 0 480 340">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
  <rect width="480" height="340" fill="url(#g)"/>
  <path d="M0 260 L120 150 L200 220 L300 110 L480 270 L480 340 L0 340 Z" fill="rgba(255,255,255,.35)"/>
  <text x="24" y="44" font-family="-apple-system, sans-serif" font-size="22" fill="white" font-weight="600">${label}</text>
</svg>`
}

/**
 * An invented contact photo: a two-tone gradient behind a head-and-shoulders
 * silhouette, as a PNG. Stored the way Contacts stores an inline photo (a
 * 0x01 tag, then the image), so sample mode exercises the real photo path.
 */
async function portrait(hue: number): Promise<Uint8Array> {
  const size = 128
  const image = createImageData(size, size)
  const rgb = (h: number, s: number, l: number): [number, number, number] => {
    const k = (n: number) => (n + h / 30) % 12
    const a = s * Math.min(l, 1 - l)
    const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
    return [f(0) * 255, f(8) * 255, f(4) * 255]
  }
  const [from, to, figure] = [rgb(hue, 0.55, 0.62), rgb((hue + 40) % 360, 0.6, 0.42), rgb(hue, 0.35, 0.9)]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size)
      const head = (x - 64) ** 2 + (y - 52) ** 2 < 22 ** 2
      const shoulders = ((x - 64) / 44) ** 2 + ((y - 128) / 40) ** 2 < 1
      const color = head || shoulders ? figure : [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t]
      const i = (y * size + x) * 4
      image.data[i] = color[0]!
      image.data[i + 1] = color[1]!
      image.data[i + 2] = color[2]!
      image.data[i + 3] = 255
    }
  }
  return encode(image, 'png')
}

async function addressBook(dir: string): Promise<void> {
  const folder = join(dir, 'Sources', 'SAMPLE')
  mkdirSync(folder, { recursive: true })
  const db = new Database(join(folder, 'AddressBook-v22.abcddb'), { create: true })
  db.exec(`
    CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZNICKNAME TEXT, ZORGANIZATION TEXT, ZTHUMBNAILIMAGEDATA BLOB, ZIMAGEDATA BLOB);
    CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER TEXT);
    CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS TEXT);
  `)
  let id = 0
  for (const person of Object.values(people)) {
    id++
    // Most sample contacts have a photo; one keeps its initials, as real ones do.
    const photo = id === 3 ? null : new Uint8Array([1, ...await portrait((id * 67) % 360)])
    db.query('INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME, ZTHUMBNAILIMAGEDATA) VALUES (?, ?, ?, ?)').run(id, person.name[0], person.name[1] || null, photo)
    if (person.handle.includes('@'))
      db.query('INSERT INTO ZABCDEMAILADDRESS (ZOWNER, ZADDRESS) VALUES (?, ?)').run(id, person.handle)
    else
      db.query('INSERT INTO ZABCDPHONENUMBER (ZOWNER, ZFULLNUMBER) VALUES (?, ?)').run(id, person.handle.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3'))
  }
  db.close()
}

export async function buildSample(root = ROOT): Promise<{ chatDb: string, addressBook: string, data: string }> {
  rmSync(root, { recursive: true, force: true })
  const chat = new FakeChatDb(join(root, 'Messages'))
  const now = Date.now()
  const at = (ago: number) => now - ago

  // An old thread, the classic archive candidate.
  const sam = chat.direct(people.sam.handle)
  chat.add(sam, { text: 'Did you ever find a mover for the couch?', at: at(41 * DAY) })
  chat.add(sam, { text: 'Not yet. Everyone wants $300 for one couch.', fromMe: true, at: at(41 * DAY - 20 * MINUTE) })
  chat.add(sam, { text: 'My cousin has a van, I can ask', at: at(40 * DAY) })
  const thanks = chat.add(sam, { text: 'That would be amazing, thank you', fromMe: true, at: at(40 * DAY - 5 * MINUTE) })
  chat.add(sam, { text: 'Loved “That would be amazing, thank you”', reaction: { type: 2000, target: thanks }, at: at(40 * DAY - 4 * MINUTE) })

  // A busy group with a photo and reactions.
  const crew = chat.group('chat481516', [people.maya.handle, people.jordan.handle, people.priya.handle], { name: 'Climbing crew', groupId: 'SAMPLE-GROUP-CLIMB' })
  chat.add(crew, { text: 'Bouldering Thursday at 7?', sender: people.maya.handle, at: at(3 * DAY) })
  chat.add(crew, { text: 'In, but I might be 15 late', sender: people.jordan.handle, at: at(3 * DAY - 10 * MINUTE) })
  chat.add(crew, { text: 'Same, see you there', fromMe: true, at: at(3 * DAY - 12 * MINUTE) })
  const photo = chat.add(crew, { text: 'New problem on the overhang', sender: people.priya.handle, at: at(2 * DAY), attachment: { name: 'IMG_2041.svg', mime: 'image/svg+xml', bytes: picture('V4 on the overhang', '#ff7a59', '#7b5cff') } })
  chat.add(crew, { text: 'Emphasized an image', reaction: { type: 2004, target: photo }, sender: people.maya.handle, at: at(2 * DAY - 3 * MINUTE) })
  chat.add(crew, { text: 'Liked an image', reaction: { type: 2001, target: photo }, fromMe: true, at: at(2 * DAY - 2 * MINUTE) })
  chat.add(crew, { text: 'That one is going to hurt', sender: people.jordan.handle, at: at(2 * DAY - MINUTE) })

  // Today's conversations, one unread.
  const maya = chat.direct(people.maya.handle)
  chat.add(maya, { text: 'Are we still on for the farmers market tomorrow?', at: at(5 * HOUR) })
  chat.add(maya, { text: 'Yes! 9ish?', fromMe: true, at: at(5 * HOUR - 4 * MINUTE) })
  chat.add(maya, { text: 'Perfect. I will bring the big bags', at: at(40 * MINUTE), read: false })

  const mom = chat.direct(people.mom.handle)
  chat.add(mom, { text: 'Call me when you get a chance, nothing urgent', at: at(26 * HOUR) })
  chat.add(mom, { text: 'Will do tonight', fromMe: true, at: at(25 * HOUR) })

  // Verification codes and deliveries: noise nobody wants in the list.
  const shortCode = chat.direct('22395', 'SMS')
  chat.add(shortCode, { text: 'Your verification code is 482913. Do not share it with anyone.', at: at(9 * DAY) })
  chat.add(shortCode, { text: 'Your verification code is 105377. Do not share it with anyone.', at: at(6 * DAY) })
  const courier = chat.direct('+14155550123', 'SMS')
  chat.add(courier, { text: 'Your package is out for delivery and will arrive between 2 and 6 pm.', at: at(12 * DAY) })
  chat.add(courier, { text: 'Delivered: your package was left at the front door.', at: at(12 * DAY - 3 * HOUR) })

  const jordan = chat.direct(people.jordan.handle)
  chat.add(jordan, { text: 'Sending the slides tonight', at: at(16 * DAY) })
  chat.add(jordan, { text: 'Here they are', at: at(16 * DAY - 2 * HOUR), attachment: { name: 'Quarterly review.key', mime: 'application/x-iwork-keynote-sffkey', bytes: 'not really a keynote file' } })
  chat.add(jordan, { text: 'Thanks, looks great', fromMe: true, at: at(16 * DAY - HOUR) })

  chat.close()
  const book = join(root, 'AddressBook')
  await addressBook(book)
  const data = join(root, 'Attic')
  mkdirSync(data, { recursive: true })
  writeFileSync(join(root, 'README.txt'), 'Invented conversations for running Attic in development. Nothing here is real.\n')
  return { chatDb: join(root, 'Messages', 'chat.db'), addressBook: book, data }
}

if (import.meta.main) {
  const sample = buildSample()
  console.log(`ATTIC_MESSAGES_DB=${sample.chatDb}`)
  console.log(`ATTIC_ADDRESS_BOOK_DIR=${sample.addressBook}`)
  console.log(`ATTIC_DATA_DIR=${sample.data}`)
}
