import AppKit
import WebKit

/*
 Clarvis, as a real application.

 The dashboard was a page on localhost, which meant finding a tab among thirty
 others, a browser chrome that belongs to a document rather than to a tool, and
 a server someone had to remember to start. It also meant the thing was only
 ever as present as whatever tab it happened to be in.

 This is a native window around the same page. WKWebView is the system
 webview - the same engine Safari uses - so nothing is bundled and the whole
 application is about a megabyte. Electron would have been two hundred, for a
 rendering engine already installed.

 It owns the server. On launch it starts `clarvis ui` if nothing is answering,
 and on quit it stops what it started. A server that was already running is
 left alone and left running, because it is somebody else's - most likely a
 terminal the operator is watching.
 */

// MARK: - Locating the parts

/*
 Finding node from a Finder launch.

 An application started from the dock inherits almost no PATH - not the shell's,
 and certainly not nvm's. So the interpreter is resolved at build time and baked
 in, with the usual locations as a fallback for a machine that has changed since.
 A wrong answer here is an app that opens to nothing and says nothing, so it is
 checked rather than assumed.
 */
enum Paths {
    static let bakedNode = ProcessInfo.processInfo.environment["CLARVIS_NODE"]
        ?? Bundle.main.object(forInfoDictionaryKey: "ClarvisNodePath") as? String
        ?? ""

    static let bakedCli = ProcessInfo.processInfo.environment["CLARVIS_CLI"]
        ?? Bundle.main.object(forInfoDictionaryKey: "ClarvisCliPath") as? String
        ?? ""

    static let fallbackNodes = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ]

    static func node() -> String? {
        for candidate in [bakedNode] + fallbackNodes where !candidate.isEmpty {
            if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }

    static func cli() -> String? {
        guard !bakedCli.isEmpty, FileManager.default.isReadableFile(atPath: bakedCli) else { return nil }
        return bakedCli
    }
}

// MARK: - The server

/// Owns the `clarvis ui` process, and only the one it started itself.
final class Server {
    private var process: Process?
    let port: Int

    init(port: Int) { self.port = port }

    var url: URL { URL(string: "http://127.0.0.1:\(port)/")! }

    /// True when something already answers, whoever started it.
    func isAnswering() -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/health") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 0.8

        let semaphore = DispatchSemaphore(value: 0)
        var alive = false
        URLSession.shared.dataTask(with: request) { _, response, _ in
            alive = (response as? HTTPURLResponse)?.statusCode == 200
            semaphore.signal()
        }.resume()
        _ = semaphore.wait(timeout: .now() + 1.2)
        return alive
    }

    /// Start one, unless somebody else's is already there.
    func startIfNeeded() -> String? {
        if isAnswering() { return nil }

        guard let node = Paths.node() else {
            return "Could not find node. It was not where this app was built to look, and not in the usual places."
        }
        guard let cli = Paths.cli() else {
            return "Could not find the Clarvis CLI. Rebuild the app with packages/desktop/build.sh."
        }

        let task = Process()
        task.executableURL = URL(fileURLWithPath: node)
        task.arguments = [cli, "ui", "--port", String(port)]
        // Nothing is read from these, but a filled pipe would block the child.
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice

        do {
            try task.run()
            process = task
        } catch {
            return "Could not start the server: \(error.localizedDescription)"
        }
        return nil
    }

    /// Wait for it to answer, so the window never opens onto a connection error.
    func waitUntilAnswering(timeout: TimeInterval = 20) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if isAnswering() { return true }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return false
    }

    /// Only ever stops a process this object started.
    func stop() {
        process?.terminate()
        process = nil
    }
}

// MARK: - The window

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private let server = Server(port: Int(ProcessInfo.processInfo.environment["CLARVIS_PORT"] ?? "4477") ?? 4477)

    func applicationDidFinishLaunching(_: Notification) {
        buildMenu()
        buildWindow()

        // Off the main thread: waiting for a server on it would freeze the
        // window before it had drawn anything, which reads as a hang.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let failure = self.server.startIfNeeded()

            DispatchQueue.main.async {
                if let failure {
                    self.showProblem(failure)
                    return
                }
            }

            let up = self.server.waitUntilAnswering()
            DispatchQueue.main.async {
                if up {
                    self.webView.load(URLRequest(url: self.server.url))
                } else {
                    self.showProblem(
                        "The dashboard did not start within 20 seconds. Try `clarvis ui` in a terminal to see why."
                    )
                }
            }
        }
    }

    func applicationWillTerminate(_: Notification) {
        server.stop()
    }

    /// A tool with one window closes when that window does.
    func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool { true }

    private func buildWindow() {
        let config = WKWebViewConfiguration()
        // The dashboard polls its own origin and nothing else; there is no
        // reason for it to reach anywhere it was not served from.
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        // The page is very dark. Without this the window flashes white on
        // every launch, which is the single most obvious way a wrapped web app
        // announces that it is one.
        webView.underPageBackgroundColor = NSColor(red: 0.027, green: 0.031, blue: 0.039, alpha: 1)
        webView.setValue(false, forKey: "drawsBackground")

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1320, height: 880),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Clarvis"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = NSColor(red: 0.027, green: 0.031, blue: 0.039, alpha: 1)
        window.minSize = NSSize(width: 960, height: 640)
        window.contentView = webView
        window.center()
        // Remembered across launches, so it opens where it was left.
        window.setFrameAutosaveName("ClarvisMainWindow")
        window.makeKeyAndOrderFront(nil)

        NSApp.activate(ignoringOtherApps: true)
    }

    private func showProblem(_ message: String) {
        // Rendered rather than an alert: an alert is dismissed and then the
        // window is empty with no explanation of why.
        let html = """
        <html><body style="margin:0;height:100vh;display:grid;place-items:center;
          background:#07080a;color:#8b97a5;
          font:13px/1.6 -apple-system,BlinkMacSystemFont,sans-serif">
          <div style="max-width:52ch;padding:32px">
            <div style="color:#f0ad4a;letter-spacing:.16em;font-size:10px;
              text-transform:uppercase;margin-bottom:12px">could not start</div>
            <p style="margin:0 0 16px">\(message)</p>
            <code style="color:#3ee0f0;font-size:12px">clarvis ui --port \(server.port)</code>
          </div>
        </body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Clarvis", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Clarvis", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Clarvis", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        viewMenu.addItem(withTitle: "Actual Size", action: #selector(actualSize), keyEquivalent: "0")
        viewItem.submenu = viewMenu
        main.addItem(viewItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimise", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.zoom(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)

        NSApp.mainMenu = main
        NSApp.windowsMenu = windowMenu
    }

    @objc private func reload() { webView.reload() }
    @objc private func actualSize() { webView.pageZoom = 1.0 }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
// .regular so it gets a dock icon and a menu bar - the things that make it an
// application rather than a window someone opened.
app.setActivationPolicy(.regular)
app.run()
