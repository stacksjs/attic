import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'

/**
 * stx plugin deciding which file a shared component name resolves to.
 *
 * Attic replaces the scaffolded
 * `storage/framework/defaults/stx-components-plugin.ts` with this, because the
 * two apps want opposite answers for the same tag. That plugin lists the
 * framework's own `resources/components` ahead of the package root, so
 * `<Button>` and `<Avatar>` resolve to `Dashboard/UI/`. For a dashboard that is
 * right (see stacksjs/stacks#2927, where the package's `<EmptyState>` printed
 * an Iconify class as text). Attic serves none of those views: its screens and
 * views are written against the design system in `@stacksjs/components`, and
 * the framework's are web-only. `Dashboard/UI/Button.stx` carries
 * `aria-disabled:` variants, `shadow-blue-600/25` and an
 * `i-hugeicons-loading-03` spinner, none of which the native renderer knows, so
 * every `<Button>` on a native screen became a compile diagnostic and
 * `bun run build:native` refused to produce a binary.
 *
 * So the order below is the package first, then the framework's components as a
 * floor for everything Attic does not define. The app's own
 * `resources/components` is searched ahead of both through `componentsDir` in
 * `config/ui.ts`, so `<AtticSidebar>` and friends are unaffected.
 *
 * If Attic ever serves the framework's dashboard or auth views, revisit this:
 * those views expect the framework's components to win.
 */
const root = resolve(import.meta.dir, '../..')

/**
 * `STX_COMPONENTS_DIR` selects a source directory explicitly. Otherwise the
 * installed package answers - the library ships its .stx sources, so the copy
 * in `node_modules` is the one whose controllers the app imports, and merely
 * having a development checkout on this machine must never replace it.
 */
const packageLibrary = join(root, 'node_modules/@stacksjs/components/src/ui')
const candidates = [process.env.STX_COMPONENTS_DIR, packageLibrary]
  .filter((dir): dir is string => Boolean(dir))
const library = candidates.find(dir => existsSync(dir)) ?? packageLibrary

/**
 * Component directories contributed by installed packages.
 *
 * Wrapped on its own rather than left to the plugin loader's catch: stx wraps
 * plugin loading in `try { … } catch { console.warn(…) }`, so an exception
 * raised here would drop the WHOLE plugin, and this plugin is what supplies
 * every shared tag. Degrading to "no package components" keeps the library and
 * the framework defaults working.
 *
 * `@stacksjs/config` is imported for the resolution rather than
 * re-implemented, because it carries the guard that refuses a path escaping
 * the package.
 */
function packageDirs(): string[] {
  try {
    // eslint-disable-next-line ts/no-require-imports
    const { packageComponentRoots } = require('@stacksjs/config')
    return packageComponentRoots().map((entry: { dir: string }) => entry.dir)
  }
  catch {
    return []
  }
}

export default {
  /*
   * Not `@stacksjs/components`, which is the library's own plugin name: stx
   * treats a plugin under that name as the component package itself, so every
   * directory listed below counts as a package directory and the shared names
   * resolve out of whichever one comes first, whatever this list says. The
   * scaffolded plugin carried that name and was renamed upstream for exactly
   * this reason (stacksjs/stx#2177, released in 0.2.842). Under its own name
   * the list below is precedence and nothing more.
   */
  name: '@stacksjs/defaults/components',
  // Absolute, because stx resolves a relative entry against this file rather
  // than against the project root.
  components: [
    library,
    join(root, 'storage/framework/defaults/resources/components'),
    ...packageDirs(),
  ],
}
