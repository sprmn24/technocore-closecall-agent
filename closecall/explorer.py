"""Serve the browser app (closecall/web) on 127.0.0.1.

The app is fully static: it talks to technocore.chat and Hyperliquid straight from the
browser, signs in the browser, and has no server of its own. This command exists for
running it locally; in production the same files are served by GitHub Pages.
"""

from __future__ import annotations

import http.server
from importlib import resources

FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/core.js": ("core.js", "text/javascript; charset=utf-8"),
    "/i18n.js": ("i18n.js", "text/javascript; charset=utf-8"),
    "/app.css": ("app.css", "text/css; charset=utf-8"),
    **{f"/i18n/{lang}.js": (f"i18n/{lang}.js", "text/javascript; charset=utf-8") for lang in ("en", "pt", "ja", "ko", "ar", "tr", "fr")},
}


def serve(port: int) -> None:
    web = resources.files(__package__).joinpath("web")

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            entry = FILES.get(self.path.split("?", 1)[0])
            if not entry:
                self.send_response(404)
                self.end_headers()
                return
            body = web.joinpath(entry[0]).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", entry[1])
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Close Call app on http://127.0.0.1:{port}  (Ctrl+C to stop)")
    httpd.serve_forever()
