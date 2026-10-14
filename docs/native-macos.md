# Native macOS app

Attic's desktop screens live in `resources/native/Main.stx` and
`resources/native/Settings.stx`. The stx compiler emits a native tree and
reactive mutations. Craft draws AppKit controls directly. Transcripts use
selectable NSTextField text, scrolling uses NSScrollView, composing uses
NSTextView, Settings uses NSPopUpButton, and the sidebar uses NSOutlineView.
Menus, sheets, file pickers, attachment previews, QR codes, and windows use
macOS APIs.

zig-js executes the compiled screen bundle. Its owned `ZigJSContext` avoids
compatibility-class collisions with Apple frameworks. The host performs an
explicit Promise checkpoint after script evaluation, timers, and bridge
callbacks. JavaScriptCore and WebKit are absent from its direct link dependencies.

```sh
./buddy upgrade
bun install
bun run build:native
DESKTOP_SIGNING_IDENTITY='<Developer ID identity>' bun run build:app
bun run test:native
```

`scripts/native-lock.json` pins the framework and engine commits and the Zig
download checksum. Builds fetch sparse source snapshots into `storage/attic`
and resolve external TypeScript dependencies through the app's Bun lockfile.
For local framework development, use `STX_NATIVE_SOURCE`, `CRAFT_NATIVE_SOURCE`,
and `ZIG_JS_SOURCE`; `CRAFT_ZIG` can select an explicit compiler.

The signed DMG is written to `storage/framework/desktop-dmg`. Install it before
running `test:native`, or set `ATTIC_E2E_APP` to a built bundle. The test uses
invented conversations in an isolated data directory, drives the native
controls, records actual view and context classes, and saves native window
renderings and its report under `storage/attic/e2e-native`. `--keep-open` keeps
the fixture available for further inspection.

The test driver is enabled only when both the fixture database and
`ATTIC_NATIVE_TEST_DIR` are explicitly supplied. Normal launches do not expose
it. The local agent keeps its authenticated HTTP session in URLSession; scripts
do not receive the session token.

The web views under `resources/views` still serve the browser and mobile web
clients. The desktop launcher loads `native-screen.js` through the AppKit host.
