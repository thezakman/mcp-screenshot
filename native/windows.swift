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
        let configPath = CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : ""
        let config = (try? Data(contentsOf: URL(fileURLWithPath: configPath))).flatMap { try? JSONSerialization.jsonObject(with:$0) as? [String:Any] } ?? [:]
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let size = image.size
        let screen = NSScreen.main!.visibleFrame
        let scale = min(1, min((screen.width - 80) / size.width, (screen.height - 200) / size.height))
        let canvas = NSRect(x: 0, y: 0, width: size.width * scale, height: size.height * scale)
        let rect = NSRect(x:0,y:0,width:max(900,canvas.width),height:canvas.height)
        let window = SelectionWindow(contentRect: NSRect(x: 0, y: 0, width: rect.width, height: rect.height + 144), styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Captura — região, perfis e destino"
        window.hidesOnDeactivate = false
        window.level = .floating
        window.collectionBehavior = [.fullScreenAuxiliary]
        let container = NSView(frame: NSRect(x: 0, y: 0, width: rect.width, height: rect.height + 144))
        let region = RegionView(frame: NSRect(x: (rect.width-canvas.width)/2, y: 0, width: canvas.width, height: canvas.height), image: image)
        region.configuration = config
        container.addSubview(region)
        let all = NSButton(title: "Selecionar tudo", target: region, action: #selector(RegionView.selectAllImage))
        all.frame = NSRect(x:110,y:5,width:140,height:30); container.addSubview(all)
        let settings = NSButton(title: "Configurações…", target: region, action: #selector(RegionView.settings))
        settings.frame = NSRect(x:260,y:5,width:150,height:30); container.addSubview(settings)
        let capture = NSButton(title: "Capturar e salvar", target:region,action:#selector(RegionView.captureSelection))
        region.captureButton=capture
        capture.isEnabled=false
        capture.toolTip="Captura o conteúdo atual e salva PNG e JSON na pasta de destino."
        capture.frame = NSRect(x:rect.width-450,y:5,width:165,height:30); container.addSubview(capture)
        let names = NSPopUpButton(frame:NSRect(x:12,y:76,width:260,height:28))
        names.addItem(withTitle:"Perfil: seleção manual")
        for profile in config["profiles"] as? [[String:Any]] ?? [] { names.addItem(withTitle:profile["name"] as? String ?? "") }
        if let current=config["name"] as? String, names.itemTitles.contains(current) { names.selectItem(withTitle:current) }
        names.target=region; names.action=#selector(RegionView.loadProfile(_:)); container.addSubview(names)
        let name = NSTextField(frame:NSRect(x:285,y:76,width:280,height:26))
        name.placeholderString="Nome para novo perfil (opcional)"; name.stringValue=config["name"] as? String ?? ""
        region.nameField=name; container.addSubview(name)
        let targets=NSPopUpButton(frame:NSRect(x:12,y:110,width:rect.width-24,height:28))
        for target in config["targets"] as? [[String:Any]] ?? [] {
            targets.addItem(withTitle:target["title"] as? String ?? "")
            targets.lastItem?.representedObject=target["id"]
            if target["id"] as? String == config["current_target"] as? String { targets.select(targets.lastItem) }
        }
        targets.target=region; targets.action=#selector(RegionView.changeTarget(_:)); container.addSubview(targets)
        let destination=NSTextField(labelWithString:"Destino: \(config["destination"] as? String ?? "")")
        destination.frame=NSRect(x:12,y:54,width:rect.width-24,height:20); destination.lineBreakMode = .byTruncatingMiddle; container.addSubview(destination)
        let hint = NSTextField(labelWithString: "Arraste para selecionar. Mova pelo centro; ajuste pelas bordas.")
        hint.frame = NSRect(x: 12, y: 38, width: rect.width - 24, height: 20)
        hint.textColor = .secondaryLabelColor
        hint.font = .systemFont(ofSize:11)
        region.statusLabel=hint
        container.addSubview(hint)
        let cancel = NSButton(title: "Cancelar", target: region, action: #selector(RegionView.cancelSelection))
        cancel.frame = NSRect(x: rect.width - 280, y: 5, width: 100, height: 30)
        cancel.keyEquivalent = "\u{1b}"
        container.addSubview(cancel)
        let save = NSButton(title: "Confirmar seleção", target: region, action: #selector(RegionView.confirmSelection))
        save.frame = NSRect(x: rect.width - 170, y: 5, width: 158, height: 30)
        save.keyEquivalent = "\r"
        save.toolTip="Confirma a região e salva o perfil nomeado. Não salva um screenshot."
        save.isEnabled = false
        region.confirmButton = save
        if let r=config["initial_region"] as? [String:Double], let x=r["x"], let y=r["y"], let w=r["width"], let h=r["height"] {
            region.selection=NSRect(x:x*region.bounds.width,y:(1-y-h)*region.bounds.height,width:w*region.bounds.width,height:h*region.bounds.height); region.refresh()
        }
        container.addSubview(save)
        let reset = NSButton(title: "Refazer", target: region, action: #selector(RegionView.resetSelection))
        reset.frame = NSRect(x: 12, y: 5, width: 90, height: 30)
        container.addSubview(reset)
        let pin=NSButton(checkboxWithTitle:"Manter no topo",target:region,action:#selector(RegionView.togglePinned(_:)))
        pin.state = .on; pin.frame=NSRect(x:rect.width-175,y:76,width:160,height:26); container.addSubview(pin)
        names.toolTip="Perfis compatíveis com o aplicativo e as dimensões desta janela."
        targets.toolTip="Escolha a janela ou o monitor que será capturado."
        name.toolTip="Use letras minúsculas, números e hífens. Deixe vazio para não salvar perfil."
        destination.toolTip=config["destination"] as? String
        all.toolTip="Seleciona a imagem inteira do alvo atual. Para tela inteira, escolha um monitor."
        for control in container.subviews where control !== region {
            control.frame.origin.y += canvas.height
            if let button=control as? NSButton, !(button is NSPopUpButton), button !== pin { button.bezelStyle = .rounded }
        }
        region.refresh()
        window.contentView = container
        window.center()
        window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
        window.makeFirstResponder(region)
        if let error=config["error"] as? String {
            let alert=NSAlert(); alert.messageText="Não foi possível concluir"; alert.informativeText=error
            alert.beginSheetModal(for:window)
        }
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
    var configuration: [String:Any] = [:]
    weak var nameField: NSTextField?
    var start = NSPoint.zero
    var original = NSRect.zero
    var selection = NSRect.zero
    var dragMode = "draw"
    weak var confirmButton: NSButton?
    weak var captureButton: NSButton?
    weak var statusLabel: NSTextField?
    @objc func togglePinned(_ sender:NSButton) { window?.level = sender.state == .on ? .floating : .normal }

    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    init(frame: NSRect, image: NSImage) { self.image = image; super.init(frame: frame) }
    required init?(coder: NSCoder) { fatalError() }
    var valid: Bool { selection.width >= 2 && selection.height >= 2 }
    func refresh() {
        needsDisplay = true; confirmButton?.isEnabled = valid; captureButton?.isEnabled = valid
        if valid {
            let cg=image.cgImage(forProposedRect:nil,context:nil,hints:nil)
            let w=Int((selection.width/bounds.width*CGFloat(cg?.width ?? Int(image.size.width))).rounded())
            let h=Int((selection.height/bounds.height*CGFloat(cg?.height ?? Int(image.size.height))).rounded())
            statusLabel?.stringValue="Seleção: \(w) × \(h) px · Arraste o centro para mover; use as alças para ajustar. Setas: precisão; Shift: passo maior."
        } else { statusLabel?.stringValue="Arraste sobre a imagem ou escolha Selecionar tudo. A prévia é congelada; Capturar e salvar faz uma nova captura." }
    }
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
    func finish(_ value:[String:Any]) {
        var response=value
        response["draft_name"] = nameField?.stringValue ?? ""
        if valid && response["region"] == nil {response["region"]=selectedRegion()}
        do { try emit(response); exit(0) }
        catch { FileHandle.standardError.write(Data("Could not return selection\n".utf8)); exit(1) }
    }
    func selectedRegion() -> [String:Double] {
        ["x":selection.minX/bounds.width,"y":(bounds.height-selection.maxY)/bounds.height,"width":selection.width/bounds.width,"height":selection.height/bounds.height]
    }
    @objc func selectAllImage() { selection=bounds; refresh(); window?.makeFirstResponder(self) }
    @objc func confirmSelection() {
        guard valid else { NSSound.beep(); return }
        if configuration.isEmpty { finish(selectedRegion()); return }
        finish(["action":"confirm","region":selectedRegion(),"name":nameField?.stringValue ?? ""])
    }
    @objc func captureSelection() {
        guard valid else { NSSound.beep(); return }
        finish(["action":"capture","region":selectedRegion(),"name":nameField?.stringValue ?? ""])
    }
    @objc func loadProfile(_ sender:NSPopUpButton) {
        let profiles=configuration["profiles"] as? [[String:Any]] ?? []
        let index=sender.indexOfSelectedItem-1
        guard index>=0 && index<profiles.count, let r=profiles[index]["region"] as? [String:Double],
              let x=r["x"], let y=r["y"], let w=r["width"], let h=r["height"] else { nameField?.stringValue=""; return }
        selection=NSRect(x:x*bounds.width,y:(1-y-h)*bounds.height,width:w*bounds.width,height:h*bounds.height)
        nameField?.stringValue=profiles[index]["name"] as? String ?? ""; refresh()
    }
    @objc func changeTarget(_ sender:NSPopUpButton) {
        guard let target=sender.selectedItem?.representedObject as? String else { return }
        finish(["action":"target","target":target])
    }
    @objc func settings() {
        let alert=NSAlert()
        alert.messageText="Configurações e perfis"
        alert.informativeText="Capturas: \(configuration["destination"] as? String ?? "")\nPerfis: \(configuration["profiles_directory"] as? String ?? "")\nMudar o destino não move capturas existentes."
        alert.addButton(withTitle:"Escolher pasta…")
        alert.addButton(withTitle:"Renomear perfil…")
        alert.addButton(withTitle:"Apagar perfil…")
        alert.addButton(withTitle:"Fechar")
        if configuration["destination_locked"] as? Bool == true { alert.buttons[0].isEnabled=false; alert.informativeText += "\nDestino definido por MCP_SCREENSHOT_DIR." }
        let list=NSPopUpButton(frame:NSRect(x:0,y:0,width:360,height:28))
        for p in configuration["all_profiles"] as? [[String:Any]] ?? [] {list.addItem(withTitle:p["name"] as? String ?? "")}
        alert.accessoryView=list
        let choice=alert.runModal()
        if choice == .alertFirstButtonReturn {
            let panel=NSOpenPanel(); panel.canChooseFiles=false; panel.canChooseDirectories=true; panel.canCreateDirectories=true; panel.allowsMultipleSelection=false
            if panel.runModal() == .OK, let url=panel.url { finish(["action":"destination","destination":url.path]) }
        } else if choice == .alertSecondButtonReturn, let name=list.titleOfSelectedItem {
            let rename=NSAlert(); rename.messageText="Renomear \(name)"; rename.addButton(withTitle:"Renomear"); rename.addButton(withTitle:"Cancelar")
            let field=NSTextField(frame:NSRect(x:0,y:0,width:360,height:26)); field.stringValue=name; rename.accessoryView=field
            if rename.runModal() == .alertFirstButtonReturn {finish(["action":"rename","name":name,"new_name":field.stringValue])}
        } else if choice == .alertThirdButtonReturn, let name=list.titleOfSelectedItem {
            let confirm=NSAlert(); confirm.messageText="Apagar o perfil \(name)?"; confirm.informativeText="As capturas existentes serão preservadas."; confirm.addButton(withTitle:"Apagar");confirm.addButton(withTitle:"Cancelar")
            if confirm.runModal() == .alertFirstButtonReturn {finish(["action":"delete","name":name])}
        }
        window?.makeFirstResponder(self)
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
