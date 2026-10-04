/* eslint-disable no-console */
/**
 * The phone app's bundled web assets: the built `mobile` page as index.html,
 * with the stx runtime, styles and images it loads. `bun run build:ui` builds
 * every page into storage/attic/web; Craft bundles storage/attic/mobile into
 * the iOS and Android apps (config/mobile.ts `webAssets`).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const web = join(root, 'storage', 'attic', 'web')
const out = join(root, 'storage', 'attic', 'mobile')

if (!existsSync(join(web, 'mobile.html')))
  throw new Error('storage/attic/web/mobile.html is missing: run `bun run build:ui` first')

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'index.html'), readFileSync(join(web, 'mobile.html')))
for (const dir of ['_stx', 'images', 'fonts', 'svgs']) {
  if (existsSync(join(web, dir)))
    cpSync(join(web, dir), join(out, dir), { recursive: true })
}
console.log(`Phone app assets in ${out}`)
