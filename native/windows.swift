import AppKit
import CoreGraphics
import Foundation

// Metadata only: no private Burp APIs, no UI traversal, no capture on the EDT.
func emit(_ value: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
}
let command = CommandLine.arguments.dropFirst().first ?? "status"
do {
    switch command {
    case "crop":
        let a = Array(CommandLine.arguments.dropFirst(2))
        guard a.count == 6, let image = NSImage(contentsOfFile: a[0]),
              let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
              let x = Double(a[2]), let y = Double(a[3]), let w = Double(a[4]), let h = Double(a[5]),
              let cropped = cg.cropping(to: CGRect(x: x, y: y, width: w, height: h)),
              let data = NSBitmapImageRep(cgImage: cropped).representation(using: .png, properties: [:]) else { throw NSError(domain: "Invalid crop", code: 1) }
        try data.write(to: URL(fileURLWithPath: a[1]), options: .atomic)
        try emit(["ok": true])
    case "select":
        guard let path = CommandLine.arguments.dropFirst(2).first, let image = NSImage(contentsOfFile: path) else { throw NSError(domain: "Missing preview", code: 1) }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let size = image.size
        let screen = NSScreen.main!.visibleFrame
        let scale = min(1, min((screen.width - 80) / size.width, (screen.height - 120) / size.height))
        let rect = NSRect(x: 0, y: 0, width: size.width * scale, height: size.height * scale)
        let window = NSWindow(contentRect: rect, styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Drag to select • Enter to confirm • Esc to cancel"
        window.contentView = RegionView(frame: rect, image: image)
        window.center()
        window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
        app.run()
    case "frontmost":
        try emit(["pid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0])
    case "status":
        try emit(["platform": "darwin", "screenRecording": CGPreflightScreenCaptureAccess(),
                  "accessibility": AXIsProcessTrusted()])
    case "windows":
        guard let entries = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            throw NSError(domain: "No GUI session", code: 1)
        }
        let windows = entries.compactMap { entry -> [String: Any]? in
            guard let layer = entry[kCGWindowLayer as String] as? Int, layer == 0,
                  let pid = entry[kCGWindowOwnerPID as String] as? Int32,
                  let id = entry[kCGWindowNumber as String] as? UInt32,
                  let b = entry[kCGWindowBounds as String] as? [String: Any],
                  let width = b["Width"] as? Double, let height = b["Height"] as? Double,
                  width > 1, height > 1 else { return nil }
            let app = NSRunningApplication(processIdentifier: pid)
            return ["id": id, "pid": pid,
                    "app": app?.localizedName ?? (entry[kCGWindowOwnerName as String] as? String ?? ""),
                    "bundleId": app?.bundleIdentifier ?? "",
                    "title": entry[kCGWindowName as String] as? String ?? "",
                    "bounds": ["x": b["X"] ?? 0, "y": b["Y"] ?? 0, "width": width, "height": height]]
        }
        try emit(windows)
    case "displays":
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success else { throw NSError(domain: "Display enumeration", code: 1) }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { throw NSError(domain: "Display enumeration", code: 2) }
        // screencapture -D uses a 1-based index with the main display first.
        ids.sort { a, b in a == CGMainDisplayID() && b != CGMainDisplayID() }
        try emit(ids.enumerated().map { index, id -> [String: Any] in
            let b = CGDisplayBounds(id)
            return ["display": index + 1, "id": id, "main": id == CGMainDisplayID(),
                    "width": CGDisplayPixelsWide(id), "height": CGDisplayPixelsHigh(id),
                    "bounds": ["x": b.origin.x, "y": b.origin.y, "width": b.width, "height": b.height]]
        })
    default:
        throw NSError(domain: "Unknown helper command", code: 1)
    }
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}

final class RegionView: NSView {
    let image: NSImage
    var start = NSPoint.zero
    var selection = NSRect.zero
    override var acceptsFirstResponder: Bool { true }
    init(frame: NSRect, image: NSImage) { self.image = image; super.init(frame: frame) }
    required init?(coder: NSCoder) { fatalError() }
    override func viewDidMoveToWindow() { window?.makeFirstResponder(self) }
    override func draw(_ dirtyRect: NSRect) {
        image.draw(in: bounds)
        NSColor.systemBlue.setStroke()
        let path = NSBezierPath(rect: selection); path.lineWidth = 2; path.stroke()
    }
    override func mouseDown(with event: NSEvent) { start = convert(event.locationInWindow, from: nil); selection = .zero }
    override func mouseDragged(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        selection = NSRect(x: min(start.x,p.x), y: min(start.y,p.y), width: abs(p.x-start.x), height: abs(p.y-start.y)).intersection(bounds)
        needsDisplay = true
    }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { try? emit(["cancelled": true]); exit(0) }
        if event.keyCode == 36 && selection.width > 1 && selection.height > 1 {
            try? emit(["x": selection.minX / bounds.width, "y": (bounds.height-selection.maxY) / bounds.height, "width": selection.width / bounds.width, "height": selection.height / bounds.height])
            exit(0)
        }
    }
}
