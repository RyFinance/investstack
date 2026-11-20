// tools/snap: headless snapshot of a InvestStack page, for development and review.
//
//   tools/snap "index.html#/chain/NVDA" /tmp/chain.png [options]
//
// No server and no ports: web/ files are read from disk through a private scheme, and /api/* is
// answered by `python -m valora api`. Console output and JavaScript errors are printed.
//
//   --w 1440 --h 900     window size in points
//   --scale 1            pixels per point in the PNG
//   --wait 12            longest wait (s) for window.__valoraReady before carrying on
//   --pre  "js"          run at document start (e.g. set localStorage)
//   --js   "js"          run after the page is ready (click something, scroll)
//   --after 1.0          wait (s) after --js before the snapshot
//   --eval "expr"        print EVAL: <JSON of the expression> after --js
//   --text               print the page's visible text (first 6000 characters)
//   --light              light theme (default is dark concrete)
//   --strict             exit 1 if any JavaScript error was seen
import AppKit
import WebKit

setvbuf(stdout, nil, _IOLBF, 0)
let argv = CommandLine.arguments
func opt(_ n: String, _ d: String) -> String {
    if let i = argv.firstIndex(of: "--" + n), i + 1 < argv.count { return argv[i + 1] }
    return d
}
func has(_ n: String) -> Bool { argv.contains("--" + n) }
guard argv.count >= 3, !argv[1].hasPrefix("--") else {
    print("usage: tools/snap <path#route> <out.png> [--w 1440] [--h 900] [--scale 1] [--wait 12] [--pre js] [--js js] [--after 1.0] [--eval expr] [--text] [--light] [--strict]")
    exit(2)
}
let route = argv[1], outPath = argv[2]
let W = Double(opt("w", "1440")) ?? 1440, H = Double(opt("h", "900")) ?? 900
let scale = Double(opt("scale", "1")) ?? 1
let maxWait = Double(opt("wait", "12")) ?? 12, after = Double(opt("after", "1.0")) ?? 1.0
let root: URL = {
    if let r = ProcessInfo.processInfo.environment["TENOR_ROOT"] { return URL(fileURLWithPath: r) }
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    if FileManager.default.fileExists(atPath: cwd.appendingPathComponent("web/index.html").path) { return cwd }
    return URL(fileURLWithPath: argv[0]).resolvingSymlinksInPath().deletingLastPathComponent().deletingLastPathComponent()
}()

func mime(_ p: String) -> String {
    switch (p as NSString).pathExtension.lowercased() {
    case "html": return "text/html"
    case "css": return "text/css"
    case "js", "mjs": return "text/javascript"
    case "json": return "application/json"
    case "svg": return "image/svg+xml"
    case "png": return "image/png"
    case "woff2": return "font/woff2"
    default: return "application/octet-stream"
    }
}

final class Files: NSObject, WKURLSchemeHandler {
    var stopped = Set<ObjectIdentifier>()
    var cache = [String: (Int, Data)]()
    let lock = NSLock()

    func python(_ method: String, _ path: String, _ body: String) -> (Int, Data) {
        let p = Process()
        p.executableURL = root.appendingPathComponent(".venv/bin/python")
        p.arguments = ["-W", "ignore", "-m", "valora", "api", method, path] + (method == "GET" ? [] : [body])
        p.currentDirectoryURL = root
        let pipe = Pipe(), err = Pipe()
        p.standardOutput = pipe; p.standardError = err
        do { try p.run() } catch { return (500, Data("{\"error\":\"python did not start\"}".utf8)) }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let e = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        if p.terminationStatus != 0 {
            let tail = String(data: e, encoding: .utf8)?.split(separator: "\n").suffix(3).joined(separator: " | ") ?? ""
            print("API \(method) \(path) -> exit \(p.terminationStatus) \(tail)")
            return (p.terminationStatus == 3 ? 404 : 500, data.isEmpty ? Data("{\"error\":\"api failed\"}".utf8) : data)
        }
        return (200, data)
    }

    func finish(_ task: WKURLSchemeTask, _ url: URL, _ code: Int, _ data: Data, _ type: String) {
        if stopped.contains(ObjectIdentifier(task)) { return }
        let r = HTTPURLResponse(url: url, statusCode: code, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": type + (type.hasPrefix("text/") || type.hasSuffix("json") ? "; charset=utf-8" : ""),
            "Content-Length": String(data.count), "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*"])!
        task.didReceive(r); task.didReceive(data); task.didFinish()
    }

    func webView(_ w: WKWebView, start task: WKURLSchemeTask) {
        let url = task.request.url!
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        if path.hasPrefix("/api/") {
            let method = task.request.httpMethod ?? "GET"
            let full = path + (url.query.map { "?" + $0 } ?? "")
            var body = "{}"
            if let b = task.request.httpBody, let s = String(data: b, encoding: .utf8) { body = s }
            else if let st = task.request.httpBodyStream {
                st.open(); var d = Data(); var buf = [UInt8](repeating: 0, count: 4096)
                while st.hasBytesAvailable { let n = st.read(&buf, maxLength: 4096); if n <= 0 { break }; d.append(buf, count: n) }
                st.close(); if let s = String(data: d, encoding: .utf8), !s.isEmpty { body = s }
            }
            DispatchQueue.global().async {
                var res: (Int, Data)
                self.lock.lock(); let hit = method == "GET" ? self.cache[full] : nil; self.lock.unlock()
                if let h = hit { res = h } else {
                    res = self.python(method, full, body)
                    self.lock.lock()
                    if method == "GET" { self.cache[full] = res } else { self.cache.removeAll() }
                    self.lock.unlock()
                }
                DispatchQueue.main.async { self.finish(task, url, res.0, res.1, "application/json") }
            }
            return
        }
        let file = root.appendingPathComponent("web" + path)
        if let d = try? Data(contentsOf: file) { finish(task, url, 200, d, mime(path)) }
        else { print("404 \(path)"); finish(task, url, 404, Data("not found".utf8), "text/plain") }
    }

    func webView(_ w: WKWebView, stop task: WKURLSchemeTask) { stopped.insert(ObjectIdentifier(task)) }
}

final class Snap: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    var web: WKWebView!
    var window: NSWindow!
    var errors = 0
    var started = Date()

    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard m.name == "log", let s = m.body as? String else { return }
        if s.hasPrefix("ERROR") || s.hasPrefix("REJECTION") || s.hasPrefix("RESOURCE") || s.hasPrefix("error:") { errors += 1 }
        print(s)
    }

    func run() {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .nonPersistent()
        cfg.setURLSchemeHandler(Files(), forURLScheme: "valora")
        let hook = """
        (function(){
          const send=(k,a)=>{try{window.webkit.messageHandlers.log.postMessage(k+": "+a.map(x=>{try{return typeof x==="string"?x:(x&&x.stack)||JSON.stringify(x)}catch(e){return String(x)}}).join(" "))}catch(e){}};
          for(const k of ["log","warn","error","info"]){const o=console[k];console[k]=function(...a){send(k,a);o.apply(console,a)}}
          window.addEventListener("error",e=>{if(e.target&&e.target!==window&&(e.target.src||e.target.href))send("RESOURCE",["failed to load "+(e.target.src||e.target.href)]);else send("ERROR",[e.message+" @ "+String(e.filename||"").split("/").slice(-2).join("/")+":"+e.lineno+":"+e.colno])},true);
          window.addEventListener("unhandledrejection",e=>send("REJECTION",[(e.reason&&(e.reason.stack||e.reason.message))||String(e.reason)]));
        })();
        """
        var pre = hook
        if has("light") { pre += "try{localStorage.setItem('va_theme','light')}catch(e){}" }
        if has("dark") { pre += "try{localStorage.setItem('va_theme','dark')}catch(e){}" }
        pre += opt("pre", "")
        cfg.userContentController.addUserScript(WKUserScript(source: pre, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // handlers the real app provides, so pages that talk to it don't throw here
        for n in ["log", "theme", "app"] { cfg.userContentController.add(self, name: n) }
        window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: W, height: H), styleMask: [.borderless], backing: .buffered, defer: false)
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: W, height: H), configuration: cfg)
        web.navigationDelegate = self
        window.contentView = web
        window.orderBack(nil)
        web.load(URLRequest(url: URL(string: "valora://app/" + route)!))
    }

    func webView(_ w: WKWebView, didFinish n: WKNavigation!) { started = Date(); poll() }
    func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { print("LOAD FAILED \(e.localizedDescription)"); exit(3) }
    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { print("LOAD FAILED \(e.localizedDescription)"); exit(3) }

    func poll() {
        web.evaluateJavaScript("!!window.__valoraReady") { r, _ in
            let ready = (r as? Bool) ?? false
            if ready || Date().timeIntervalSince(self.started) > maxWait {
                if !ready { print("NOTE: window.__valoraReady never became true (waited \(Int(maxWait))s)") }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { self.act() }
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self.poll() }
            }
        }
    }

    func act() {
        let js = opt("js", "")
        if js.isEmpty { return finishUp() }
        web.evaluateJavaScript("(function(){\(js)\n;return 0})()") { _, e in
            if let e = e { print("JS FAILED: \(e.localizedDescription) \((e as NSError).userInfo["WKJavaScriptExceptionMessage"] ?? "")"); self.errors += 1 }
            DispatchQueue.main.asyncAfter(deadline: .now() + after) { self.finishUp() }
        }
    }

    func finishUp() {
        let ev = opt("eval", "")
        let step2 = {
            if has("text") {
                self.web.evaluateJavaScript("document.body.innerText.slice(0,6000)") { r, _ in
                    print("TEXT:\n" + ((r as? String) ?? "")); self.shoot()
                }
            } else { self.shoot() }
        }
        if ev.isEmpty { return step2() }
        web.evaluateJavaScript("JSON.stringify((function(){return (\(ev))})())") { r, e in
            if let e = e { print("EVAL FAILED: \((e as NSError).userInfo["WKJavaScriptExceptionMessage"] ?? e.localizedDescription)") }
            else { print("EVAL: " + ((r as? String) ?? "undefined")) }
            step2()
        }
    }

    func shoot() {
        let c = WKSnapshotConfiguration()
        c.rect = NSRect(x: 0, y: 0, width: W, height: H)
        web.takeSnapshot(with: c) { img, e in
            guard let img = img else { print("SNAPSHOT FAILED \(e?.localizedDescription ?? "")"); exit(4) }
            let pw = Int(W * scale), ph = Int(H * scale)
            let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pw, pixelsHigh: ph, bitsPerSample: 8, samplesPerPixel: 4,
                                       hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
            rep.size = NSSize(width: W, height: H)
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
            img.draw(in: NSRect(x: 0, y: 0, width: W, height: H))
            NSGraphicsContext.restoreGraphicsState()
            do { try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: outPath)) }
            catch { print("WRITE FAILED \(error.localizedDescription)"); exit(4) }
            print("SAVED \(outPath) (\(pw)x\(ph))  js errors: \(self.errors)")
            exit(has("strict") && self.errors > 0 ? 1 : 0)
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let snap = Snap()
snap.run()
DispatchQueue.main.asyncAfter(deadline: .now() + maxWait + after + 40) { print("TIMEOUT"); exit(5) }
app.run()
