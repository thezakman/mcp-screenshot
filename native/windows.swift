import AppKit
import CoreGraphics
import Foundation

// Local window metadata and image-region UI; no private Burp APIs or UI traversal.
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
        let window = SelectionWindow(contentRect: NSRect(x: 0, y: 0, width: rect.width, height: rect.height + 66), styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Selecionar região — ajuste e confirme"
        let container = NSView(frame: NSRect(x: 0, y: 0, width: rect.width, height: rect.height + 66))
        let region = RegionView(frame: NSRect(x: 0, y: 66, width: rect.width, height: rect.height), image: image)
        container.addSubview(region)
        let hint = NSTextField(labelWithString: "Arraste para selecionar. Mova pelo centro; ajuste pelas bordas.")
        hint.frame = NSRect(x: 12, y: 38, width: rect.width - 24, height: 20)
        container.addSubview(hint)
        let cancel = NSButton(title: "Cancelar", target: region, action: #selector(RegionView.cancelSelection))
        cancel.frame = NSRect(x: rect.width - 230, y: 5, width: 100, height: 30)
        cancel.keyEquivalent = "\u{1b}"
        container.addSubview(cancel)
        let save = NSButton(title: "Confirmar", target: region, action: #selector(RegionView.confirmSelection))
        save.frame = NSRect(x: rect.width - 125, y: 5, width: 113, height: 30)
        save.keyEquivalent = "\r"
        save.isEnabled = false
        region.confirmButton = save
        container.addSubview(save)
        let reset = NSButton(title: "Refazer", target: region, action: #selector(RegionView.resetSelection))
        reset.frame = NSRect(x: 12, y: 5, width: 90, height: 30)
        container.addSubview(reset)
        window.contentView = container
        window.center()
        window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
        window.makeFirstResponder(region)
        withExtendedLifetime(window) { app.run() }
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

final class SelectionWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}
final class RegionView: NSView {
    let image: NSImage
    var start = NSPoint.zero
    var original = NSRect.zero
    var selection = NSRect.zero
    var dragMode = "draw"
    weak var confirmButton: NSButton?
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    init(frame: NSRect, image: NSImage) { self.image = image; super.init(frame: frame) }
    required init?(coder: NSCoder) { fatalError() }
    var valid: Bool { selection.width >= 2 && selection.height >= 2 }
    func refresh() { needsDisplay = true; confirmButton?.isEnabled = valid }
    var handles: [NSPoint] {
        [NSPoint(x:selection.minX,y:selection.minY),NSPoint(x:selection.midX,y:selection.minY),NSPoint(x:selection.maxX,y:selection.minY),
         NSPoint(x:selection.minX,y:selection.midY),NSPoint(x:selection.maxX,y:selection.midY),
         NSPoint(x:selection.minX,y:selection.maxY),NSPoint(x:selection.midX,y:selection.maxY),NSPoint(x:selection.maxX,y:selection.maxY)]
    }
    override func draw(_ dirtyRect: NSRect) {
        image.draw(in: bounds)
        if valid {
            let shade = NSBezierPath(rect: bounds)
            shade.append(NSBezierPath(rect: selection)); shade.windingRule = .evenOdd
            NSColor.black.withAlphaComponent(0.45).setFill(); shade.fill()
            NSColor.systemBlue.setStroke()
            let path = NSBezierPath(rect: selection); path.lineWidth = 2; path.stroke()
            for point in handles {
                let handle = NSBezierPath(rect: NSRect(x: point.x-4, y: point.y-4, width: 8, height: 8))
                NSColor.white.setFill(); handle.fill(); NSColor.systemBlue.setStroke(); handle.stroke()
            }
        }
    }
    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        start = convert(event.locationInWindow, from: nil); original = selection
        dragMode = "draw"
        if valid {
            let nearX = start.x >= selection.minX-8 && start.x <= selection.maxX+8
            let nearY = start.y >= selection.minY-8 && start.y <= selection.maxY+8
            var edges = ""
            if nearY && abs(start.x-selection.minX) <= 8 { edges += "l" }
            else if nearY && abs(start.x-selection.maxX) <= 8 { edges += "r" }
            if nearX && abs(start.y-selection.minY) <= 8 { edges += "b" }
            else if nearX && abs(start.y-selection.maxY) <= 8 { edges += "t" }
            if !edges.isEmpty { dragMode = edges }
            else if selection.contains(start) { dragMode = "move" }
        }
        if dragMode == "draw" { selection = .zero; refresh() }
    }
    override func mouseDragged(with event: NSEvent) {
        let raw = convert(event.locationInWindow, from: nil)
        let p = NSPoint(x: max(0,min(bounds.width,raw.x)), y: max(0,min(bounds.height,raw.y)))
        if dragMode == "move" {
            selection.origin = NSPoint(x:max(0,min(bounds.width-original.width,original.minX+p.x-start.x)),y:max(0,min(bounds.height-original.height,original.minY+p.y-start.y)))
        } else if dragMode == "draw" {
            selection = NSRect(x:min(start.x,p.x),y:min(start.y,p.y),width:abs(p.x-start.x),height:abs(p.y-start.y))
        } else {
            var left=original.minX, right=original.maxX, bottom=original.minY, top=original.maxY
            if dragMode.contains("l") { left = min(p.x,right-2) }
            if dragMode.contains("r") { right = max(p.x,left+2) }
            if dragMode.contains("b") { bottom = min(p.y,top-2) }
            if dragMode.contains("t") { top = max(p.y,bottom+2) }
            selection = NSRect(x:left,y:bottom,width:right-left,height:top-bottom)
        }
        refresh()
    }
    @objc func resetSelection() { selection = .zero; refresh(); window?.makeFirstResponder(self) }
    @objc func cancelSelection() { try? emit(["cancelled": true]); exit(0) }
    @objc func confirmSelection() {
        guard valid else { NSSound.beep(); return }
        do {
            try emit(["x": selection.minX / bounds.width, "y": (bounds.height-selection.maxY) / bounds.height, "width": selection.width / bounds.width, "height": selection.height / bounds.height])
            exit(0)
        } catch { FileHandle.standardError.write(Data("Selection could not be confirmed\n".utf8)); exit(1) }
    }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { cancelSelection(); return }
        if event.keyCode == 36 || event.keyCode == 76 { confirmSelection(); return }
        if valid && [123,124,125,126].contains(event.keyCode) {
            let step: CGFloat = event.modifierFlags.contains(.shift) ? 10 : 1
            let dx: CGFloat = event.keyCode == 123 ? -step : event.keyCode == 124 ? step : 0
            let dy: CGFloat = event.keyCode == 125 ? -step : event.keyCode == 126 ? step : 0
            selection.origin.x = max(0,min(bounds.width-selection.width,selection.minX+dx))
            selection.origin.y = max(0,min(bounds.height-selection.height,selection.minY+dy))
            refresh(); return
        }
        super.keyDown(with:event)
    }
}
