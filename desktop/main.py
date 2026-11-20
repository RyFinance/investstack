"""InvestStack desktop app: the local engine in a background thread, the web app in a native window.

    .venv/bin/python desktop/main.py        # from a checkout
    dist/InvestStack.app  /  dist\\InvestStack\\InvestStack.exe   # frozen by PyInstaller (tools/make_app.py)

The window is pywebview (WKWebView on macOS, WebView2 on Windows). The page reaches Python
through `window.pywebview.api` (see Api). Everything is logged to <data dir>/valora.log.
"""
from __future__ import annotations

import logging
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from logging.handlers import RotatingFileHandler
from pathlib import Path

if not getattr(sys, "frozen", False):          # checkout: make `import valora` work from desktop/
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from valora import paths  # noqa: E402

PORT = 8780
TITLE = "InvestStack"
BACKGROUND = "#1b1c1f"
log = logging.getLogger("valora.desktop")


class _LogStream:
    """File-like object that sends writes to the log (a windowed app has no console)."""

    def __init__(self, level: int):
        self.level, self.buf = level, ""

    def write(self, s: str) -> int:
        self.buf += s
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            if line.strip():
                log.log(self.level, line.rstrip())
        return len(s)

    def flush(self) -> None:
        pass

    def isatty(self) -> bool:
        return False


def setup_logging() -> Path:
    f = paths.home() / "valora.log"
    h = RotatingFileHandler(f, maxBytes=1_000_000, backupCount=2, encoding="utf-8")
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(h)
    if getattr(sys, "frozen", False) or sys.stdout is None or sys.stderr is None:
        sys.stdout, sys.stderr = _LogStream(logging.INFO), _LogStream(logging.ERROR)
    else:
        root.addHandler(logging.StreamHandler())
    return f


def pick_port(preferred: int = PORT) -> int:
    """The preferred port if it is free on localhost, else one the OS assigns."""
    for port in (preferred, 0):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind(("127.0.0.1", port))
            return s.getsockname()[1]
        except OSError:
            continue
        finally:
            s.close()
    raise OSError("no free localhost port")


def start_server(preferred: int = PORT):
    """Start the engine on a free port in a daemon thread. Returns (httpd, port)."""
    from valora.server import make_server
    port = pick_port(preferred)
    try:
        httpd = make_server(port)
    except OSError:                              # lost a race for the port: let the OS choose
        httpd = make_server(0)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, name="valora-server", daemon=True).start()
    log.info("server on http://127.0.0.1:%s (data: %s)", port, paths.home())
    return httpd, port


def wait_ready(port: int, timeout: float = 20.0) -> bool:
    url = f"http://127.0.0.1:{port}/api/state"
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.1)
    return False


def write_text(path: str | os.PathLike, text: str) -> str:
    p = Path(path)
    p.write_text(text, encoding="utf-8", newline="")
    return str(p)


def _first(result) -> str | None:
    """pywebview returns None, a string or a tuple of paths depending on platform and version."""
    if not result:
        return None
    if isinstance(result, (list, tuple)):
        return str(result[0]) if result[0] else None
    return str(result)


class Api:
    """Exposed to the page as window.pywebview.api. Names without a leading underscore are callable from JS."""

    def __init__(self, ask=None):
        self._window = None
        self._ask = ask                          # tests replace the native dialog: ask(name) -> path or None

    def _dialog(self, name: str) -> str | None:
        if self._ask:
            return self._ask(name)
        import webview
        try:
            kind = webview.FileDialog.SAVE       # pywebview >= 6
        except AttributeError:
            kind = webview.SAVE_DIALOG
        return _first(self._window.create_file_dialog(kind, save_filename=name))

    def save(self, name, text):
        """Native save dialog; writes text as UTF-8. Returns the saved path, or None if cancelled."""
        try:
            path = self._dialog(os.path.basename(str(name)) or "export.txt")
            if not path:
                return None
            saved = write_text(path, "" if text is None else str(text))
            log.info("saved %s", saved)
            return saved
        except Exception:
            log.exception("save failed")
            return None

    def open_url(self, url):
        """Open an http(s) link in the system browser. Returns True if it was handed off."""
        u = str(url or "").strip()
        if not u.lower().startswith(("http://", "https://")):
            log.warning("open_url refused %r", u[:200])
            return False
        try:
            return bool(self._open(u))
        except Exception:
            log.exception("open_url failed")
            return False

    def _open(self, url: str) -> bool:
        import webbrowser
        return webbrowser.open(url)

    def open_data_folder(self):
        """Show the data folder in Finder / Explorer. Returns its path."""
        folder = str(paths.home())
        try:
            if sys.platform == "darwin":
                subprocess.Popen(["open", folder])
            elif os.name == "nt":
                os.startfile(folder)             # noqa: S606
            else:
                subprocess.Popen(["xdg-open", folder])
        except Exception:
            log.exception("open_data_folder failed")
        return folder


def main() -> int:
    logfile = setup_logging()
    log.info("starting (frozen=%s, python %s, %s)", bool(getattr(sys, "frozen", False)),
             sys.version.split()[0], sys.platform)
    try:
        httpd, port = start_server()
        if not wait_ready(port):
            log.error("server did not answer on port %s", port)
            return 1
        if os.environ.get("VALORA_NO_WINDOW"):   # headless: engine only (build smoke test)
            log.info("VALORA_NO_WINDOW set: serving without a window")
            threading.Event().wait()
        import webview
        api = Api()
        window = webview.create_window(
            TITLE, f"http://127.0.0.1:{port}/?app=1", js_api=api,
            width=1440, height=900, min_size=(1100, 700), background_color=BACKGROUND, text_select=True)
        api._window = window
        log.info("window created; log at %s", logfile)
        webview.start(private_mode=False,        # keep localStorage (theme, layout prefs) between runs
                      storage_path=str(paths.sub("webview")))
        log.info("window closed")
        httpd.shutdown()
        return 0
    except Exception:
        log.exception("fatal")
        return 1


if __name__ == "__main__":
    sys.exit(main())
