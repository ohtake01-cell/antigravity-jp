import Cocoa
import IOKit.pwr_mgt
import UserNotifications
import WebKit

private let defaultPort = "3470"
private let defaultHost = "127.0.0.1"

private struct AppConfig {
    let host: String
    let port: String
    let baseURL: URL
    let runtimeDir: String?
}

private func parseEnvFile(at path: String) -> [String: String] {
    guard let content = try? String(contentsOfFile: path, encoding: .utf8) else {
        return [:]
    }
    var result: [String: String] = [:]
    for rawLine in content.components(separatedBy: .newlines) {
        let line = rawLine.trimmingCharacters(in: .whitespaces)
        if line.isEmpty || line.hasPrefix("#") { continue }
        let parts = line.split(separator: "=", maxSplits: 1)
        if parts.count != 2 { continue }
        let key = parts[0].trimmingCharacters(in: .whitespaces)
        var val = String(parts[1]).trimmingCharacters(in: .whitespaces)
        if let hashIdx = val.range(of: " #") {
            val = String(val[..<hashIdx.lowerBound]).trimmingCharacters(in: .whitespaces)
        }
        val = val.trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
        result[key] = val
    }
    return result
}

private func resolveAppConfig() -> AppConfig {
    let fm = FileManager.default
    let home = fm.homeDirectoryForCurrentUser.path
    let supportDir = "\(home)/Library/Application Support/AntigravityJP"

    let envFromSupport = parseEnvFile(at: "\(supportDir)/config.env")
    let envProcess = ProcessInfo.processInfo.environment

    let hostRaw = envProcess["PORTA_HOST"] ?? envFromSupport["PORTA_HOST"] ?? defaultHost
    let host = (hostRaw == "0.0.0.0" || hostRaw == "::" || hostRaw == "[::]") ? "127.0.0.1" : hostRaw
    let port = envProcess["PORTA_PORT"] ?? envFromSupport["PORTA_PORT"] ?? defaultPort

    let baseURLString = envProcess["AG_JP_APP_URL"] ?? "http://\(host):\(port)/"
    let baseURL = URL(string: baseURLString.hasSuffix("/") ? baseURLString : "\(baseURLString)/")
        ?? URL(string: "http://127.0.0.1:\(defaultPort)/")!

    var runtimeCandidates: [String] = []
    if let envDir = envProcess["AG_JP_RUNTIME_DIR"], !envDir.isEmpty {
        runtimeCandidates.append(envDir)
    }
    if let cfgDir = envFromSupport["AG_JP_RUNTIME_DIR"], !cfgDir.isEmpty {
        runtimeCandidates.append(cfgDir)
    }
    if let resPath = Bundle.main.resourcePath {
        runtimeCandidates.append("\(resPath)/runtime")
    }
    runtimeCandidates.append("\(supportDir)/runtime")
    let bundleParent = (Bundle.main.bundlePath as NSString).deletingLastPathComponent
    runtimeCandidates.append("\(bundleParent)/runtime")
    runtimeCandidates.append(bundleParent)

    var resolvedRuntime: String?
    for dir in runtimeCandidates {
        if fm.fileExists(atPath: "\(dir)/proxy/dist/index.js")
            || fm.fileExists(atPath: "\(dir)/packages/proxy/dist/index.js")
        {
            resolvedRuntime = dir
            break
        }
    }

    return AppConfig(host: host, port: port, baseURL: baseURL, runtimeDir: resolvedRuntime)
}

private func findNodeBinary(runtimeDir: String?) -> String? {
    let fm = FileManager.default
    let home = fm.homeDirectoryForCurrentUser.path
    var candidates: [String] = []

    // 1. 最優先: アプリ内蔵の Universal Node.js（Apple Silicon / Intel 両対応・Node未導入Macでも即起動）
    if let runtimeDir, !runtimeDir.isEmpty {
        candidates.append("\(runtimeDir)/bin/node")
    }
    if let resPath = Bundle.main.resourcePath {
        candidates.append("\(resPath)/runtime/bin/node")
    }

    // 2. フォールバック: 環境変数およびシステム導入済み Node.js
    candidates.append(contentsOf: [
        ProcessInfo.processInfo.environment["AG_JP_NODE_BIN"] ?? "",
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "\(home)/.volta/bin/node",
        "\(home)/.asdf/shims/node",
        "\(home)/.fnm/current/bin/node",
    ])

    // nvm で導入された Node.js も降順検索
    let nvmDir = "\(home)/.nvm/versions/node"
    if let versions = try? fm.contentsOfDirectory(atPath: nvmDir) {
        for ver in versions.sorted().reversed() {
            candidates.append("\(nvmDir)/\(ver)/bin/node")
        }
    }

    for path in candidates where !path.isEmpty {
        if fm.isExecutableFile(atPath: path) {
            return path
        }
    }
    return nil
}

private func isAllowedLocalHost(_ host: String?, targetHost: String?) -> Bool {
    guard let host = host?.lowercased() else { return false }
    if let targetHost = targetHost?.lowercased(), host == targetHost {
        return true
    }
    return host == "127.0.0.1" || host == "localhost"
}

private let imageExtensions: Set<String> = [
    "png", "jpg", "jpeg", "gif", "webp", "svg",
]

final class NativeBridge: NSObject, WKScriptMessageHandler {
    var onMessage: (([String: Any]) -> Void)?

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == "agJpNative",
              let payload = message.body as? [String: Any]
        else { return }
        onMessage?(payload)
    }
}

final class DroppableWebView: WKWebView {
    private func extractNonImagePaths(from sender: NSDraggingInfo) -> [String] {
        guard let urls = sender.draggingPasteboard.readObjects(
            forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]
        ) as? [URL], !urls.isEmpty else {
            return []
        }
        var paths: [String] = []
        for url in urls {
            let ext = url.pathExtension.lowercased()
            var isDir: ObjCBool = false
            FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir)
            if isDir.boolValue || !imageExtensions.contains(ext) {
                paths.append(url.path)
            }
        }
        return paths
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        if !extractNonImagePaths(from: sender).isEmpty {
            return .copy
        }
        return super.draggingEntered(sender)
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        if !extractNonImagePaths(from: sender).isEmpty {
            return .copy
        }
        return super.draggingUpdated(sender)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let nonImagePaths = extractNonImagePaths(from: sender)
        if !nonImagePaths.isEmpty {
            if let data = try? JSONSerialization.data(withJSONObject: ["paths": nonImagePaths]),
               let json = String(data: data, encoding: .utf8)
            {
                let js = "window.dispatchEvent(new CustomEvent('antigravity-jp:insert-paths', { detail: \(json) }));"
                evaluateJavaScript(js, completionHandler: nil)
                return true
            }
        }
        return super.performDragOperation(sender)
    }
}

@main
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, UNUserNotificationCenterDelegate {
    private var window: NSWindow!
    private var webView: DroppableWebView!
    private var bridge = NativeBridge()
    private var config: AppConfig!
    private var managedServerProcess: Process?
    private var sleepAssertionID: IOPMAssertionID = 0
    private var preventSleepEnabled = false
    private weak var sleepMenuItem: NSMenuItem?
    private var isLoadingServer = false
    private var signalSources: [DispatchSourceSignal] = []

    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        config = resolveAppConfig()
        setupSignalHandlers()
        setupNotifications()
        setupMainMenu()
        setupWindow()
        showLoadingScreen(message: "Antigravity 日本語版を起動しています…", detail: "ローカルブリッジ接続を確認中")
        ensureServerAndLoad()
    }

    private func setupSignalHandlers() {
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler { [weak self] in
                self?.disableSleepPrevention()
                self?.stopManagedServer()
                NSApp.terminate(nil)
            }
            src.resume()
            signalSources.append(src)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            window.makeKeyAndOrderFront(nil)
        }
        NSApp.activate(ignoringOtherApps: true)
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        disableSleepPrevention()
        stopManagedServer()
    }

    // MARK: - Notifications

    private func setupNotifications() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        Task { @MainActor in
            self.window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            completionHandler()
        }
    }

    private func postSystemNotification(title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let req = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(req, withCompletionHandler: nil)
    }

    // MARK: - Window & WebView

    private func setupWindow() {
        let rect = NSRect(x: 0, y: 0, width: 1220, height: 820)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Antigravity 日本語版"
        window.minSize = NSSize(width: 420, height: 520)
        window.center()
        window.setFrameAutosaveName("AntigravityJPMainWindow")
        window.backgroundColor = NSColor(red: 0.051, green: 0.059, blue: 0.075, alpha: 1.0)

        let wkConfig = WKWebViewConfiguration()
        wkConfig.preferences.setValue(true, forKey: "developerExtrasEnabled")
        wkConfig.userContentController.add(bridge, name: "agJpNative")

        bridge.onMessage = { [weak self] payload in
            guard let self else { return }
            guard let type = payload["type"] as? String else { return }
            switch type {
            case "copy":
                if let text = payload["text"] as? String {
                    let pb = NSPasteboard.general
                    pb.clearContents()
                    pb.setString(text, forType: .string)
                }
            case "notify":
                let title = (payload["title"] as? String) ?? "Antigravity 日本語版"
                let body = (payload["body"] as? String) ?? ""
                self.postSystemNotification(title: title, body: body)
            default:
                break
            }
        }

        webView = DroppableWebView(frame: window.contentView!.bounds, configuration: wkConfig)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        window.contentView?.addSubview(webView)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: - Native Menu Bar (Japanese)

    private func setupMainMenu() {
        let mainMenu = NSMenu()

        // App menu
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu(title: "Antigravity 日本語版")
        appMenu.addItem(withTitle: "Antigravity 日本語版について", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        let settingsItem = NSMenuItem(title: "設定…", action: #selector(openSettings), keyEquivalent: ",")
        settingsItem.target = self
        appMenu.addItem(settingsItem)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Antigravity 日本語版を隠す", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = NSMenuItem(title: "ほかを隠す", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthers)
        appMenu.addItem(withTitle: "すべてを表示", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Antigravity 日本語版を終了", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu

        // File menu
        let fileMenuItem = NSMenuItem()
        mainMenu.addItem(fileMenuItem)
        let fileMenu = NSMenu(title: "ファイル")
        let newChatItem = NSMenuItem(title: "新しいチャット", action: #selector(newChat), keyEquivalent: "n")
        newChatItem.target = self
        fileMenu.addItem(newChatItem)
        let reloadItem = NSMenuItem(title: "画面を再読み込み", action: #selector(reloadPage), keyEquivalent: "r")
        reloadItem.target = self
        fileMenu.addItem(reloadItem)
        let restartServerItem = NSMenuItem(title: "ローカルサーバーを再起動", action: #selector(restartLocalServer), keyEquivalent: "")
        restartServerItem.target = self
        fileMenu.addItem(restartServerItem)
        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "ウインドウを閉じる", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileMenuItem.submenu = fileMenu

        // Edit menu (⌘C / ⌘V / ⌘X / ⌘A / ⌘Z を有効化)
        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "編集")
        editMenu.addItem(withTitle: "取り消す", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "やり直す", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "カット", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "コピー", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "ペースト", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "すべてを選択", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu

        // View menu
        let viewMenuItem = NSMenuItem()
        mainMenu.addItem(viewMenuItem)
        let viewMenu = NSMenu(title: "表示")
        let zoomIn = NSMenuItem(title: "拡大", action: #selector(zoomInAction), keyEquivalent: "+")
        zoomIn.target = self
        viewMenu.addItem(zoomIn)
        let zoomOut = NSMenuItem(title: "縮小", action: #selector(zoomOutAction), keyEquivalent: "-")
        zoomOut.target = self
        viewMenu.addItem(zoomOut)
        let zoomReset = NSMenuItem(title: "実際のサイズ", action: #selector(zoomResetAction), keyEquivalent: "0")
        zoomReset.target = self
        viewMenu.addItem(zoomReset)
        viewMenu.addItem(.separator())
        let sleepItem = NSMenuItem(title: "作業中の Mac スリープを防止", action: #selector(togglePreventSleep), keyEquivalent: "")
        sleepItem.target = self
        sleepItem.state = .off
        sleepMenuItem = sleepItem
        viewMenu.addItem(sleepItem)
        viewMenuItem.submenu = viewMenu

        // Window menu
        let winMenuItem = NSMenuItem()
        mainMenu.addItem(winMenuItem)
        let winMenu = NSMenu(title: "ウインドウ")
        winMenu.addItem(withTitle: "しまう", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        winMenu.addItem(withTitle: "拡大／縮小", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        winMenuItem.submenu = winMenu

        NSApp.mainMenu = mainMenu
    }

    @objc private func newChat() {
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('antigravity-jp:new-chat'));", completionHandler: nil)
    }

    @objc private func openSettings() {
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('antigravity-jp:open-settings'));", completionHandler: nil)
    }

    @objc private func reloadPage() {
        ensureServerAndLoad()
    }

    @objc private func restartLocalServer() {
        stopManagedServer()
        showLoadingScreen(message: "ローカルサーバーを再起動しています…", detail: "数秒お待ちください")
        ensureServerAndLoad()
    }

    @objc private func zoomInAction() {
        webView.pageZoom = min(2.0, webView.pageZoom + 0.1)
    }

    @objc private func zoomOutAction() {
        webView.pageZoom = max(0.7, webView.pageZoom - 0.1)
    }

    @objc private func zoomResetAction() {
        webView.pageZoom = 1.0
    }

    @objc private func togglePreventSleep() {
        if preventSleepEnabled {
            disableSleepPrevention()
        } else {
            enableSleepPrevention()
        }
    }

    private func enableSleepPrevention() {
        var assertionID: IOPMAssertionID = 0
        let reason = "Antigravity 日本語版の作業中スリープ抑止" as CFString
        let res = IOPMAssertionCreateWithName(
            kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
            IOPMAssertionLevel(kIOPMAssertionLevelOn),
            reason,
            &assertionID
        )
        if res == kIOReturnSuccess {
            sleepAssertionID = assertionID
            preventSleepEnabled = true
            sleepMenuItem?.state = .on
        }
    }

    private func disableSleepPrevention() {
        if preventSleepEnabled && sleepAssertionID != 0 {
            IOPMAssertionRelease(sleepAssertionID)
            sleepAssertionID = 0
        }
        preventSleepEnabled = false
        sleepMenuItem?.state = .off
    }

    // MARK: - Local Bridge Server Auto-Management

    private func checkHealth() async -> Bool {
        let healthURL = config.baseURL.appendingPathComponent("api/health")
        var req = URLRequest(url: healthURL)
        req.timeoutInterval = 1.5
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            if let http = resp as? HTTPURLResponse, http.statusCode == 200 {
                return true
            }
        } catch {
            return false
        }
        return false
    }

    private func startManagedServerIfPossible() -> (ok: Bool, error: String?) {
        if let proc = managedServerProcess, proc.isRunning {
            return (true, nil)
        }
        guard let runtimeDir = config.runtimeDir else {
            return (false, "アプリのランタイム（runtime フォルダ）が見つかりませんでした。DMG または配布ZIPからアプリを入れ直してください。")
        }
        guard let nodeBin = findNodeBinary(runtimeDir: runtimeDir) else {
            return (false, "Node.js（v22以上）が見つかりませんでした。Universal版DMGから再インストールするか、https://nodejs.org/ から導入してください。")
        }

        let fm = FileManager.default
        let entry1 = "\(runtimeDir)/proxy/dist/index.js"
        let entry2 = "\(runtimeDir)/packages/proxy/dist/index.js"
        let entryPath = fm.fileExists(atPath: entry1) ? entry1 : entry2
        let webDist1 = "\(runtimeDir)/web/dist"
        let webDist2 = "\(runtimeDir)/packages/web/dist"
        let webDist = fm.fileExists(atPath: "\(webDist1)/index.html") ? webDist1 : webDist2

        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodeBin)
        process.arguments = [entryPath]
        process.currentDirectoryURL = URL(fileURLWithPath: runtimeDir)

        var env = ProcessInfo.processInfo.environment
        let nodeDir = (nodeBin as NSString).deletingLastPathComponent
        let basePath = env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        env["PATH"] = "\(nodeDir):/opt/homebrew/bin:/usr/local/bin:\(basePath)"
        env["PORTA_HOST"] = config.host
        env["PORTA_PORT"] = config.port
        env["PORTA_WEB_DIST_DIR"] = webDist
        env["PORTA_STANDALONE_CORE"] = env["PORTA_STANDALONE_CORE"] ?? "true"
        process.environment = env

        let logDir = "\(fm.homeDirectoryForCurrentUser.path)/Library/Logs/AntigravityJP"
        try? fm.createDirectory(atPath: logDir, withIntermediateDirectories: true)
        let logPath = "\(logDir)/server.log"
        if !fm.fileExists(atPath: logPath) {
            fm.createFile(atPath: logPath, contents: nil)
        }
        if let handle = FileHandle(forWritingAtPath: logPath) {
            handle.seekToEndOfFile()
            process.standardOutput = handle
            process.standardError = handle
        }

        do {
            try process.run()
            managedServerProcess = process
            return (true, nil)
        } catch {
            return (false, "ローカルサーバーの起動に失敗しました: \(error.localizedDescription)")
        }
    }

    private func stopManagedServer() {
        if let proc = managedServerProcess, proc.isRunning {
            proc.terminate()
        }
        managedServerProcess = nil
    }

    private func ensureServerAndLoad() {
        guard !isLoadingServer else { return }
        isLoadingServer = true

        Task { @MainActor in
            defer { self.isLoadingServer = false }

            if await self.checkHealth() {
                self.webView.load(URLRequest(url: self.config.baseURL))
                return
            }

            let started = self.startManagedServerIfPossible()
            if !started.ok {
                self.showErrorScreen(
                    title: "起動準備が必要です",
                    detail: started.error ?? "ローカルサーバーを起動できませんでした。"
                )
                return
            }

            for _ in 0..<40 {
                try? await Task.sleep(nanoseconds: 250_000_000)
                if await self.checkHealth() {
                    self.webView.load(URLRequest(url: self.config.baseURL))
                    return
                }
            }

            self.showErrorScreen(
                title: "ローカルサーバーへの接続がタイムアウトしました",
                detail: "ログ（~/Library/Logs/AntigravityJP/server.log）を確認し、メニューの「ローカルサーバーを再起動」をお試しください。"
            )
        }
    }

    // MARK: - Loading / Error Screens

    private func showLoadingScreen(message: String, detail: String) {
        let html = """
        <!doctype html>
        <html lang="ja"><head><meta charset="utf-8"><style>
        body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
        background:#0d0f13;color:#e8eaf0;font-family:"Hiragino Sans",-apple-system,sans-serif;text-align:center;gap:14px;}
        .spinner{width:34px;height:34px;border:3px solid #2a2f3e;border-top-color:#6c8bef;border-radius:50%;animation:s .9s linear infinite;}
        @keyframes s{to{transform:rotate(360deg)}}
        .title{font-size:16px;font-weight:600;}
        .sub{font-size:12px;color:#9ba3b8;}
        </style></head><body><div class="spinner"></div><div class="title">\(message)</div><div class="sub">\(detail)</div></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    private func showErrorScreen(title: String, detail: String) {
        let escapedTitle = title.replacingOccurrences(of: "<", with: "&lt;")
        let escapedDetail = detail.replacingOccurrences(of: "<", with: "&lt;")
        let html = """
        <!doctype html>
        <html lang="ja"><head><meta charset="utf-8"><style>
        body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
        background:#0d0f13;color:#e8eaf0;font-family:"Hiragino Sans",-apple-system,sans-serif;text-align:center;padding:32px;gap:12px;}
        .card{max-width:480px;background:#14171e;border:1px solid #2a2f3e;border-radius:14px;padding:24px;}
        .title{font-size:16px;font-weight:700;margin-bottom:10px;color:#f87171;}
        .sub{font-size:13px;color:#9ba3b8;line-height:1.7;}
        </style></head><body><div class="card"><div class="title">\(escapedTitle)</div><div class="sub">\(escapedDetail)</div></div></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    // MARK: - WKNavigationDelegate / WKUIDelegate

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "about" || scheme == "data" || scheme == "blob" {
            decisionHandler(.allow)
            return
        }
        if (scheme == "http" || scheme == "https"),
           !isAllowedLocalHost(url.host, targetHost: config.baseURL.host)
        {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    @available(macOS 12.0, *)
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        if isAllowedLocalHost(origin.host, targetHost: config.baseURL.host) && type == .microphone {
            decisionHandler(.grant)
        } else {
            decisionHandler(.prompt)
        }
    }
}
