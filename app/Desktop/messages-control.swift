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
// Exit 0 on success. On failure, one line on stderr saying why, and exit 2
// (not permitted), 3 (conversation not found) or 4 (Messages did not respond).
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

let args = CommandLine.arguments.dropFirst()
func option(_ flag: String) -> String? {
  guard let at = args.firstIndex(of: flag), args.index(after: at) < args.endIndex else { return nil }
  return args[args.index(after: at)]
}

guard let command = args.first else { fail(1, "usage: attic-messages trusted|delete|recover") }

if command == "trusted" {
  let prompt = args.contains("--prompt")
  let trusted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary)
  print(trusted ? "trusted" : "not-trusted")
  exit(trusted ? 0 : 2)
}

guard AXIsProcessTrusted() else { fail(2, "Attic needs Accessibility access to drive Messages") }

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
  if let url = option("--url") { open(url) }
  let app = appElement()
  // The row's own action, never the menu's "Delete Conversation…", which acts
  // on whatever is selected.
  guard let target = poll({ row(in: app) }) else { fail(3, "No conversation named \(name) in Messages") }
  guard let delete = actions(target).first(where: { $0.contains("Name:Delete") }) else { fail(4, "Messages offers no Delete for \(name)") }
  guard AXUIElementPerformAction(target, delete as CFString) == .success else { fail(4, "Messages did not open its delete confirmation") }
  if args.contains("--confirm") {
    guard let button = poll({ alertButton(app, titled: "Delete") }) else { fail(4, "Messages did not show its delete confirmation") }
    guard AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else { fail(4, "Could not confirm the delete") }
  }
  print("deleted")

case "recover":
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

default:
  fail(1, "unknown command \(command)")
}
