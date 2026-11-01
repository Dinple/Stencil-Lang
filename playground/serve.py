#!/usr/bin/env python3
"""Serve the Stencil playground locally.

    python3 playground/serve.py          # http://localhost:8765/ (or the next free port)
    python3 playground/serve.py --port 9000

Only the Python standard library is needed. Files are served from the repository root,
so the playground can load ../core and ../examples. Nothing is written to disk.
"""

import argparse
import functools
import http.server
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".stencil": "text/plain; charset=utf-8",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", "/playground/")
            self.end_headers()
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        pass


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    handler = functools.partial(Handler, directory=str(ROOT))
    for port in range(args.port, args.port + 20):  # skip ports other tools already use
        try:
            server = http.server.ThreadingHTTPServer((args.host, port), handler)
            break
        except OSError:
            continue
    else:
        raise SystemExit(f"no free port in {args.port}..{args.port + 19}; pass --port")
    print(f"Stencil playground: http://localhost:{port}/playground/   (Ctrl-C to stop)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
