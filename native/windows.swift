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
        let screen = NSScreen.main!.visibleFrame
        let size = NSSize(width:min(1280,screen.width-80),height:min(820,screen.height-100))
        let window = SelectionWindow(contentRect:NSRect(origin:.zero,size:size),styleMask:[.titled,.closable,.miniaturizable,.resizable],backing:.buffered,defer:false)
        window.title = "Captura"
        window.minSize=NSSize(width:860,height:560)
        window.hidesOnDeactivate=false; window.level = .floating
        window.collectionBehavior = [.fullScreenAuxiliary]
        let container=NSView(frame:NSRect(origin:.zero,size:size))
        let region=RegionView(frame:NSRect(x:0,y:0,width:image.size.width,height:image.size.height),image:image)
        region.configuration=config
        window.delegate=region
        let preview=PreviewPane(region:region)
        preview.translatesAutoresizingMaskIntoConstraints=false
        container.addSubview(preview)
        let sidebar=NSScrollView()
        sidebar.translatesAutoresizingMaskIntoConstraints=false
        sidebar.hasVerticalScroller=true; sidebar.autohidesScrollers=true
        sidebar.drawsBackground=true; sidebar.backgroundColor = .windowBackgroundColor
        container.addSubview(sidebar)
        let footer=NSStackView()
        footer.orientation = .vertical; footer.spacing=6
        footer.edgeInsets=NSEdgeInsets(top:8,left:18,bottom:8,right:18)
        footer.translatesAutoresizingMaskIntoConstraints=false
        container.addSubview(footer)
        NSLayoutConstraint.activate([
            sidebar.leadingAnchor.constraint(equalTo:container.leadingAnchor),sidebar.topAnchor.constraint(equalTo:container.topAnchor),sidebar.bottomAnchor.constraint(equalTo:footer.topAnchor),sidebar.widthAnchor.constraint(equalToConstant:320),
            footer.leadingAnchor.constraint(equalTo:sidebar.leadingAnchor),footer.trailingAnchor.constraint(equalTo:sidebar.trailingAnchor),footer.bottomAnchor.constraint(equalTo:container.bottomAnchor),
            preview.leadingAnchor.constraint(equalTo:sidebar.trailingAnchor),preview.trailingAnchor.constraint(equalTo:container.trailingAnchor),preview.topAnchor.constraint(equalTo:container.topAnchor),preview.bottomAnchor.constraint(equalTo:container.bottomAnchor)
        ])
        let document=FlippedView()
        document.translatesAutoresizingMaskIntoConstraints=false
        sidebar.documentView=document
        document.widthAnchor.constraint(equalTo:sidebar.contentView.widthAnchor).isActive=true
        let stack=NSStackView()
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing=10
        stack.translatesAutoresizingMaskIntoConstraints=false; document.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo:document.leadingAnchor,constant:18),stack.trailingAnchor.constraint(equalTo:document.trailingAnchor,constant:-18),stack.topAnchor.constraint(equalTo:document.topAnchor,constant:20),stack.bottomAnchor.constraint(equalTo:document.bottomAnchor,constant:-20)])
        func label(_ text:String,_ size:CGFloat=12,_ weight:NSFont.Weight = .regular) -> NSTextField {
            let field=NSTextField(wrappingLabelWithString:text); field.font = .systemFont(ofSize:size,weight:weight); return field
        }
        func add(_ view:NSView) { stack.addArrangedSubview(view); view.widthAnchor.constraint(equalTo:stack.widthAnchor).isActive=true }
        func section(_ title:String,_ control:NSView) {
            let heading=label(title,11,.semibold); heading.textColor = .secondaryLabelColor
            add(heading); stack.setCustomSpacing(4,after:heading); add(control)
        }
        func button(_ title:String,_ action:Selector) -> NSButton {
            let control=NSButton(title:title,target:region,action:action); control.bezelStyle = .rounded
            control.controlSize = .large; control.heightAnchor.constraint(equalToConstant:34).isActive=true; return control
        }
        add(label("Nova captura",22,.semibold))
        if let request=config["request"] as? String { section("PEDIDO",label(request,11)) }
        if let reason=config["suggestion_reason"] as? String {
            section("RECORTE SUGERIDO",label(reason,11))
        }
        let targets=NSPopUpButton()
        targets.lineBreakMode = .byTruncatingMiddle
        for target in config["targets"] as? [[String:Any]] ?? [] {
            targets.addItem(withTitle:target["title"] as? String ?? "")
            targets.lastItem?.representedObject=target["id"]
            if target["id"] as? String == config["current_target"] as? String { targets.select(targets.lastItem) }
        }
        targets.target=region; targets.action=#selector(RegionView.changeTarget(_:))
        targets.toolTip="Janela ou monitor de origem"; section("ORIGEM",targets)
        let reload=button("Atualizar prévia",#selector(RegionView.reloadPreview))
        reload.toolTip="Obtém uma nova imagem e limpa a seleção anterior para você revisar o conteúdo atual."
        add(reload)
        let names=NSPopUpButton()
        names.addItem(withTitle:"Seleção livre")
        for profile in config["profiles"] as? [[String:Any]] ?? [] { names.addItem(withTitle:profile["name"] as? String ?? "") }
        if let current=config["name"] as? String,names.itemTitles.contains(current) {names.selectItem(withTitle:current)}
        names.target=region; names.action=#selector(RegionView.loadProfile(_:)); section("REGIÃO FIXA",names)
        let name=NSTextField()
        name.placeholderString="Opcional"; name.stringValue=config["name"] as? String ?? ""
        name.heightAnchor.constraint(equalToConstant:28).isActive=true; region.nameField=name
        name.toolTip="Salva coordenadas fixas; não se adapta ao tamanho de novos payloads ou respostas. Deixe vazio para capturar somente agora."; section("NOME DO PERFIL",name)
        let all=button("Imagem inteira",#selector(RegionView.selectAllImage))
        let reset=button("Limpar região",#selector(RegionView.resetSelection))
        let row=NSStackView(views:[all,reset]); row.orientation = .horizontal; row.distribution = .fillEqually; row.spacing=8
        add(row)
        let status=label("Desenhe uma região",13,.medium); region.statusLabel=status; add(status)
        let instructions=label("Arraste para mover. Use as alças para ajustar.",11)
        instructions.toolTip="Use as setas para mover e Shift para aumentar o passo."
        instructions.textColor = .secondaryLabelColor; add(instructions)
        let descriptionConfig=config["description"] as? [String:Any] ?? [:]
        let description=NSTextField()
        description.placeholderString="Descreva o recorte (opcional)"
        description.toolTip="A IA pode sugerir uma descrição ao abrir a prévia. Ao atualizar a imagem, revise o recorte e escreva uma nova descrição."
        description.stringValue=descriptionConfig["text"] as? String ?? ""
        description.cell?.wraps=true; description.cell?.isScrollable=false
        description.heightAnchor.constraint(equalToConstant:56).isActive=true
        region.descriptionField=description
        let language=NSTextField()
        language.stringValue=descriptionConfig["language"] as? String ?? "pt-BR"
        language.placeholderString="pt-BR, en…"
        language.heightAnchor.constraint(equalToConstant:26).isActive=true
        region.descriptionLanguageField=language
        language.widthAnchor.constraint(equalToConstant:68).isActive=true
        language.toolTip="Idioma da descrição"; language.setAccessibilityLabel("Idioma da descrição")
        let heading=label("DESCRIÇÃO",11,.semibold); heading.textColor = .secondaryLabelColor
        let languageHeading=label("IDIOMA",11,.semibold); languageHeading.textColor = .secondaryLabelColor
        let descriptionHeader=NSStackView(views:[heading,NSView(),languageHeading,language])
        descriptionHeader.spacing=6
        add(descriptionHeader); stack.setCustomSpacing(4,after:descriptionHeader); add(description)
        let project=NSTextField()
        project.placeholderString="Automático · data + UUID"; project.stringValue=config["case_id"] as? String ?? ""
        project.heightAnchor.constraint(equalToConstant:28).isActive=true; region.projectField=project
        section("PROJETO",project)
        let destination=NSTextField(labelWithString:config["destination"] as? String ?? "")
        destination.lineBreakMode = .byTruncatingMiddle; destination.font = .systemFont(ofSize:11); destination.toolTip=destination.stringValue
        section("PASTA BASE",destination)
        let settings=button("Pasta e perfis…",#selector(RegionView.settings)); add(settings)
        let pin=NSButton(checkboxWithTitle:"Manter janela no topo",target:region,action:#selector(RegionView.togglePinned(_:)))
        pin.state = .on
        let capture=button("Capturar e salvar",#selector(RegionView.captureSelection))
        capture.keyEquivalent="\r"; capture.toolTip="Salva o recorte da prévia atual."; region.captureButton=capture; footer.addArrangedSubview(capture)
        capture.widthAnchor.constraint(equalTo:footer.widthAnchor,constant:-36).isActive=true
        let save=button("Salvar apenas a seleção",#selector(RegionView.confirmSelection))
        save.toolTip="Confirma a região e salva o perfil nomeado, sem criar screenshot."; region.confirmButton=save
        let cancel=button("Cancelar",#selector(RegionView.cancelSelection)); cancel.keyEquivalent="\u{1b}"
        let secondary=NSStackView(views:[save,cancel]); secondary.spacing=4
        footer.addArrangedSubview(secondary)
        let pinRow=NSView()
        pin.translatesAutoresizingMaskIntoConstraints=false
        pinRow.addSubview(pin)
        NSLayoutConstraint.activate([
            pin.centerXAnchor.constraint(equalTo:pinRow.centerXAnchor),
            pin.topAnchor.constraint(equalTo:pinRow.topAnchor),
            pin.bottomAnchor.constraint(equalTo:pinRow.bottomAnchor),
            pin.leadingAnchor.constraint(greaterThanOrEqualTo:pinRow.leadingAnchor),
            pin.trailingAnchor.constraint(lessThanOrEqualTo:pinRow.trailingAnchor)
        ])
        footer.addArrangedSubview(pinRow)
        if let r=config["initial_region"] as? [String:Double],let x=r["x"],let y=r["y"],let w=r["width"],let h=r["height"] {
            region.selection=NSRect(x:x*region.bounds.width,y:(1-y-h)*region.bounds.height,width:w*region.bounds.width,height:h*region.bounds.height)
        }
        region.refresh()
        window.contentView=container
        container.layoutSubtreeIfNeeded()
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
final class RegionView: NSView, NSWindowDelegate {
    let image: NSImage
    var configuration: [String:Any] = [:]
    weak var nameField: NSTextField?
    weak var projectField: NSTextField?
    weak var descriptionField: NSTextField?
    weak var descriptionLanguageField: NSTextField?
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
    func windowShouldClose(_ sender:NSWindow) -> Bool { cancelSelection(); return false }
    override func setFrameSize(_ newSize:NSSize) {
        let previous=bounds.size
        let hadSelection=selection.width>0 && selection.height>0
        super.setFrameSize(newSize)
        if hadSelection && previous.width>0 && previous.height>0 {
            selection=NSRect(x:selection.minX*newSize.width/previous.width,y:selection.minY*newSize.height/previous.height,width:selection.width*newSize.width/previous.width,height:selection.height*newSize.height/previous.height)
        }
        refresh()
    }
    var valid: Bool { selection.width >= 2 && selection.height >= 2 }
    func refresh() {
        needsDisplay = true; confirmButton?.isEnabled = valid; captureButton?.isEnabled = valid
        if valid {
            let cg=image.cgImage(forProposedRect:nil,context:nil,hints:nil)
            let w=Int((selection.width/bounds.width*CGFloat(cg?.width ?? Int(image.size.width))).rounded())
            let h=Int((selection.height/bounds.height*CGFloat(cg?.height ?? Int(image.size.height))).rounded())
            statusLabel?.stringValue="\(w) × \(h) pixels selecionados"
        } else { statusLabel?.stringValue="Nenhuma região selecionada" }
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
        response["case_id"] = projectField?.stringValue ?? ""
        response["description_text"] = descriptionField?.stringValue ?? ""
        response["description_language"] = descriptionLanguageField?.stringValue ?? "pt-BR"
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
    @objc func reloadPreview() { finish(["action":"refresh"]) }
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

final class FlippedView:NSView { override var isFlipped:Bool {true} }
final class PreviewScrollView: NSScrollView {
    var stepZoom: ((Int, NSPoint) -> Void)?
    private var accumulated: CGFloat = 0

    override func scrollWheel(with event: NSEvent) {
        if event.modifierFlags.contains(.shift) || abs(event.scrollingDeltaX) > abs(event.scrollingDeltaY) {
            accumulated = 0
            super.scrollWheel(with: event)
            return
        }
        guard event.momentumPhase.isEmpty else { return }
        if event.phase == .began { accumulated = 0 }
        let delta = event.scrollingDeltaY
        guard delta != 0 else { return }
        if event.hasPreciseScrollingDeltas {
            if accumulated * delta < 0 { accumulated = 0 }
            accumulated += delta
            guard abs(accumulated) >= 42 else { return }
            accumulated = 0
        }
        stepZoom?(delta > 0 ? 1 : -1, event.locationInWindow)
    }
}

final class PreviewPane:NSView {
    let region:RegionView
    private let viewport = PreviewScrollView()
    private let canvas = NSView()
    private let caption = NSTextField(labelWithString: "Prévia congelada")
    private let zoom = NSPopUpButton()
    private var zoomFactor: CGFloat = 1
    private var centerOnSelection = false

    init(region: RegionView) {
        self.region = region
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = NSColor(calibratedWhite: 0.09, alpha: 1).cgColor
        caption.font = .systemFont(ofSize: 11, weight: .semibold)
        caption.textColor = .lightGray
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let stamp = region.configuration["captured_at"] as? String, let date = parser.date(from: stamp) {
            caption.stringValue += " · " + DateFormatter.localizedString(from: date, dateStyle: .none, timeStyle: .medium)
        }

        zoom.addItems(withTitles: ["Ajustar", "2×", "4×", "8×"])
        zoom.toolTip = "Role sobre a imagem para ampliar ou reduzir. Shift + rolagem move a prévia."
        zoom.setAccessibilityLabel("Zoom da prévia")
        zoom.target = self
        zoom.action = #selector(changeZoom)
        viewport.stepZoom = { [weak self] step, point in self?.zoomAtCursor(step, point) }
        viewport.drawsBackground = false
        viewport.hasHorizontalScroller = true
        viewport.hasVerticalScroller = true
        viewport.autohidesScrollers = true
        viewport.scrollerStyle = .overlay
        viewport.documentView = canvas
        canvas.addSubview(region)
        addSubview(viewport)
        addSubview(caption)
        addSubview(zoom)
    }

    required init?(coder: NSCoder) { fatalError() }

    @objc private func changeZoom() {
        zoomFactor = [1, 2, 4, 8][zoom.indexOfSelectedItem]
        centerOnSelection = true
        needsLayout = true
        window?.makeFirstResponder(region)
    }

    private func zoomAtCursor(_ step: Int, _ location: NSPoint) {
        let index = min(zoom.numberOfItems - 1, max(0, zoom.indexOfSelectedItem + step))
        let point = region.convert(location, from: nil)
        guard index != zoom.indexOfSelectedItem, region.bounds.contains(point) else { return }
        let unit = NSPoint(x: point.x / region.bounds.width, y: point.y / region.bounds.height)
        zoom.selectItem(at: index)
        changeZoom()
        centerOnSelection = false
        layoutSubtreeIfNeeded()
        let clip = viewport.contentView
        let current = region.convert(location, from: nil)
        var proposed = clip.bounds
        proposed.origin.x += unit.x * region.bounds.width - current.x
        proposed.origin.y += unit.y * region.bounds.height - current.y
        clip.scroll(to: clip.constrainBoundsRect(proposed).origin)
        viewport.reflectScrolledClipView(clip)
    }

    override func layout() {
        super.layout()
        caption.frame = NSRect(x: 24, y: bounds.height - 36, width: bounds.width - 160, height: 20)
        zoom.frame = NSRect(x: bounds.width - 124, y: bounds.height - 40, width: 100, height: 28)
        viewport.frame = NSRect(x: 24, y: 16, width: max(1, bounds.width - 48), height: max(1, bounds.height - 68))
        let visible = viewport.contentSize
        guard visible.width > 0, visible.height > 0 else { return }
        let size = region.image.size
        let scale = min(visible.width / size.width, visible.height / size.height) * zoomFactor
        let fitted = NSSize(width: size.width * scale, height: size.height * scale)
        canvas.setFrameSize(NSSize(width: max(visible.width, fitted.width), height: max(visible.height, fitted.height)))
        region.frame = NSRect(x: (canvas.bounds.width - fitted.width) / 2, y: (canvas.bounds.height - fitted.height) / 2,
                              width: fitted.width, height: fitted.height)
        if centerOnSelection {
            centerOnSelection = false
            let focus = region.valid ? region.selection : region.bounds
            let center = region.convert(NSPoint(x: focus.midX, y: focus.midY), to: canvas)
            let clip = viewport.contentView
            let proposed = NSRect(x: center.x - visible.width / 2, y: center.y - visible.height / 2,
                                  width: visible.width, height: visible.height)
            clip.scroll(to: clip.constrainBoundsRect(proposed).origin)
            viewport.reflectScrolledClipView(clip)
        }
    }
}
