# Export

Attic keeps conversations after the apps let go of them. Export is the way
back out: Attic writes what it kept as plain HTML pages that need no app, no
server and no network.

## From the app

- **Conversation > Export…** (`shift+cmd+e`) writes the selected conversation.
- **Conversation > Export Everything…** writes every conversation Attic kept,
  with a contents page linking to each one.
- Right-click a conversation in the list and choose **Export…** for that one.
  The item is disabled for a conversation Attic has not copied yet.

Each export goes to a dated folder in Downloads, `Attic Export 2026-11-06`,
numbered when one of that date is already there, and the folder opens in the
Finder when it is written. `ATTIC_EXPORT_DIR` points that somewhere else for
development and tests.

## What a folder holds

```
Attic Export 2026-11-06/
  index.html            contents, when more than one conversation was written
  Sam Rivera.html       one page per conversation
  #design.html
  Attachments/
    Sam Rivera/         the pictures and files that conversation kept
```

A page carries its own styles, follows the reader's light or dark setting,
prints to PDF, and links to its attachments by relative path. Keep the folder
together and it keeps working; open a page on any machine, years later, with
no Attic installed.

Messages read as they do in the window: bubbles in order, day headings,
reactions on the message they name, replies quoted above the bubble, edits
marked, and a line where an attachment was already gone from this Mac before
Attic could copy it.

## What is exported

Attic's own copy, and only that. A conversation still in Messages, WhatsApp,
Slack or Discord is that app's to export; what Attic kept is what Attic can
promise to write out. A conversation with no copy yet is skipped, and the
menu item for it is disabled.

Attachments are cloned rather than re-encoded, so on APFS an export of a
photo-heavy decade costs almost nothing until one of the two copies changes.

## In code

`app/Attic/export.ts` holds it: `renderConversation` and `renderIndex` build
the markup and touch no disk, `exportArchive` writes a folder, and
`exportFolder` names it. The agent exposes one route, `POST /api/export`,
taking an optional `key` for a single conversation and `reveal: false` to
write the folder without opening it. Both shells, the AppKit window in
`resources/native/Main.stx` and the web shell in `resources/views/app.stx`,
call that route.
