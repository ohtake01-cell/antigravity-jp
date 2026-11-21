import Cocoa
import CryptoKit
import IOKit.pwr_mgt
import UserNotifications
import WebKit

private let defaultPort = "3470"
private let defaultHost = "127.0.0.1"
private let updateRepoOwner = "ohtake01-cell"
private let updateRepoName = "antigravity-jp"
private let updateReleasesPageURL = "https://github.com/\(updateRepoOwner)/\(updateRepoName)/releases"
private let updateWebLatestURL = "https://github.com/\(updateRepoOwner)/\(updateRepoName)/releases/latest"
private let autoUpdateDefaultsKey = "AGJPAutoUpdateCheckEnabled"

private func currentAppVersion() -> String {
    if let envVer = ProcessInfo.processInfo.environment["AG_JP_APP_VERSION"], !envVer.isEmpty {
        return envVer.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "^v", with: "", options: .regularExpression)
    }
    if let ver = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String, !ver.isEmpty {
        return ver.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    return "1.5.1"
}

private func parseSemver(_ raw: String) -> [Int] {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    let withoutV = trimmed.hasPrefix("v") || trimmed.hasPrefix("V") ? String(trimmed.dropFirst()) : trimmed
    let core = withoutV.split(separator: "-").first.map(String.init) ?? withoutV
    let nums = core.split(separator: ".").map { Int($0) ?? 0 }
    return [
        nums.count > 0 ? nums[0] : 0,
        nums.count > 1 ? nums[1] : 0,
        nums.count > 2 ? nums[2] : 0,
    ]
}

private func compareSemver(_ a: String, _ b: String) -> Int {
    let pa = parseSemver(a)
    let pb = parseSemver(b)
    for i in 0..<3 {
        if pa[i] > pb[i] { return 1 }
        if pa[i] < pb[i] { return -1 }
    }
    return 0
}

private func computeFileSHA256(at url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    while true {
        let chunk = handle.readData(ofLength: 1_048_576)
        if chunk.isEmpty { break }
        hasher.update(data: chunk)
    }
    let digest = hasher.finalize()
    return digest.map { String(format: "%02x", $0) }.joined()
}

private func runSubprocessSync(_ executable: String, arguments: [String]) -> (status: Int32, output: String) {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: executable)
    proc.arguments = arguments
    let pipe = Pipe()
    proc.standardOutput = pipe
    proc.standardError = pipe
    do {
        try proc.run()
        proc.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let out = String(data: data, encoding: .utf8) ?? ""
        return (proc.terminationStatus, out)
    } catch {
        return (-1, error.localizedDescription)
    }
}

private final class ZipDownloadDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private let destinationURL: URL
    private let onProgress: @Sendable (Int64, Int64) -> Void
    private var continuation: CheckedContinuation<URL, Error>?
    private var lastProgressPush = Date.distantPast
    private let lock = NSLock()

    init(destinationURL: URL, onProgress: @escaping @Sendable (Int64, Int64) -> Void) {
        self.destinationURL = destinationURL
        self.onProgress = onProgress
    }

    func start(url: URL, userAgent: String) async throws -> URL {
        return try await withCheckedThrowingContinuation { cont in
            lock.lock()
            self.continuation = cont
            lock.unlock()
            let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
            var req = URLRequest(url: url)
            req.timeoutInterval = 300
            req.setValue(userAgent, forHTTPHeaderField: "User-Agent")
            let task = session.downloadTask(with: req)
            task.resume()
        }
    }

    private func finishOnce(_ result: Result<URL, Error>, session: URLSession) {
        lock.lock()
        let cont = continuation
        continuation = nil
        lock.unlock()
        session.finishTasksAndInvalidate()
        guard let cont else { return }
        switch result {
        case .success(let u): cont.resume(returning: u)
        case .failure(let e): cont.resume(throwing: e)
        }
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        let now = Date()
        if now.timeIntervalSince(lastProgressPush) >= 0.15 || totalBytesWritten == totalBytesExpectedToWrite {
            lastProgressPush = now
            onProgress(totalBytesWritten, totalBytesExpectedToWrite)
        }
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        if let http = downloadTask.response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            let err = NSError(
                domain: "AntigravityJPUpdater",
                code: http.statusCode,
                userInfo: [NSLocalizedDescriptionKey: "ダウンロードに失敗しました (HTTP \(http.statusCode))"]
            )
            finishOnce(.failure(err), session: session)
            return
        }
        let fm = FileManager.default
        do {
            if fm.fileExists(atPath: destinationURL.path) {
                try fm.removeItem(at: destinationURL)
            }
            try fm.moveItem(at: location, to: destinationURL)
            finishOnce(.success(destinationURL), session: session)
        } catch {
            finishOnce(.failure(error), session: session)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error {
            finishOnce(.failure(error), session: session)
        }
    }
}

private struct UpdateState {
    var currentVersion: String
    var latestVersion: String?
    var updateAvailable: Bool = false
    var canAutoInstall: Bool = false
    var autoInstallBlockedReason: String?
    var phase: String = "idle"
    var progress: Double = 0
    var downloadedBytes: Int64 = 0
    var totalBytes: Int64 = 0
    var releaseName: String?
    var releaseNotes: String?
    var releaseUrl: String = updateReleasesPageURL
    var downloadUrl: String?
    var expectedSha256: String?
    var autoCheckEnabled: Bool = true
    var message: String?
    var error: String?

    func toJSONDictionary() -> [String: Any] {
        var dict: [String: Any] = [
            "isNativeApp": true,
            "currentVersion": currentVersion,
            "updateAvailable": updateAvailable,
            "canAutoInstall": canAutoInstall,
            "phase": phase,
            "progress": progress,
            "downloadedBytes": downloadedBytes,
            "totalBytes": totalBytes,
            "releaseUrl": releaseUrl,
            "autoCheckEnabled": autoCheckEnabled,
        ]
        if let v = latestVersion { dict["latestVersion"] = v }
        if let v = autoInstallBlockedReason { dict["autoInstallBlockedReason"] = v }
        if let v = releaseName { dict["releaseName"] = v }
        if let v = releaseNotes { dict["releaseNotes"] = v }
        if let v = downloadUrl { dict["downloadUrl"] = v }
        if let v = expectedSha256 { dict["expectedSha256"] = v }
        if let v = message { dict["message"] = v }
        if let v = error { dict["error"] = v }
        return dict
    }
}

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
    private var updateState = UpdateState(currentVersion: currentAppVersion())
    private var isCheckingUpdate = false
    private var isInstallingUpdate = false

    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        config = resolveAppConfig()
        initUpdateState()
        setupSignalHandlers()
        setupNotifications()
        setupMainMenu()
        setupWindow()
        showLoadingScreen(message: "Antigravity 日本語版を起動しています…", detail: "ローカルブリッジ接続を確認中")
        ensureServerAndLoad()
        scheduleBackgroundUpdateCheck()
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
        if window == nil {
            setupWindow()
            ensureServerAndLoad()
        } else if !flag {
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
        window.isReleasedWhenClosed = false
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
            case "save-file":
                if let content = payload["content"] as? String {
                    let rawName = (payload["filename"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                    let panel = NSSavePanel()
                    panel.nameFieldStringValue = (rawName?.isEmpty == false ? rawName! : "conversation.md")
                    panel.canCreateDirectories = true
                    let handleSave: (NSApplication.ModalResponse) -> Void = { response in
                        if response == .OK, let dest = panel.url {
                            try? content.write(to: dest, atomically: true, encoding: .utf8)
                        }
                    }
                    if let win = self.window {
                        panel.beginSheetModal(for: win, completionHandler: handleSave)
                    } else {
                        handleSave(panel.runModal())
                    }
                }
            case "notify":
                let title = (payload["title"] as? String) ?? "Antigravity 日本語版"
                let body = (payload["body"] as? String) ?? ""
                self.postSystemNotification(title: title, body: body)
            case "update-get-state":
                self.pushUpdateStateToWebView()
            case "update-check":
                let showDialog = (payload["showDialog"] as? Bool) ?? false
                self.checkForUpdates(showNativeDialogs: showDialog)
            case "update-install":
                self.installAvailableUpdate()
            case "update-open-release":
                if let url = URL(string: self.updateState.releaseUrl) {
                    NSWorkspace.shared.open(url)
                }
            case "update-set-auto-check":
                if let enabled = payload["enabled"] as? Bool {
                    self.setAutoUpdateCheckEnabled(enabled)
                }
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
        let checkUpdateItem = NSMenuItem(title: "アップデートを確認…", action: #selector(checkForUpdatesFromMenu), keyEquivalent: "")
        checkUpdateItem.target = self
        appMenu.addItem(checkUpdateItem)
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

    private func checkHealth() async -> (healthy: Bool, version: String?) {
        let healthURL = config.baseURL.appendingPathComponent("api/health")
        var req = URLRequest(url: healthURL)
        req.timeoutInterval = 1.5
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            if let http = resp as? HTTPURLResponse, http.statusCode == 200 {
                let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                let ver = obj?["version"] as? String
                return (true, ver)
            }
        } catch {
            return (false, nil)
        }
        return (false, nil)
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
        env["AG_JP_APP_VERSION"] = currentAppVersion()
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

            let expectedVer = currentAppVersion()
            let initial = await self.checkHealth()
            if initial.healthy {
                if initial.version == expectedVer {
                    self.webView.load(URLRequest(url: self.config.baseURL))
                    return
                }
                // 古いバージョンのローカルサーバーがポートを占有している場合は自動で最新へ切り替える
                self.stopManagedServer()
                let portToClear = self.config.port
                await Task.detached(priority: .userInitiated) {
                    let res = runSubprocessSync("/usr/sbin/lsof", arguments: ["-nP", "-iTCP:\(portToClear)", "-sTCP:LISTEN", "-t"])
                    if res.status == 0 {
                        let myPid = ProcessInfo.processInfo.processIdentifier
                        for raw in res.output.components(separatedBy: .newlines) {
                            if let pid = Int32(raw.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 0, pid != myPid {
                                kill(pid, SIGTERM)
                            }
                        }
                    }
                }.value
                try? await Task.sleep(nanoseconds: 500_000_000)
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
                if (await self.checkHealth()).healthy {
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

    // MARK: - Auto Updater (GitHub Releases + Atomic Self-Replace)

    private func evaluateAutoInstallCapability() -> (canInstall: Bool, reason: String?) {
        let bundlePath = Bundle.main.bundlePath
        guard bundlePath.hasSuffix(".app") else {
            return (false, "アプリバンドル外から実行されているため、自動入れ替えできません。")
        }
        if bundlePath.contains("/AppTranslocation/") {
            return (false, "一時領域から起動されています。アプリを「アプリケーション」フォルダへ移動してからお試しください。")
        }
        if bundlePath.hasPrefix("/Volumes/") {
            return (false, "ディスクイメージ等から直接起動されています。「アプリケーション」フォルダへコピーしてからお試しください。")
        }
        let fm = FileManager.default
        let parentDir = (bundlePath as NSString).deletingLastPathComponent
        if !fm.isWritableFile(atPath: parentDir) || !fm.isWritableFile(atPath: bundlePath) {
            return (false, "インストール先フォルダへの書き込み権限がないため、リリースページから手動で更新してください。")
        }
        return (true, nil)
    }

    private func initUpdateState() {
        let defaults = UserDefaults.standard
        let autoEnabled: Bool
        if defaults.object(forKey: autoUpdateDefaultsKey) == nil {
            autoEnabled = true
        } else {
            autoEnabled = defaults.bool(forKey: autoUpdateDefaultsKey)
        }
        let capability = evaluateAutoInstallCapability()
        updateState = UpdateState(
            currentVersion: currentAppVersion(),
            canAutoInstall: capability.canInstall,
            autoInstallBlockedReason: capability.reason,
            autoCheckEnabled: autoEnabled
        )
    }

    private func setAutoUpdateCheckEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: autoUpdateDefaultsKey)
        updateState.autoCheckEnabled = enabled
        pushUpdateStateToWebView()
    }

    private func scheduleBackgroundUpdateCheck() {
        guard updateState.autoCheckEnabled else { return }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            guard self.updateState.autoCheckEnabled else { return }
            self.checkForUpdates(showNativeDialogs: false)
        }
    }

    @objc private func checkForUpdatesFromMenu() {
        checkForUpdates(showNativeDialogs: true)
    }

    private func pushUpdateStateToWebView() {
        guard let webView else { return }
        let dict = updateState.toJSONDictionary()
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let json = String(data: data, encoding: .utf8)
        else { return }
        let js = """
        window.__AG_JP_UPDATE_STATE__ = \(json);
        window.dispatchEvent(new CustomEvent('antigravity-jp:update-status', { detail: \(json) }));
        """
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    private func checkForUpdates(showNativeDialogs: Bool) {
        guard !isCheckingUpdate, !isInstallingUpdate else {
            pushUpdateStateToWebView()
            return
        }
        isCheckingUpdate = true
        let capability = evaluateAutoInstallCapability()
        updateState.canAutoInstall = capability.canInstall
        updateState.autoInstallBlockedReason = capability.reason
        updateState.phase = "checking"
        updateState.error = nil
        updateState.message = "最新バージョンを確認しています…"
        pushUpdateStateToWebView()

        let currentVer = updateState.currentVersion
        let apiUrlStr = ProcessInfo.processInfo.environment["AG_JP_UPDATE_API_URL"]
            ?? "https://api.github.com/repos/\(updateRepoOwner)/\(updateRepoName)/releases/latest"

        Task { @MainActor in
            defer { self.isCheckingUpdate = false }

            do {
                let fetched = try await Self.fetchLatestReleaseMetadata(
                    apiUrlString: apiUrlStr,
                    currentVersion: currentVer
                )
                let isNewer = compareSemver(fetched.latestVersion, currentVer) > 0
                self.updateState.latestVersion = fetched.latestVersion
                self.updateState.updateAvailable = isNewer
                self.updateState.releaseName = fetched.releaseName
                self.updateState.releaseNotes = fetched.releaseNotes
                self.updateState.releaseUrl = fetched.releaseUrl
                self.updateState.downloadUrl = fetched.zipDownloadUrl
                self.updateState.expectedSha256 = fetched.zipSha256
                self.updateState.error = nil

                if isNewer {
                    self.updateState.phase = "available"
                    self.updateState.message = "新しいバージョン v\(fetched.latestVersion) が利用可能です。"
                } else {
                    self.updateState.phase = "up_to_date"
                    self.updateState.message = "最新バージョン（v\(currentVer)）をお使いです。"
                }
                self.pushUpdateStateToWebView()

                if showNativeDialogs {
                    self.presentUpdateResultAlert(isNewer: isNewer)
                }
            } catch {
                self.updateState.phase = "error"
                self.updateState.error = error.localizedDescription
                self.updateState.message = "アップデートの確認に失敗しました。"
                self.pushUpdateStateToWebView()

                if showNativeDialogs {
                    let alert = NSAlert()
                    alert.alertStyle = .warning
                    alert.messageText = "アップデートを確認できませんでした"
                    alert.informativeText = error.localizedDescription
                    alert.addButton(withTitle: "閉じる")
                    alert.addButton(withTitle: "リリースページを開く")
                    if alert.runModal() == .alertSecondButtonReturn,
                       let url = URL(string: self.updateState.releaseUrl)
                    {
                        NSWorkspace.shared.open(url)
                    }
                }
            }
        }
    }

    private func presentUpdateResultAlert(isNewer: Bool) {
        let alert = NSAlert()
        if isNewer, let latest = updateState.latestVersion {
            alert.alertStyle = .informational
            alert.messageText = "Antigravity 日本語版 v\(latest) が利用可能です"
            let baseMsg = "現在お使いのバージョン: v\(updateState.currentVersion)\n新しいバージョン: v\(latest)\nチャット履歴や設定はそのまま引き継がれます。"
            if updateState.canAutoInstall && updateState.downloadUrl != nil {
                alert.informativeText = baseMsg
                alert.addButton(withTitle: "今すぐアップデートして再起動")
                alert.addButton(withTitle: "リリースページを開く")
                alert.addButton(withTitle: "後で")
                let resp = alert.runModal()
                if resp == .alertFirstButtonReturn {
                    installAvailableUpdate()
                } else if resp == .alertSecondButtonReturn,
                          let url = URL(string: updateState.releaseUrl)
                {
                    NSWorkspace.shared.open(url)
                }
            } else {
                alert.informativeText = baseMsg + "\n\n" + (updateState.autoInstallBlockedReason ?? "")
                alert.addButton(withTitle: "リリースページを開く")
                alert.addButton(withTitle: "後で")
                if alert.runModal() == .alertFirstButtonReturn,
                   let url = URL(string: updateState.releaseUrl)
                {
                    NSWorkspace.shared.open(url)
                }
            }
        } else {
            alert.alertStyle = .informational
            alert.messageText = "Antigravity 日本語版は最新版です"
            alert.informativeText = "現在のバージョン: v\(updateState.currentVersion)"
            alert.addButton(withTitle: "OK")
            alert.runModal()
        }
    }

    private struct FetchedReleaseMetadata: Sendable {
        let latestVersion: String
        let releaseName: String
        let releaseNotes: String?
        let releaseUrl: String
        let zipDownloadUrl: String?
        let zipSha256: String?
    }

    nonisolated private static func fetchLatestReleaseMetadata(
        apiUrlString: String,
        currentVersion: String
    ) async throws -> FetchedReleaseMetadata {
        guard let apiURL = URL(string: apiUrlString) else {
            throw NSError(domain: "AntigravityJPUpdater", code: -1, userInfo: [NSLocalizedDescriptionKey: "アップデート確認URLが不正です"])
        }
        var req = URLRequest(url: apiURL)
        req.timeoutInterval = 12
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("Antigravity-JP/\(currentVersion)", forHTTPHeaderField: "User-Agent")

        let (data, response) = try await URLSession.shared.data(for: req)
        if let http = response as? HTTPURLResponse {
            if (200...299).contains(http.statusCode) {
                guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let tagRaw = obj["tag_name"] as? String,
                      !tagRaw.isEmpty
                else {
                    throw NSError(domain: "AntigravityJPUpdater", code: -2, userInfo: [NSLocalizedDescriptionKey: "リリース情報の形式が不正です"])
                }
                let latestVer = tagRaw.trimmingCharacters(in: .whitespacesAndNewlines)
                    .replacingOccurrences(of: "^v", with: "", options: .regularExpression)
                let releaseName = (obj["name"] as? String) ?? "Antigravity 日本語版 v\(latestVer)"
                let releaseNotes = obj["body"] as? String
                let releaseUrl = (obj["html_url"] as? String) ?? updateReleasesPageURL

                var zipUrl: String?
                var zipSha: String?
                if let assets = obj["assets"] as? [[String: Any]] {
                    for asset in assets {
                        guard let name = asset["name"] as? String,
                              let dl = asset["browser_download_url"] as? String
                        else { continue }
                        if name == "Antigravity-JP-macOS.zip"
                            || (name.hasSuffix(".zip") && name.lowercased().contains("macos"))
                        {
                            zipUrl = dl
                            if let digest = asset["digest"] as? String,
                               digest.lowercased().hasPrefix("sha256:")
                            {
                                let hex = String(digest.dropFirst(7)).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                                if hex.count == 64 {
                                    zipSha = hex
                                }
                            }
                            break
                        }
                    }
                }
                return FetchedReleaseMetadata(
                    latestVersion: latestVer,
                    releaseName: releaseName,
                    releaseNotes: releaseNotes,
                    releaseUrl: releaseUrl,
                    zipDownloadUrl: zipUrl,
                    zipSha256: zipSha
                )
            }

            // API レート制限時は Web の /releases/latest リダイレクトからタグ名をフォールバック取得
            if http.statusCode == 403 || http.statusCode == 429 {
                if let webURL = URL(string: updateWebLatestURL) {
                    var headReq = URLRequest(url: webURL)
                    headReq.httpMethod = "HEAD"
                    headReq.timeoutInterval = 12
                    headReq.setValue("Antigravity-JP/\(currentVersion)", forHTTPHeaderField: "User-Agent")
                    let (_, webResp) = try await URLSession.shared.data(for: headReq)
                    if let finalUrl = webResp.url?.absoluteString,
                       let range = finalUrl.range(of: "/releases/tag/")
                    {
                        let tag = String(finalUrl[range.upperBound...]).split(separator: "?").first.map(String.init) ?? ""
                        if !tag.isEmpty {
                            let latestVer = tag.replacingOccurrences(of: "^v", with: "", options: .regularExpression)
                            let tagWithV = tag.hasPrefix("v") || tag.hasPrefix("V") ? tag : "v\(latestVer)"
                            let dl = "https://github.com/\(updateRepoOwner)/\(updateRepoName)/releases/download/\(tag)/Antigravity-JP-\(tagWithV)-macOS.zip"
                            return FetchedReleaseMetadata(
                                latestVersion: latestVer,
                                releaseName: "Antigravity 日本語版 v\(latestVer)",
                                releaseNotes: nil,
                                releaseUrl: finalUrl,
                                zipDownloadUrl: dl,
                                zipSha256: nil
                            )
                        }
                    }
                }
            }

            throw NSError(
                domain: "AntigravityJPUpdater",
                code: http.statusCode,
                userInfo: [NSLocalizedDescriptionKey: "GitHub Releases への接続に失敗しました (HTTP \(http.statusCode))"]
            )
        }
        throw NSError(domain: "AntigravityJPUpdater", code: -3, userInfo: [NSLocalizedDescriptionKey: "不明な通信応答を受信しました"])
    }

    private func installAvailableUpdate() {
        guard !isInstallingUpdate else { return }
        guard let dlString = updateState.downloadUrl, let dlURL = URL(string: dlString) else {
            if let url = URL(string: updateState.releaseUrl) {
                NSWorkspace.shared.open(url)
            }
            return
        }
        let capability = evaluateAutoInstallCapability()
        updateState.canAutoInstall = capability.canInstall
        updateState.autoInstallBlockedReason = capability.reason
        guard capability.canInstall else {
            updateState.phase = "error"
            updateState.error = capability.reason ?? "自動入れ替えできない配置です。"
            pushUpdateStateToWebView()
            if let url = URL(string: updateState.releaseUrl) {
                NSWorkspace.shared.open(url)
            }
            return
        }

        isInstallingUpdate = true
        updateState.phase = "downloading"
        updateState.progress = 0
        updateState.downloadedBytes = 0
        updateState.totalBytes = 0
        updateState.error = nil
        updateState.message = "アップデートをダウンロードしています…"
        pushUpdateStateToWebView()

        let currentVer = updateState.currentVersion
        let expectedSha = updateState.expectedSha256
        let targetAppPath = Bundle.main.bundlePath
        let serverPort = config.port
        let workDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("ag-jp-update-\(UUID().uuidString)", isDirectory: true)
        let zipDestURL = workDir.appendingPathComponent("Antigravity-JP-macOS.zip")
        let extractDir = workDir.appendingPathComponent("extracted", isDirectory: true)

        Task { @MainActor in
            do {
                try FileManager.default.createDirectory(at: workDir, withIntermediateDirectories: true)
                let delegate = ZipDownloadDelegate(destinationURL: zipDestURL) { written, total in
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        self.updateState.downloadedBytes = written
                        self.updateState.totalBytes = max(total, 0)
                        if total > 0 {
                            self.updateState.progress = min(1.0, max(0.0, Double(written) / Double(total)))
                        }
                        self.pushUpdateStateToWebView()
                    }
                }
                _ = try await delegate.start(url: dlURL, userAgent: "Antigravity-JP/\(currentVer)")

                self.updateState.phase = "verifying"
                self.updateState.progress = 1.0
                self.updateState.message = "パッケージを展開・検証しています…"
                self.pushUpdateStateToWebView()

                let verifiedAppPath: String = try await Task.detached(priority: .userInitiated) {
                    if let expectedSha, !expectedSha.isEmpty {
                        let actualSha = try computeFileSHA256(at: zipDestURL)
                        if actualSha != expectedSha.lowercased() {
                            throw NSError(
                                domain: "AntigravityJPUpdater",
                                code: -10,
                                userInfo: [NSLocalizedDescriptionKey: "ダウンロードファイルの整合性検証 (SHA-256) に失敗しました。もう一度お試しください。"]
                            )
                        }
                    }

                    let fm = FileManager.default
                    try fm.createDirectory(at: extractDir, withIntermediateDirectories: true)
                    let unzipRes = runSubprocessSync("/usr/bin/ditto", arguments: ["-x", "-k", zipDestURL.path, extractDir.path])
                    if unzipRes.status != 0 {
                        throw NSError(
                            domain: "AntigravityJPUpdater",
                            code: Int(unzipRes.status),
                            userInfo: [NSLocalizedDescriptionKey: "ZIP の展開に失敗しました: \(unzipRes.output)"]
                        )
                    }

                    // トップレベルまたは1階層サブフォルダ（例: "Antigravity 日本語版/Antigravity日本語版.app"）から .app を検出
                    var candidateApps: [String] = []
                    let topItems = try fm.contentsOfDirectory(atPath: extractDir.path)
                    for item in topItems {
                        if item.hasPrefix(".") || item == "__MACOSX" { continue }
                        let full = extractDir.appendingPathComponent(item).path
                        if item.hasSuffix(".app") {
                            candidateApps.append(full)
                        } else {
                            var isDir: ObjCBool = false
                            if fm.fileExists(atPath: full, isDirectory: &isDir), isDir.boolValue,
                               let subItems = try? fm.contentsOfDirectory(atPath: full)
                            {
                                for sub in subItems where sub.hasSuffix(".app") {
                                    candidateApps.append((full as NSString).appendingPathComponent(sub))
                                }
                            }
                        }
                    }
                    let preferredApp = candidateApps.first {
                        ($0 as NSString).lastPathComponent == "Antigravity日本語版.app"
                    } ?? candidateApps.first
                    guard let newAppPath = preferredApp else {
                        throw NSError(
                            domain: "AntigravityJPUpdater",
                            code: -11,
                            userInfo: [NSLocalizedDescriptionKey: "展開したパッケージ内に .app が見つかりませんでした。"]
                        )
                    }

                    // 展開した新アプリの必須バイナリ＆署名を事前検証
                    let execPath = "\(newAppPath)/Contents/MacOS/AntigravityJP"
                    let nodePath = "\(newAppPath)/Contents/Resources/runtime/bin/node"
                    let proxyEntry = "\(newAppPath)/Contents/Resources/runtime/proxy/dist/index.js"
                    guard fm.isExecutableFile(atPath: execPath),
                          fm.isExecutableFile(atPath: nodePath),
                          fm.fileExists(atPath: proxyEntry)
                    else {
                        throw NSError(
                            domain: "AntigravityJPUpdater",
                            code: -12,
                            userInfo: [NSLocalizedDescriptionKey: "新しいアプリの必須ファイルが不足しているため更新を中止しました。"]
                        )
                    }

                    let signRes = runSubprocessSync("/usr/bin/codesign", arguments: ["--verify", "--deep", "--strict", newAppPath])
                    if signRes.status != 0 {
                        throw NSError(
                            domain: "AntigravityJPUpdater",
                            code: Int(signRes.status),
                            userInfo: [NSLocalizedDescriptionKey: "新しいアプリの署名検証に失敗しました: \(signRes.output)"]
                        )
                    }

                    _ = runSubprocessSync("/usr/bin/xattr", arguments: ["-dr", "com.apple.quarantine", newAppPath])
                    return newAppPath
                }.value

                self.updateState.phase = "restarting"
                self.updateState.message = "アプリを入れ替えて再起動しています…"
                self.pushUpdateStateToWebView()

                let scriptURL = workDir.appendingPathComponent("apply-update.sh")
                let scriptBody = """
                #!/bin/sh
                set -eu
                PARENT_PID="$1"
                TARGET_APP="$2"
                NEW_APP="$3"
                WORK_DIR="$4"
                PORT="$5"
                BACKUP_APP="${TARGET_APP}.bak.$$"

                i=0
                while kill -0 "$PARENT_PID" 2>/dev/null && [ "$i" -lt 100 ]; do
                  sleep 0.1
                  i=$((i + 1))
                done

                if [ -n "$PORT" ] && command -v lsof >/dev/null 2>&1; then
                  PIDS=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)
                  for p in $PIDS; do
                    kill -TERM "$p" 2>/dev/null || true
                  done
                  sleep 0.3
                fi

                rm -rf "$BACKUP_APP" 2>/dev/null || true
                mv "$TARGET_APP" "$BACKUP_APP"
                if mv "$NEW_APP" "$TARGET_APP"; then
                  rm -rf "$BACKUP_APP" "$WORK_DIR" 2>/dev/null || true
                else
                  mv "$BACKUP_APP" "$TARGET_APP" 2>/dev/null || true
                  rm -rf "$WORK_DIR" 2>/dev/null || true
                  exit 1
                fi

                open -n "$TARGET_APP"
                """
                try scriptBody.write(to: scriptURL, atomically: true, encoding: .utf8)
                try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scriptURL.path)

                self.stopManagedServer()

                let helper = Process()
                helper.executableURL = URL(fileURLWithPath: "/bin/sh")
                helper.arguments = [
                    scriptURL.path,
                    String(ProcessInfo.processInfo.processIdentifier),
                    targetAppPath,
                    verifiedAppPath,
                    workDir.path,
                    serverPort,
                ]
                helper.standardInput = FileHandle.nullDevice
                helper.standardOutput = FileHandle.nullDevice
                helper.standardError = FileHandle.nullDevice
                try helper.run()

                NSApp.terminate(nil)
            } catch {
                try? FileManager.default.removeItem(at: workDir)
                self.isInstallingUpdate = false
                self.updateState.phase = "error"
                self.updateState.error = error.localizedDescription
                self.updateState.message = "アップデートに失敗しました。"
                self.pushUpdateStateToWebView()
            }
        }
    }

    // MARK: - WKNavigationDelegate / WKUIDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pushUpdateStateToWebView()
    }

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
