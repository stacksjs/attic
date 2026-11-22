import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

const scratch = await mkdtemp('storage/.attic-site-')
const assets = [
  'app-icon.png',
  'screens/attic-inbox-light.webp',
  'screens/attic-inbox-dark.webp',
  'screens/attic-find-light.webp',
  'screens/attic-find-dark.webp',
]

try {
  const publicDir = join(scratch, 'public')
  await mkdir(join(publicDir, 'images/screens'), { recursive: true })
  // The staging entry has the same depth as resources/views/index.stx so its
  // package.json import resolves in both Buddy dev and the static build.
  await copyFile('resources/views/index.stx', join(scratch, 'index.stx'))
  await Promise.all(assets.map(asset => copyFile(join('public/images', asset), join(publicDir, 'images', asset))))

  const build = Bun.spawn([
    'bun', 'x', '--bun', 'stx', 'build',
    '--pages', scratch,
    '--public', publicDir,
    '--out', 'storage/attic/site',
    '--domain', 'https://attic.stacksjs.com',
  ], { stdout: 'inherit', stderr: 'inherit' })

  if (await build.exited !== 0)
    process.exitCode = 1
}
finally {
  await rm(scratch, { recursive: true, force: true })
}
