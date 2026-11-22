// attic-messages: drives Messages' own Delete and Recover for one conversation.
//
// Apple gives Messages no scripting for either, and editing chat.db behind its
// back is ignored or synced to every device. What Messages does expose is its
// accessibility tree: every row in the conversation list carries its own
// actions, "Delete…" among them, and Recently Deleted has a Recover button.
// Acting on the row found BY NAME - rather than on whatever happens to be
// selected - is what makes this safe: it cannot delete the wrong conversation.
//
//   attic-messages trusted [--prompt]
//   attic-messages delete  --name "Jane Appleseed" [--url sms:+1555…] [--confirm]
//   attic-messages recover --name "Jane Appleseed"
//
// And the same for WhatsApp, whose chat rows carry their own "Archive" (and,
// in the Archived list, "Unarchive") action. `whatsapp-find` only reports
// whether the row is there, touching nothing.
//
//   attic-messages whatsapp-archive   --name "Jane Appleseed"
//   attic-messages whatsapp-unarchive --name "Jane Appleseed"
//   attic-messages whatsapp-find      --name "Jane Appleseed" [--archived]
//
// Exit 0 on success. On failure, one line on stderr saying why, and exit 2
// (not permitted), 3 (conversation not found), 4 (Messages did not respond),
// or 5 (background operation deferred). --background never opens or focuses apps.
// Compiled by scripts/build-app.ts into Attic.app/Contents/MacOS, so the
// Accessibility grant is Attic's.

import AppKit
import ApplicationServices

func fail(_ code: Int32, _ message: String) -> Never {
  FileHandle.standardError.write(Data("\(message)\n".utf8))
  exit(code)
}

func value(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
  var out: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, attribute as CFString, &out) == .success ? out : nil
}

func text(_ element: AXUIElement, _ attribute: String) -> String? {
  (value(element, attribute) as? String).map { $0.replacingOccurrences(of: "\u{200E}", with: "").replacingOccurrences(of: "\u{200F}", with: "") }
}

func children(_ element: AXUIElement) -> [AXUIElement] {
  (value(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

/// Depth-first search, skipping the application element Messages sometimes
/// reports as a child of its own window (a cycle).
func find(_ root: AXUIElement, depth: Int = 0, _ match: (AXUIElement) -> Bool) -> AXUIElement? {
  if depth > 40 { return nil }
  if match(root) { return root }
  for child in children(root) where text(child, kAXRoleAttribute) != "AXApplication" {
    if let found = find(child, depth: depth + 1, match) { return found }
  }
  return nil
}

func actions(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  AXUIElementCopyActionNames(element, &names)
  return (names as? [String]) ?? []
}

func messagesApp() -> NSRunningApplication? {
  NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == "com.apple.MobileSMS" }
}

/// Poll for something to appear; Messages' UI settles a beat after each step.
func poll<T>(seconds: Double = 6, _ probe: () -> T?) -> T? {
  let deadline = Date().addingTimeInterval(seconds)
  while Date() < deadline {
    if let found = probe() { return found }
    RunLoop.current.run(until: Date().addingTimeInterval(0.15))
  }
  return nil
}

func open(_ url: String) {
  if let target = URL(string: url) { NSWorkspace.shared.open(target) }
}

func activeMessagesWindow() -> AXUIElement {
  guard let running = messagesApp(), running.isActive, !running.isHidden else {
    fail(5, "Automatic removal waits until Messages is open and active.")
  }
  let app = AXUIElementCreateApplication(running.processIdentifier)
  guard let window = (value(app, kAXWindowsAttribute) as? [AXUIElement])?.first(where: {
    text($0, kAXSubroleAttribute) == "AXStandardWindow" && (value($0, kAXMinimizedAttribute) as? Bool) != true
  }) else {
    fail(5, "Automatic removal waits until a Messages window is open.")
  }
  return window
}

func appElement() -> AXUIElement {
  if messagesApp() == nil {
    NSWorkspace.shared.open(URL(fileURLWithPath: "/System/Applications/Messages.app"))
  }
  guard let app = poll({ messagesApp() }) else { fail(4, "Messages did not start") }
  app.activate()
  return AXUIElementCreateApplication(app.processIdentifier)
}

/// The conversation list row Messages labels "<name>, …".
func row(named name: String, in app: AXUIElement) -> AXUIElement? {
  let prefix = "\(name),"
  return find(app) { element in
    guard text(element, kAXRoleAttribute) == "AXStaticText", let label = text(element, kAXDescriptionAttribute) else { return false }
    return label.hasPrefix(prefix) || label == name
  }
}

func clickMenu(_ app: AXUIElement, _ menu: String, _ item: String) -> Bool {
  guard let bar = value(app, kAXMenuBarAttribute) else { return false }
  let menuBar = bar as! AXUIElement
  guard let barItem = children(menuBar).first(where: { text($0, kAXTitleAttribute) == menu }),
        let menuElement = children(barItem).first,
        let menuItem = children(menuElement).first(where: { text($0, kAXTitleAttribute) == item })
  else { return false }
  return AXUIElementPerformAction(menuItem, kAXPressAction as CFString) == .success
}

/// Inside an alert or sheet, judged by walking up the parents.
func inDialog(_ element: AXUIElement) -> Bool {
  var current: AXUIElement? = element
  for _ in 0..<30 {
    guard let node = current else { return false }
    if text(node, kAXRoleAttribute) == "AXSheet" { return true }
    if let sub = text(node, kAXSubroleAttribute), sub == "AXDialog" || sub == "AXSystemDialog" { return true }
    current = value(node, kAXParentAttribute).map { $0 as! AXUIElement }
  }
  return false
}

/// A button in an alert or sheet Messages is showing - never one in the
/// window itself, where Recently Deleted has a "Delete" that is permanent.
/// Matched by prefix: Messages labels them with the count, as in
/// "Recover 442 Messages", and `text` has already dropped the direction marks
/// it puts in front.
func alertButton(_ app: AXUIElement, titled title: String) -> AXUIElement? {
  find(app) { element in
    guard text(element, kAXRoleAttribute) == "AXButton", inDialog(element) else { return false }
    let label = text(element, kAXTitleAttribute) ?? text(element, kAXDescriptionAttribute) ?? ""
    return label == title || label.hasPrefix("\(title) ")
  }
}

/// Recently Deleted shows "No Conversation Selected" until a row is chosen.
func nothingSelected(_ app: AXUIElement) -> Bool {
  find(app) { text($0, kAXRoleAttribute) == "AXStaticText" && text($0, kAXDescriptionAttribute) == "No Conversation Selected" } != nil
}

// MARK: WhatsApp

func whatsappApp() -> NSRunningApplication? {
  NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == "net.whatsapp.WhatsApp" }
}

func whatsappWindow(_ app: AXUIElement) -> AXUIElement? {
  (value(app, kAXWindowsAttribute) as? [AXUIElement])?.first { text($0, kAXIdentifierAttribute) == "SceneWindow" || text($0, kAXRoleAttribute) == "AXWindow" }
}

/// WhatsApp's window, launching or reopening it if need be. It is driven
/// where it is, in the background: its rows' actions do not need focus.
func whatsappElement() -> (AXUIElement, AXUIElement) {
  if background {
    guard let running = whatsappApp(), running.isActive, !running.isHidden else {
      fail(5, "Automatic archiving waits until WhatsApp is open and active.")
    }
    let app = AXUIElementCreateApplication(running.processIdentifier)
    guard let window = whatsappWindow(app) else { fail(5, "WhatsApp's window is closed.") }
    return (app, window)
  }
  let bundle = URL(fileURLWithPath: "/Applications/WhatsApp.app")
  if whatsappApp() == nil { NSWorkspace.shared.open(bundle) }
  guard let running = poll(seconds: 15, { whatsappApp() }) else { fail(4, "WhatsApp did not start") }
  let app = AXUIElementCreateApplication(running.processIdentifier)
  if let window = poll(seconds: 3, { whatsappWindow(app) }) { return (app, window) }
  // Running with its window closed: opening the app again brings it back.
  NSWorkspace.shared.open(bundle)
  guard let window = poll(seconds: 10, { whatsappWindow(app) }) else { fail(4, "WhatsApp has no window") }
  return (app, window)
}

func element(_ root: AXUIElement, identified id: String) -> AXUIElement? {
  find(root) { text($0, kAXIdentifierAttribute) == id }
}

func chatRows(_ table: AXUIElement) -> [AXUIElement] {
  children(table).filter { text($0, kAXRoleAttribute) == "AXButton" && text($0, kAXIdentifierAttribute) != "ChatListView_archiveCell" }
}

/// A row is labelled "<name>, <detail>"; match the name, never a substring.
func rowMatches(_ row: AXUIElement, _ names: [String]) -> Bool {
  guard let label = text(row, kAXDescriptionAttribute) else { return false }
  return names.contains { label == $0 || label.hasPrefix("\($0),") }
}

/// The chat list only holds the rows on screen, so walk it a page at a time,
/// from the top, until the row appears or the list stops moving.
func whatsappRow(_ table: AXUIElement, _ names: [String]) -> AXUIElement? {
  func signature() -> String { chatRows(table).compactMap { text($0, kAXDescriptionAttribute) }.joined(separator: "\n") }
  func settle() { RunLoop.current.run(until: Date().addingTimeInterval(0.25)) }
  for _ in 0..<100 {
    let before = signature()
    AXUIElementPerformAction(table, "AXScrollUpByPage" as CFString)
    settle()
    if signature() == before { break }
  }
  for _ in 0..<200 {
    if let row = chatRows(table).first(where: { rowMatches($0, names) }) { return row }
    let before = signature()
    AXUIElementPerformAction(table, "AXScrollDownByPage" as CFString)
    settle()
    if signature() == before { return chatRows(table).first { rowMatches($0, names) } }
  }
  return nil
}

/// The row's own custom action, "Name:Archive" or "Name:Unarchive" once the
/// direction marks WhatsApp prefixes are gone.
func rowAction(_ row: AXUIElement, _ verb: String) -> String? {
  actions(row).first { action in
    let first = action.components(separatedBy: "\n").first ?? ""
    return first.replacingOccurrences(of: "\u{200E}", with: "").replacingOccurrences(of: "\u{200F}", with: "") == "Name:\(verb)"
  }
}

/// Shows the Chats or Archived list and returns the element holding its rows:
/// the chat list's table, or the Archived view's own container.
func whatsappList(_ window: AXUIElement, archived: Bool) -> AXUIElement? {
  if let button = element(window, identified: archived ? "SidebarButton_Archived" : "SidebarButton_Chats") {
    AXUIElementPerformAction(button, kAXPressAction as CFString)
    RunLoop.current.run(until: Date().addingTimeInterval(0.6))
  }
  return poll { element(window, identified: archived ? "WAArchivedChatsViewController" : "ChatListView_TableView") }
}

let args = CommandLine.arguments.dropFirst()
let background = args.contains("--background")
func option(_ flag: String) -> String? {
  guard let at = args.firstIndex(of: flag), args.index(after: at) < args.endIndex else { return nil }
  return args[args.index(after: at)]
}

guard let command = args.first else { fail(1, "usage: attic-messages trusted|delete|recover|whatsapp-archive|whatsapp-unarchive|whatsapp-find") }

if command == "trusted" {
  let prompt = args.contains("--prompt")
  let trusted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary)
  print(trusted ? "trusted" : "not-trusted")
  exit(trusted ? 0 : 2)
}

guard AXIsProcessTrusted() else { fail(2, "Attic needs Accessibility access to drive \(command.hasPrefix("whatsapp") ? "WhatsApp" : "Messages")") }

/// Every --name given, in order: Messages labels a row with the contact's
/// name when it has one and a formatted number when not, so the caller passes
/// each spelling it knows and the first that matches wins.
let names: [String] = args.indices.compactMap { at in
  args[at] == "--name" && args.index(after: at) < args.endIndex ? args[args.index(after: at)] : nil
}.filter { !$0.isEmpty }
guard !names.isEmpty else { fail(1, "--name is required") }
let name = names[0]

func row(in app: AXUIElement) -> AXUIElement? {
  for candidate in names {
    if let found = row(named: candidate, in: app) { return found }
  }
  return nil
}

switch command {
case "delete":
  if background && !args.contains("--confirm") {
    fail(5, "Automatic removal waits for an explicit archive when Messages needs confirmation.")
  }
  if !background, let url = option("--url") { open(url) }
  let root = background ? activeMessagesWindow() : appElement()
  // The row's own action, never the menu's "Delete Conversation…", which acts
  // on whatever is selected.
  guard let target = poll({ row(in: background ? activeMessagesWindow() : root) }) else { fail(3, "No conversation named \(name) in Messages") }
  guard let delete = actions(target).first(where: { $0.contains("Name:Delete") }) else { fail(4, "Messages offers no Delete for \(name)") }
  if background { _ = activeMessagesWindow() }
  guard AXUIElementPerformAction(target, delete as CFString) == .success else { fail(4, "Messages did not open its delete confirmation") }
  if args.contains("--confirm") {
    guard let button = poll({ alertButton(background ? activeMessagesWindow() : root, titled: "Delete") }) else { fail(4, "Messages did not show its delete confirmation") }
    guard AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else { fail(4, "Could not confirm the delete") }
  }
  print("deleted")

case "recover":
  if background { fail(5, "Recovery waits for an explicit request.") }
  let app = appElement()
  guard clickMenu(app, "View", "Recently Deleted") else { fail(4, "Messages has no View > Recently Deleted") }
  defer { _ = clickMenu(app, "View", "Messages") }
  guard let target = poll({ row(in: app) }) else {
    _ = clickMenu(app, "View", "Messages")
    fail(3, "\(name) is not in Recently Deleted")
  }
  _ = AXUIElementPerformAction(target, kAXPressAction as CFString)
  // The Recover button is always there; pressing it before the selection has
  // landed recovers nothing. Wait for Messages to show the row as chosen.
  guard poll({ nothingSelected(app) ? nil : true }) != nil else {
    _ = clickMenu(app, "View", "Messages")
    fail(4, "Messages did not select \(name) in Recently Deleted")
  }
  guard let recover = poll({ find(app) { text($0, kAXRoleAttribute) == "AXButton" && text($0, kAXDescriptionAttribute) == "Recover" && !inDialog($0) } }) else {
    _ = clickMenu(app, "View", "Messages")
    fail(4, "Messages showed no Recover button")
  }
  _ = AXUIElementPerformAction(recover, kAXPressAction as CFString)
  // Messages asks again in a sheet: "Recover 442 Messages" / Cancel.
  guard let confirm = poll({ alertButton(app, titled: "Recover") }) else {
    _ = clickMenu(app, "View", "Messages")
    fail(4, "Messages did not ask to confirm the recovery")
  }
  _ = AXUIElementPerformAction(confirm, kAXPressAction as CFString)
  RunLoop.current.run(until: Date().addingTimeInterval(0.8))
  _ = clickMenu(app, "View", "Messages")
  print("recovered")

case "whatsapp-find":
  let (_, window) = whatsappElement()
  let archived = args.contains("--archived")
  guard let table = whatsappList(window, archived: archived) else { fail(4, "WhatsApp showed no chat list") }
  defer { if archived { _ = whatsappList(window, archived: false) } }
  guard let row = whatsappRow(table, names) else { fail(3, "No chat named \(name) in WhatsApp") }
  print("found: \(rowAction(row, archived ? "Unarchive" : "Archive") != nil ? "actionable" : "no action")")

case "whatsapp-archive", "whatsapp-unarchive":
  let unarchive = command == "whatsapp-unarchive"
  let (_, window) = whatsappElement()
  guard let table = whatsappList(window, archived: unarchive) else { fail(4, "WhatsApp showed no chat list") }
  defer { if unarchive { _ = whatsappList(window, archived: false) } }
  guard let row = whatsappRow(table, names) else { fail(3, "No chat named \(name) in WhatsApp\(unarchive ? "'s Archived" : "")") }
  let verb = unarchive ? "Unarchive" : "Archive"
  guard let action = rowAction(row, verb) else { fail(4, "WhatsApp offers no \(verb) for \(name)") }
  guard AXUIElementPerformAction(row, action as CFString) == .success else { fail(4, "WhatsApp did not \(verb.lowercased()) \(name)") }
  RunLoop.current.run(until: Date().addingTimeInterval(0.6))
  print(unarchive ? "unarchived" : "archived")

default:
  fail(1, "unknown command \(command)")
}
