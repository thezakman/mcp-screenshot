import CoreImage
import AppKit
import CoreGraphics
import Foundation

// Local window metadata and image-region UI; no private Burp APIs or UI traversal.
func emit(_ value: Any) throws {
  let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  FileHandle.standardOutput.write(data)
}
let maskCoverages = ["full", "center80", "center", "center25"]
struct PrivacyMask: Codable {
  struct Box: Codable { var x, y, width, height: Double }
  var region: Box
  var style: String
  var coverage: String
  var horizontalInset: Double {
    switch coverage {
    case "center80": return 0.1
    case "center": return 0.25
    case "center25": return 0.375
    default: return 0
    }
  }
  func pixels(_ width: Int, _ height: Int) -> CGRect {
    let left = region.x + region.width * horizontalInset
    let w = region.width * (1 - 2 * horizontalInset)
    let x = floor(left * Double(width)),
      right = min(Double(width), ceil((left + w) * Double(width)))
    let top = floor(region.y * Double(height)),
      bottom = min(Double(height), ceil((region.y + region.height) * Double(height)))
    return CGRect(x: x, y: Double(height) - bottom, width: right - x, height: bottom - top)
  }
}
let renderingContext = CIContext()
func maskedImage(_ original: CGImage, _ masks: [PrivacyMask]) throws -> CGImage {
  var frame = CIImage(cgImage: original)
  for mask in masks {
    let rect = mask.pixels(original.width, original.height)
    let tile = frame.cropped(to: rect)
    let overlay: CIImage
    switch mask.style {
    case "black": overlay = CIImage(color: .black)
    case "blur":
      overlay = tile.clampedToExtent().applyingFilter(
        "CIGaussianBlur", parameters: [kCIInputRadiusKey: 16])
    case "pixelate":
      overlay = tile.clampedToExtent().applyingFilter(
        "CIPixellate", parameters: [kCIInputScaleKey: 16])
    default: throw NSError(domain: "Invalid mask style", code: 1)
    }
    frame = overlay.cropped(to: rect).composited(over: frame)
  }
  guard let result = renderingContext.createCGImage(frame, from: frame.extent) else {
    throw NSError(domain: "Mask rendering failed", code: 1)
  }
  return result
}

var english = false
func L(_ pt: String, _ en: String) -> String { english ? en : pt }
func dialogMessage(_ message: String) -> String {
  if english && message.hasPrefix("A imagem mudou") {
    return "The preview has changed. Select a region in the current image."
  }
  if english && message.hasPrefix("Perfil inválido ignorado:") {
    return message.replacingOccurrences(
      of: "Perfil inválido ignorado:", with: "Skipped invalid profile:"
    ).replacingOccurrences(
      of: "Corrija ou remova esse arquivo para recuperá-lo.", with: "Repair or remove the file.")
  }
  let translations = [
    "The suggested masks belong to an older preview. Review the crop and mark the sensitive areas again.":
      "As máscaras foram sugeridas para outra prévia. Revise o recorte e marque novamente as áreas sensíveis.",
    "Name already exists. Use a new name to save adjusted geometry.":
      "Esse nome já existe. Escolha outro para salvar o recorte ajustado.",
    "Profiles require a window. Choose a window to save a profile.":
      "Escolha uma janela para salvar um perfil.",
    "Window no longer available": "A janela não está mais disponível.",
    "Invalid target": "Origem inválida.",
    "Original checksum mismatch.": "A soma de verificação do original divergiu.",
  ]
  return english ? message : translations[message] ?? message
}
let command = CommandLine.arguments.dropFirst().first ?? "status"
do {
  switch command {
  case "redact":
    let args = Array(CommandLine.arguments.dropFirst(2))
    guard args.count == 3, let input = NSImage(contentsOfFile: args[0]),
      let cg = input.cgImage(forProposedRect: nil, context: nil, hints: nil)
    else { throw NSError(domain: "Invalid input", code: 1) }
    let masks = try JSONDecoder().decode([PrivacyMask].self, from: Data(args[2].utf8))
    let output = try maskedImage(cg, masks)
    guard let png = NSBitmapImageRep(cgImage: output).representation(using: .png, properties: [:])
    else { throw NSError(domain: "PNG encoding failed", code: 1) }
    try png.write(to: URL(fileURLWithPath: args[1]), options: .atomic)
    try emit(["ok": true])
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
        let prefs=config["preferences"] as? [String:Any] ?? [:]
        let preferred=prefs["language"] as? String ?? "auto"
        let detected=config["locale"] as? String ?? Locale.preferredLanguages.first ?? "en"
        english = !(preferred=="auto" ? detected : preferred).lowercased().hasPrefix("pt")
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let screen = NSScreen.main!.visibleFrame
        let size = NSSize(width:min(1280,screen.width-80),height:min(820,screen.height-100))
        let window = SelectionWindow(contentRect:NSRect(origin:.zero,size:size),styleMask:[.titled,.closable,.miniaturizable,.resizable],backing:.buffered,defer:false)
        window.title = L("Captura","Capture")
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
        add(label(L("Nova captura","New capture"),22,.semibold))
        if let request=config["request"] as? String { section(L("PEDIDO","REQUEST"),label(request,11)) }
        if let reason=config["suggestion_reason"] as? String {
            region.toolTip = reason
        }
        let targets=NSPopUpButton()
        targets.lineBreakMode = .byTruncatingMiddle
        for target in config["targets"] as? [[String:Any]] ?? [] {
            targets.addItem(withTitle:target["title"] as? String ?? "")
            targets.lastItem?.representedObject=target["id"]
            if target["id"] as? String == config["current_target"] as? String { targets.select(targets.lastItem) }
        }
        targets.target=region; targets.action=#selector(RegionView.changeTarget(_:))
        targets.toolTip = targets.titleOfSelectedItem
        targets.setAccessibilityLabel(L("Origem","Source"))
        let reload = NSButton(title:L("Atualizar","Refresh"),target:region,action:#selector(RegionView.reloadPreview))
        if let icon = NSImage(systemSymbolName:"arrow.clockwise", accessibilityDescription:nil) {
            reload.image = icon
            reload.imagePosition = .imageOnly
        }
        reload.setAccessibilityLabel(L("Atualizar prévia","Refresh preview"))
        reload.setContentHuggingPriority(.required, for:.horizontal)
        targets.setContentCompressionResistancePriority(.defaultLow, for:.horizontal)
        reload.toolTip=L("Obtém uma nova imagem e limpa a seleção anterior para você revisar o conteúdo atual.","Take a fresh image and clear the previous selection.")
        section(L("ORIGEM","SOURCE"),NSStackView(views:[targets,reload]))
        let names=NSPopUpButton()
        names.addItem(withTitle:L("Seleção livre","Free selection"))
        for profile in config["profiles"] as? [[String:Any]] ?? [] { names.addItem(withTitle:profile["name"] as? String ?? "") }
        if let current=config["name"] as? String,names.itemTitles.contains(current) {names.selectItem(withTitle:current)}
        names.target=region; names.action=#selector(RegionView.loadProfile(_:)); section(L("REGIÃO FIXA","FIXED REGION"),names)
        let name=NSTextField()
        name.placeholderString=L("Opcional","Optional"); name.stringValue=config["name"] as? String ?? ""
        name.heightAnchor.constraint(equalToConstant:28).isActive=true; region.nameField=name
        name.toolTip=L("Salva coordenadas fixas; não se adapta ao tamanho de novos payloads ou respostas. Deixe vazio para capturar somente agora.","Save fixed coordinates. Leave blank for a one-time capture."); section(L("NOME DO PERFIL","PROFILE NAME"),name)
        let redact=NSButton(checkboxWithTitle:L("Editar máscaras","Edit masks"),target:region,action:#selector(RegionView.togglePrivacy(_:)))
        redact.toolTip=L("Arraste na imagem para criar uma máscara. Use as setas para mover a máscara selecionada e Delete para excluir.","Drag on the image to create a mask. Use arrows to move the selected mask and Delete to remove it.")
        add(redact)
        let styles=NSPopUpButton(), coverage=NSPopUpButton(), classification=NSPopUpButton()
    styles.addItems(withTitles: [
      L("Bloco preto", "Black block"), L("Desfoque", "Blur"), L("Pixelado", "Pixelate"),
    ])
    coverage.addItems(withTitles: [
      L("100% · inteiro", "100% · full"), L("80% central", "Middle 80%"),
      L("50% central", "Middle 50%"), L("25% central", "Middle 25%"),
    ])
    for menu in [styles, coverage] {
      menu.target = region; menu.action = #selector(RegionView.editStyle(_:))
    }
    let remove = NSButton(title: L("Excluir", "Delete"), target: region, action: #selector(RegionView.removeMask))
    remove.toolTip = L("Excluir máscara selecionada (Delete)", "Delete selected mask (Delete)")
    classification.addItems(withTitles: [
      L("Não classificado", "Unclassified"), L("Sensível", "Sensitive"),
      L("Revisado · sem dados sensíveis", "Reviewed · no sensitive data"),
    ])
    classification.selectItem(at: (config["sensitive"] as? Bool).map { $0 ? 1 : 2 } ?? 0)
    let original = NSButton(
      checkboxWithTitle: L("Incluir original sem censura", "Include unredacted original"),
      target: nil, action: nil)
    original.toolTip = L(
      "O original contém os dados ocultos.", "The original contains the hidden data.")
    original.state = config["keep_original"] as? Bool == true ? .on : .off
    let applyMasks = NSButton(
      checkboxWithTitle: L("Aplicar máscaras", "Apply masks"), target: region,
      action: #selector(RegionView.applyMasksChanged))
    applyMasks.state = (config["apply_masks"] as? Bool ?? true) ? .on : .off
    region.applyToggle = applyMasks
    let scope = NSButton(title: L("Todas","All"), target: region, action: #selector(RegionView.selectAllMasks))
    scope.bezelStyle = .inline
    region.maskScope = scope
    let scopeLabel = label("", 12, .medium)
    region.scopeLabel = scopeLabel
    let scopeRow = NSStackView(views: [scopeLabel, NSView(), scope, remove])
    let options = NSStackView(views: [styles, coverage])
    options.distribution = .fillEqually
    styles.setAccessibilityLabel(L("Estilo da máscara","Mask style"))
    coverage.setAccessibilityLabel(L("Cobertura da máscara","Mask coverage"))
    classification.setAccessibilityLabel(L("Classificação dos dados","Data classification"))
    let sensitivity = label(L("Classificação · Sensível","Classification · Sensitive"), 11)
    sensitivity.textColor = .secondaryLabelColor
    region.sensitivityLabel = sensitivity
    let panel = NSStackView(views: [scopeRow, options, applyMasks, classification, sensitivity])
    panel.orientation = .vertical
    panel.alignment = .leading
    panel.spacing = 6
    add(panel)
    for row in [scopeRow, options] {
      row.widthAnchor.constraint(equalTo: panel.widthAnchor).isActive = true
    }
    region.styleMenu = styles; region.coverageMenu = coverage;
    region.classification = classification; region.originalToggle = original;
    region.privacyPanel = panel; region.deleteButton = remove
    if let value = config["masks"], let data = try? JSONSerialization.data(withJSONObject: value) {
      region.masks = try JSONDecoder().decode([PrivacyMask].self, from: data)
    }
    region.editingMasks = region.requestedRedaction || !region.masks.isEmpty
    redact.state = region.editingMasks ? .on : .off; panel.isHidden = !region.editingMasks
    let descriptionConfig = config["description"] as? [String: Any] ?? [:]
    let description = NSTextField()
    description.placeholderString = L(
      "Descreva o recorte (opcional)", "Describe the crop (optional)")
    description.toolTip = L(
      "A IA pode sugerir uma descrição ao abrir a prévia. Ao atualizar a imagem, revise o recorte e escreva uma nova descrição.",
      "AI can suggest a description when opening the preview. Refreshing clears the description.")
    description.stringValue = descriptionConfig["text"] as? String ?? ""
    description.cell?.wraps = true; description.cell?.isScrollable = false
    description.heightAnchor.constraint(equalToConstant: 56).isActive = true
    region.descriptionField = description
    let language = NSTextField()
    language.stringValue =
      descriptionConfig["language"] as? String ?? config["locale"] as? String
      ?? (english ? "en" : "pt-BR")
    language.placeholderString = "pt-BR, en…"
        language.heightAnchor.constraint(equalToConstant:26).isActive=true
        region.descriptionLanguageField=language
        language.widthAnchor.constraint(equalToConstant:68).isActive=true
        language.toolTip=L("Idioma da descrição","Description language"); language.setAccessibilityLabel(L("Idioma da descrição","Description language"))
        let heading=label(L("DESCRIÇÃO","DESCRIPTION"),11,.semibold); heading.textColor = .secondaryLabelColor
        let languageHeading=label(L("IDIOMA","LANGUAGE"),11,.semibold); languageHeading.textColor = .secondaryLabelColor
        let descriptionHeader=NSStackView(views:[heading,NSView(),languageHeading,language])
        descriptionHeader.spacing=6
        add(descriptionHeader); stack.setCustomSpacing(4,after:descriptionHeader); add(description)
        let project=NSTextField()
        project.placeholderString=L("Automático · data + UUID","Automatic · date + UUID"); project.stringValue=config["case_id"] as? String ?? ""
        project.heightAnchor.constraint(equalToConstant:28).isActive=true; region.projectField=project
        section(L("PROJETO","PROJECT"),project)
        let destination=NSTextField(labelWithString:config["destination"] as? String ?? "")
        destination.lineBreakMode = .byTruncatingMiddle; destination.font = .systemFont(ofSize:11); destination.toolTip=destination.stringValue
        section(L("PASTA BASE","BASE FOLDER"),destination)
        let settings=button(L("Pasta e perfis…","Settings and profiles…"),#selector(RegionView.settings)); add(settings)
        let pin=NSButton(checkboxWithTitle:L("Manter janela no topo","Keep window on top"),target:region,action:#selector(RegionView.togglePinned(_:)))
        pin.state = .on
        let divider = NSBox()
        divider.boxType = .separator
        footer.addArrangedSubview(divider)
        divider.widthAnchor.constraint(equalTo:footer.widthAnchor,constant:-36).isActive=true
        footer.addArrangedSubview(original)
        let capture=button(L("Capturar e salvar","Capture and save"),#selector(RegionView.captureSelection))
        capture.keyEquivalent="\r"; capture.toolTip=L("Salva o recorte da prévia atual.","Save this crop of the current preview."); region.captureButton=capture; footer.addArrangedSubview(capture)
        capture.widthAnchor.constraint(equalTo:footer.widthAnchor,constant:-36).isActive=true
        let save=button(L("Salvar apenas a seleção","Save selection only"),#selector(RegionView.confirmSelection))
        save.toolTip=L("Confirma a região e salva o perfil nomeado, sem criar screenshot.","Confirm the selection and optional profile without saving an image."); region.confirmButton=save
        let cancel=button(L("Cancelar","Cancel"),#selector(RegionView.cancelSelection)); cancel.keyEquivalent="\u{1b}"
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
        region.renderPrivacy()
        window.contentView=container
        container.layoutSubtreeIfNeeded()
        window.center()
        window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
        window.makeFirstResponder(region)
        if let error=config["error"] as? String {
            let alert=NSAlert(); alert.messageText=L("Não foi possível concluir","Could not complete the action"); alert.informativeText=error
            alert.informativeText=dialogMessage(error)
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
    var masks: [PrivacyMask] = []
    var activeMask: Int?
    var editingMasks = false
    var maskDraft = NSRect.zero
    var rendered: NSImage?
    var renderFailed = false
    weak var privacyPanel:NSStackView?
    weak var styleMenu:NSPopUpButton?
    weak var coverageMenu:NSPopUpButton?
    weak var classification:NSPopUpButton?
    weak var applyToggle:NSButton?
    var applying:Bool {applyToggle?.state != .off}
    lazy var pixelSize: CGSize = {
        guard let bitmap = image.cgImage(forProposedRect:nil, context:nil, hints:nil) else { return image.size }
        return CGSize(width:bitmap.width, height:bitmap.height)
    }()
    var maskGesture=false
  @objc func applyMasksChanged() { renderPrivacy(); window?.makeFirstResponder(self) }
  weak var originalToggle: NSButton?
  weak var scopeLabel: NSTextField?
  weak var sensitivityLabel: NSTextField?
  weak var maskScope: NSButton?
  weak var deleteButton: NSButton?
  var requestedRedaction: Bool { configuration["redact"] as? Bool == true }
  func maskRect(_ mask: PrivacyMask) -> NSRect {
    let r = mask.region
    return NSRect(
      x: r.x * bounds.width, y: (1 - r.y - r.height) * bounds.height, width: r.width * bounds.width,
      height: r.height * bounds.height)
  }
  func box(_ rect: NSRect) -> PrivacyMask.Box {
    .init(
      x: rect.minX / bounds.width, y: (bounds.height - rect.maxY) / bounds.height,
      width: rect.width / bounds.width, height: rect.height / bounds.height)
  }
  func overlapsCrop(_ mask: PrivacyMask) -> Bool {
    var r = maskRect(mask)
    r = r.insetBy(dx: r.width * mask.horizontalInset, dy: 0)
    return r.intersects(selection) && valid
  }
  var previousClassification = 0
  func syncPrivacy() {
    let any = applying && masks.contains(where: overlapsCrop)
    if any, let menu = classification, menu.isEnabled {
      previousClassification = menu.indexOfSelectedItem
      menu.selectItem(at: 1); menu.isEnabled = false
    } else if !any, let menu = classification, !menu.isEnabled {
      menu.selectItem(at: previousClassification); menu.isEnabled = true
    }
    captureButton?.title = any ? L("Salvar com censura","Save redacted image") : L("Capturar e salvar","Capture and save")
    sensitivityLabel?.isHidden = !any
    classification?.isHidden = any
    originalToggle?.isHidden = !any
    if !any { originalToggle?.state = .off }
    deleteButton?.isHidden = activeMask == nil
    if let i = activeMask {
      scopeLabel?.stringValue = L("Máscara","Mask") + " \(i + 1) / \(masks.count)"
      styleMenu?.selectItem(at: ["black", "blur", "pixelate"].firstIndex(of: masks[i].style) ?? 0)
      coverageMenu?.selectItem(at: maskCoverages.firstIndex(of: masks[i].coverage) ?? 0)
    } else {
      scopeLabel?.stringValue = masks.isEmpty ? L("Nova máscara","New mask") : L("Todas as máscaras","All masks") + " (\(masks.count))"
      if let first=masks.first {
        styleMenu?.selectItem(at: masks.allSatisfy{$0.style == first.style} ? ["black","blur","pixelate"].firstIndex(of:first.style) ?? 0 : -1)
        coverageMenu?.selectItem(at: masks.allSatisfy{$0.coverage == first.coverage} ? (maskCoverages.firstIndex(of: first.coverage) ?? 0) : -1)
      }
    }
    maskScope?.isHidden = activeMask == nil
    needsDisplay = true
  }
  func renderPrivacy() {
    rendered = nil; renderFailed = false
    if applying && !masks.isEmpty {
      if let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
        let result = try? maskedImage(cg, masks)
      {
        rendered = NSImage(cgImage: result, size: image.size)
      } else {
        renderFailed = true
      }
    }
    syncPrivacy(); refresh()
  }
  @objc func togglePrivacy(_ sender: NSButton) {
    editingMasks = sender.state == .on
    privacyPanel?.isHidden = !editingMasks
    activeMask = nil
    syncPrivacy()
    window?.makeFirstResponder(self)
  }
  @objc func selectAllMasks() {
    activeMask = nil
    syncPrivacy()
  }
  @objc func editStyle(_ sender:NSPopUpButton) {
    let selected = sender.indexOfSelectedItem
    guard selected >= 0 else {return}
    for index in masks.indices where activeMask == nil || activeMask == index {
      if sender === styleMenu {masks[index].style = ["black","blur","pixelate"][selected]}
      else {masks[index].coverage = maskCoverages[selected]}
    }
    renderPrivacy()
    window?.makeFirstResponder(self)
  }
  @objc func removeMask() {
    if let i = activeMask { masks.remove(at: i); activeMask = nil; renderPrivacy() }
  }
  func checkPrivacy() -> Bool {
    let any = applying && masks.contains(where: overlapsCrop)
    if requestedRedaction && !any {
      let alert = NSAlert()
      alert.messageText = L("Salvar sem máscara?", "Save without a mask?")
      alert.informativeText = L("Nenhuma máscara cobre o recorte.", "No mask covers the crop.")
      alert.addButton(withTitle: L("Voltar", "Go back"));
      alert.addButton(withTitle: L("Salvar sem máscara", "Save without a mask"))
      if alert.runModal() != .alertSecondButtonReturn { return false }
    }
    if any, let field = descriptionField, !field.stringValue.isEmpty {
      let alert = NSAlert(); alert.messageText = L("Revise a descrição", "Review the description")
      alert.informativeText = field.stringValue
      alert.addButton(withTitle: L("Voltar", "Go back"));
      alert.addButton(withTitle: L("Manter descrição", "Keep description"));
      alert.addButton(withTitle: L("Remover descrição", "Remove description"))
      let answer = alert.runModal()
      if answer == .alertFirstButtonReturn { window?.makeFirstResponder(field); return false }
      if answer == .alertThirdButtonReturn { field.stringValue = "" }
    }
    return !renderFailed
  }
  @objc func preferencesDialog() {
    let prefs = configuration["preferences"] as? [String: Any] ?? [:]
    let languages = NSPopUpButton()
    languages.addItems(withTitles: [L("Automático", "Automatic"), "Português (Brasil)", "English"])
    languages.selectItem(
      at: ["auto", "pt-BR", "en"].firstIndex(of: prefs["language"] as? String ?? "") ?? 0)
    let suggest = NSButton(
      checkboxWithTitle: L(
        "Sugerir áreas sensíveis por padrão", "Suggest sensitive areas by default"), target: nil,
      action: nil)
    suggest.state = prefs["suggest_sensitive"] as? Bool == true ? .on : .off
    let form = NSStackView(views: [languages, suggest]); form.orientation = .vertical;
    form.frame = NSRect(x: 0, y: 0, width: 320, height: 60)
    let alert = NSAlert(); alert.messageText = L("Idioma e privacidade", "Language and privacy");
    alert.accessoryView = form
    alert.addButton(withTitle: L("Salvar", "Save"));
    alert.addButton(withTitle: L("Cancelar", "Cancel"))
    if alert.runModal() == .alertFirstButtonReturn {
      finish([
        "action": "preferences",
        "preferences": [
          "language": ["auto", "pt-BR", "en"][languages.indexOfSelectedItem],
          "suggest_sensitive": suggest.state == .on,
        ],
      ])
    }
  }
  var configuration: [String: Any] = [:]
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
        needsDisplay = true; captureButton?.isEnabled = valid && !renderFailed; confirmButton?.isHidden = requestedRedaction || !masks.isEmpty; confirmButton?.isEnabled = valid && !requestedRedaction && masks.isEmpty
        if valid {
            let left = floor(selection.minX / bounds.width * pixelSize.width)
            let right = ceil(selection.maxX / bounds.width * pixelSize.width)
            let top = floor((bounds.height - selection.maxY) / bounds.height * pixelSize.height)
            let bottom = ceil((bounds.height - selection.minY) / bounds.height * pixelSize.height)
            statusLabel?.stringValue = "\(Int(right-left)) × \(Int(bottom-top)) px"
        } else { statusLabel?.stringValue=L("Nenhuma região selecionada","No region selected") }
    }
    func handles(_ selection:NSRect) -> [NSPoint] {
        [NSPoint(x:selection.minX,y:selection.minY),NSPoint(x:selection.midX,y:selection.minY),NSPoint(x:selection.maxX,y:selection.minY),
         NSPoint(x:selection.minX,y:selection.midY),NSPoint(x:selection.maxX,y:selection.midY),
         NSPoint(x:selection.minX,y:selection.maxY),NSPoint(x:selection.midX,y:selection.maxY),NSPoint(x:selection.maxX,y:selection.maxY)]
    }
    override func draw(_ dirtyRect: NSRect) {
        if renderFailed { NSColor.black.setFill(); bounds.fill() }
        else {(rendered ?? image).draw(in:bounds)}
        if editingMasks {
            NSColor.systemOrange.setStroke()
            for (i,mask) in masks.enumerated() {
                let outline=NSBezierPath(rect:maskRect(mask));outline.lineWidth=(activeMask==i ? 3:1);outline.stroke()
                if activeMask==i {
                    NSColor.systemOrange.setFill()
                    for point in handles(maskRect(mask)) {NSRect(x:point.x-3,y:point.y-3,width:6,height:6).fill()}
                }
            }
            NSBezierPath.stroke(maskDraft)
        }
        if valid {
            let shade = NSBezierPath(rect: bounds)
            shade.append(NSBezierPath(rect: selection)); shade.windingRule = .evenOdd
            NSColor.black.withAlphaComponent(0.45).setFill(); shade.fill()
            NSColor.systemBlue.setStroke()
            let path = NSBezierPath(rect: selection); path.lineWidth = 2; path.stroke()
            for point in handles(selection) {
                let handle = NSBezierPath(rect: NSRect(x: point.x-4, y: point.y-4, width: 8, height: 8))
                NSColor.white.setFill(); handle.fill(); NSColor.systemBlue.setStroke(); handle.stroke()
            }
        }
    }
    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        let point=convert(event.locationInWindow,from:nil)
        let cropHandle = handles(selection).contains { abs($0.x-point.x)<=8 && abs($0.y-point.y)<=8 }
        let moveCrop = event.modifierFlags.contains(.option) && selection.contains(point)
        maskGesture = editingMasks && valid && !cropHandle && !moveCrop
        if !maskGesture {activeMask=nil;syncPrivacy()}
        if maskGesture {
            activeMask=masks.indices.reversed().first { maskRect(masks[$0]).insetBy(dx:-4,dy:-4).contains(point) }
            maskDraft=activeMask.map { maskRect(masks[$0]) } ?? .zero
            syncPrivacy()
        }
        let crop=selection
        if maskGesture { selection=maskDraft }
        defer {if maskGesture {maskDraft=selection;selection=crop;refresh()}}
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
        if dragMode == "draw" { selection = .zero; if !maskGesture {cropChanged()}; refresh() }
    }
    override func mouseDragged(with event: NSEvent) {
        let crop=selection
        if maskGesture {selection=maskDraft}
        defer {
            if maskGesture {maskDraft=selection;selection=crop;refresh()}
            else if selection != crop {cropChanged()}
        }
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
    override func mouseUp(with event:NSEvent) {
        guard maskGesture else {return}
        maskGesture = false
        if maskDraft == original { maskDraft = .zero; needsDisplay = true; return }
        if maskDraft.width>=2 && maskDraft.height>=2 {
            let mask=PrivacyMask(region:box(maskDraft),style:["black","blur","pixelate"][max(0,styleMenu!.indexOfSelectedItem)],coverage:maskCoverages[max(0, coverageMenu?.indexOfSelectedItem ?? 0)])
            if let i=activeMask {masks[i]=mask}
            else if masks.count<64 {masks.append(mask);activeMask=masks.count-1}
            else {NSSound.beep()}
        }
        maskDraft = .zero;renderPrivacy()
    }
    func cropChanged() {previousClassification=0; if classification?.isEnabled == true {classification?.selectItem(at:0)};syncPrivacy()}
    @objc func resetSelection() { selection = .zero; cropChanged(); refresh(); window?.makeFirstResponder(self) }
    @objc func cancelSelection() { try? emit(["cancelled": true]); exit(0) }
    func finish(_ value:[String:Any]) {
        var response=value
        do {response["masks"] = try JSONSerialization.jsonObject(with:JSONEncoder().encode(masks))}
        catch {NSSound.beep();return}
        switch classification?.isEnabled == true ? classification?.indexOfSelectedItem : previousClassification {case 1: response["sensitive"]=true;case 2:response["sensitive"]=false;default:response["sensitive"]=NSNull()}
        response["apply_masks"]=applying
        response["keep_original"]=originalToggle?.state == .on && masks.contains(where:overlapsCrop)
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
    @objc func selectAllImage() { selection=bounds; cropChanged(); refresh(); window?.makeFirstResponder(self) }
    @objc func confirmSelection() {
        guard valid else { NSSound.beep(); return }
        guard !requestedRedaction && masks.isEmpty else {NSSound.beep();return}
        if configuration.isEmpty { finish(selectedRegion()); return }
        finish(["action":"confirm","region":selectedRegion(),"name":nameField?.stringValue ?? ""])
    }
    @objc func captureSelection() {
        guard valid else { NSSound.beep(); return }
        guard checkPrivacy() else { return }
        finish(["action":"capture","region":selectedRegion(),"name":nameField?.stringValue ?? ""])
    }
    @objc func loadProfile(_ sender:NSPopUpButton) {
        let profiles=configuration["profiles"] as? [[String:Any]] ?? []
        let index=sender.indexOfSelectedItem-1
        guard index>=0 && index<profiles.count, let r=profiles[index]["region"] as? [String:Double],
              let x=r["x"], let y=r["y"], let w=r["width"], let h=r["height"] else { nameField?.stringValue=""; return }
        selection=NSRect(x:x*bounds.width,y:(1-y-h)*bounds.height,width:w*bounds.width,height:h*bounds.height)
        cropChanged(); nameField?.stringValue=profiles[index]["name"] as? String ?? ""; refresh()
    }
    @objc func reloadPreview() { finish(["action":"refresh"]) }
    @objc func changeTarget(_ sender:NSPopUpButton) {
        guard let target=sender.selectedItem?.representedObject as? String else { return }
        finish(["action":"target","target":target])
    }
    @objc func settings() {
        let alert=NSAlert()
        alert.messageText=L("Configurações e perfis","Settings and profiles")
        alert.informativeText=L("Capturas: \(configuration["destination"] as? String ?? "")\nPerfis: \(configuration["profiles_directory"] as? String ?? "")\nMudar o destino não move capturas existentes.","Captures: \(configuration["destination"] as? String ?? "")\nProfiles: \(configuration["profiles_directory"] as? String ?? "")\nChanging the destination leaves existing captures in place.")
        alert.addButton(withTitle:L("Escolher pasta…","Choose folder…"))
        alert.addButton(withTitle:L("Renomear perfil…","Rename profile…"))
        alert.addButton(withTitle:L("Apagar perfil…","Delete profile…"))
        alert.addButton(withTitle:L("Idioma e privacidade…","Language and privacy…"))
        alert.addButton(withTitle:L("Fechar","Close"))
        if configuration["destination_locked"] as? Bool == true { alert.buttons[0].isEnabled=false; alert.informativeText += "\n"+L("Destino definido por MCP_SCREENSHOT_DIR.","Destination set by MCP_SCREENSHOT_DIR.") }
        let list=NSPopUpButton(frame:NSRect(x:0,y:0,width:360,height:28))
        for p in configuration["all_profiles"] as? [[String:Any]] ?? [] {list.addItem(withTitle:p["name"] as? String ?? "")}
        alert.accessoryView=list
        let choice=alert.runModal()
        if choice.rawValue == NSApplication.ModalResponse.alertFirstButtonReturn.rawValue+3 { preferencesDialog();return }
        if choice == .alertFirstButtonReturn {
            let panel=NSOpenPanel(); panel.canChooseFiles=false; panel.canChooseDirectories=true; panel.canCreateDirectories=true; panel.allowsMultipleSelection=false
            if panel.runModal() == .OK, let url=panel.url { finish(["action":"destination","destination":url.path]) }
        } else if choice == .alertSecondButtonReturn, let name=list.titleOfSelectedItem {
            let rename=NSAlert(); rename.messageText=L("Renomear","Rename")+" "+name; rename.addButton(withTitle:L("Renomear","Rename")); rename.addButton(withTitle:L("Cancelar","Cancel"))
            let field=NSTextField(frame:NSRect(x:0,y:0,width:360,height:26)); field.stringValue=name; rename.accessoryView=field
            if rename.runModal() == .alertFirstButtonReturn {finish(["action":"rename","name":name,"new_name":field.stringValue])}
        } else if choice == .alertThirdButtonReturn, let name=list.titleOfSelectedItem {
            let confirm=NSAlert(); confirm.messageText=L("Apagar perfil","Delete profile")+" "+name+"?"; confirm.informativeText=L("As capturas existentes serão preservadas.","Existing captures will be kept."); confirm.addButton(withTitle:L("Apagar","Delete"));confirm.addButton(withTitle:L("Cancelar","Cancel"))
            if confirm.runModal() == .alertFirstButtonReturn {finish(["action":"delete","name":name])}
        }
        window?.makeFirstResponder(self)
    }
    override func keyDown(with event: NSEvent) {
        if editingMasks && activeMask != nil && [51,117].contains(event.keyCode) {
            removeMask()
            return
        }
        if event.keyCode == 53 { cancelSelection(); return }
        if event.keyCode == 36 || event.keyCode == 76 { if requestedRedaction || !masks.isEmpty {captureSelection()} else {confirmSelection()}; return }
        if valid && [123,124,125,126].contains(event.keyCode) {
            let step: CGFloat = event.modifierFlags.contains(.shift) ? 10 : 1
            let dx: CGFloat = event.keyCode == 123 ? -step : event.keyCode == 124 ? step : 0
            let dy: CGFloat = event.keyCode == 125 ? -step : event.keyCode == 126 ? step : 0
            if editingMasks, let index = activeMask {
                var rect = maskRect(masks[index])
                rect.origin.x = max(0, min(bounds.width - rect.width, rect.minX + dx))
                rect.origin.y = max(0, min(bounds.height - rect.height, rect.minY + dy))
                masks[index].region = box(rect)
                renderPrivacy()
            } else {
                selection.origin.x = max(0,min(bounds.width-selection.width,selection.minX+dx))
                selection.origin.y = max(0,min(bounds.height-selection.height,selection.minY+dy))
                cropChanged();refresh()
            }
            return
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
    private let caption = NSTextField(labelWithString: L("Prévia congelada","Frozen preview"))
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

        zoom.addItems(withTitles: [L("Ajustar","Fit"), "2×", "4×", "8×"])
        zoom.toolTip = L("Role sobre a imagem para ampliar ou reduzir. Shift + rolagem move a prévia.","Scroll over the image to zoom. Shift-scroll to pan.")
        zoom.setAccessibilityLabel(L("Zoom da prévia","Preview zoom"))
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
        let all = NSButton(title:L("Imagem inteira","Whole image"),target:region,action:#selector(RegionView.selectAllImage))
        let clear = NSButton(title:L("Limpar recorte","Clear crop"),target:region,action:#selector(RegionView.resetSelection))
        let status = NSTextField(labelWithString:"")
        status.font = .monospacedDigitSystemFont(ofSize:11, weight:.medium)
        status.textColor = .lightGray
        status.toolTip = L("Alças azuis ajustam o recorte. ⌥ + arrastar move.","Blue handles resize the crop. Option-drag moves it.")
        region.statusLabel = status
        let bar = NSStackView(views:[status, NSView(), all, clear])
        bar.translatesAutoresizingMaskIntoConstraints = false
        addSubview(bar)
        NSLayoutConstraint.activate([
            bar.leadingAnchor.constraint(equalTo:leadingAnchor,constant:24),
            bar.trailingAnchor.constraint(equalTo:trailingAnchor,constant:-24),
            bar.bottomAnchor.constraint(equalTo:bottomAnchor,constant:-10)
        ])
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
        viewport.frame = NSRect(x: 24, y: 44, width: max(1, bounds.width - 48), height: max(1, bounds.height - 96))
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
