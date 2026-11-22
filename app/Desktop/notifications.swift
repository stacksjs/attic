import AppKit
import UserNotifications

/// The main app requests permission and posts notifications under its own identity.
private final class TextsNotifications {
    static let shared = TextsNotifications()
    private let queue = DispatchQueue(label: "com.stacksjs.attic.notifications")
    private var waiting: [UNNotificationRequest] = []
    private var checking = false

    func post(id: String, title: String, body: String) {
        if let bundle = Bundle.main.bundleIdentifier,
           NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundle {
            return
        }

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        queue.async {
            self.waiting.append(request)
            guard !self.checking else { return }
            self.checking = true
            let center = UNUserNotificationCenter.current()
            center.getNotificationSettings { settings in
                switch settings.authorizationStatus {
                case .notDetermined:
                    center.requestAuthorization(options: [.alert, .sound]) { granted, error in
                        if let error { NSLog("[texts] notification permission: %@", error.localizedDescription) }
                        self.deliver(to: center, allowed: granted)
                    }
                case .denied:
                    self.deliver(to: center, allowed: false)
                default:
                    self.deliver(to: center, allowed: true)
                }
            }
        }
    }

    private func deliver(to center: UNUserNotificationCenter, allowed: Bool) {
        queue.async {
            let requests = self.waiting
            self.waiting.removeAll()
            self.checking = false
            guard allowed else { return }
            for request in requests {
                center.add(request) { error in
                    if let error { NSLog("[texts] notification delivery: %@", error.localizedDescription) }
                }
            }
        }
    }
}

@_cdecl("texts_notify")
public func textsNotify(_ id: UnsafePointer<CChar>, _ title: UnsafePointer<CChar>, _ body: UnsafePointer<CChar>) {
    TextsNotifications.shared.post(id: String(cString: id), title: String(cString: title), body: String(cString: body))
}
