// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Python: Alpine's aarch64 python3 (main, 3.14, about 8.5 MB to download, a
// little more with the libraries it pulls in) serving a notes wall on port
// 8000 from the standard library alone: http.server, sqlite3 and html, so no
// pip and no virtualenv.
//
// Unlike the Node.js demo (a live dashboard polled with fetch), this page is
// plain server-rendered HTML that works without JavaScript: the form POSTs,
// the server stores the note in SQLite and answers 303 to ./ (post, redirect,
// get), so a reload never posts twice. URLs are relative, since the page is
// served under /vm/<id>/8000/. The server binds 0.0.0.0, not ::, because the
// guest has no IPv6 and the preview connects to 127.0.0.1. No cookies or
// WebSockets: the preview relays plain HTTP only.
//
// The database is /data/python-demo/notes.db when the data disk is mounted,
// so the notes survive reboots, else notes.db next to app.py; it is seeded
// with two notes the first time. Times are the guest's clock and time zone.
// Every value from a note goes through html.escape, and the server caps the
// name, the message, the request body and the notes shown. ThreadingHTTPServer
// gives each request a thread with its own SQLite connection. python3 -u, so
// the one log line per request reaches the window at once. Alpine's python3
// ships no precompiled bytecode (that is the pyc package), so the first start
// compiles the modules it imports and writes them to __pycache__; later starts
// are faster.
import type { Demo } from "../launcher.ts";

const APP = String.raw`#!/usr/bin/env python3
# The unkernel Python demo: a notes wall from the standard library alone.
#   GET  /           the wall: a form and the notes, newest first
#   POST /           store a note (form fields name, message), then 303 to ./
#   GET  /api/notes  the same notes as JSON (?limit=N)
# PORT, HOST and NOTES_DB override where it listens and what it stores to.
# One log line per request. After editing this file, press Ctrl-C and run
# ./run.sh again.
import html
import itertools
import json
import os
import platform
import sqlite3
import string
import sys
import threading
import time
from contextlib import closing
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

PORT = int(os.environ.get("PORT") or 8000)
HOST = os.environ.get("HOST") or "0.0.0.0"  # IPv4: the guest has no IPv6
HERE = os.path.dirname(os.path.abspath(__file__))
if os.environ.get("NOTES_DB"):
    DB, WHERE = os.environ["NOTES_DB"], "set by NOTES_DB"
elif os.path.ismount("/data"):
    DB, WHERE = "/data/python-demo/notes.db", "on the data disk, kept across reboots"
else:
    DB, WHERE = os.path.join(HERE, "notes.db"), "no data disk: lost at reboot"

MAX_NAME, MAX_MESSAGE, MAX_BODY, SHOWN = 40, 280, 16384, 100
SEED = [
    ("unkernel", "Welcome! This wall is a Python program: http.server and sqlite3 "
     "from the standard library, on aarch64 Linux, in your browser tab."),
    ("app.py", "Leave a note below. It goes into SQLite, and the page you get back "
     "after the redirect lists it here, newest first."),
]


def since_exec():
    """Seconds from this process's exec to now, from /proc (None elsewhere)."""
    try:
        with open("/proc/self/stat") as f:
            start = int(f.read().rsplit(")", 1)[1].split()[19])
        with open("/proc/uptime") as f:
            up = float(f.read().split()[0])
        return up - start / os.sysconf("SC_CLK_TCK")
    except (OSError, ValueError, IndexError):
        return None


def connect():
    db = sqlite3.connect(DB, timeout=10)
    db.row_factory = sqlite3.Row
    return db


def init_db():
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    with closing(connect()) as db, db:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("""CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            message TEXT NOT NULL,
            created REAL NOT NULL)""")
        if db.execute("SELECT COUNT(*) FROM notes").fetchone()[0] == 0:
            now = time.time()
            db.executemany("INSERT INTO notes (name, message, created) VALUES (?, ?, ?)",
                           [(n, m, now - 60 * i) for i, (n, m) in enumerate(SEED)])


def recent(limit):
    t0 = time.perf_counter()
    with closing(connect()) as db:
        rows = db.execute("SELECT id, name, message, created FROM notes "
                          "ORDER BY created DESC, id DESC LIMIT ?", (limit,)).fetchall()
        total = db.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
    return rows, total, (time.perf_counter() - t0) * 1000


def add(name, message):
    with closing(connect()) as db, db:
        db.execute("INSERT INTO notes (name, message, created) VALUES (?, ?, ?)",
                   (name, message, time.time()))


def span(s):
    for unit, n in (("d", 86400), ("h", 3600), ("min", 60)):
        if s >= n:
            return f"{int(s // n)} {unit}"
    return ""


def ago(ts):
    s = span(max(0, time.time() - ts))
    return s + " ago" if s else "just now"


def stamp(ts):
    return time.strftime("%Y-%m-%d %H:%M:%S %Z", time.localtime(ts))


TTY = sys.stdout.isatty()
paint = (lambda code, s: f"\033[{code}m{s}\033[0m") if TTY else (lambda code, s: s)
counter = itertools.count(1)
lock = threading.Lock()
started = time.time()
ready_in = None


class Handler(BaseHTTPRequestHandler):
    server_version = "unkernel-python/1"
    protocol_version = "HTTP/1.1"

    # From the request line on, not from the connection's idle wait.
    def parse_request(self):
        self.t0 = time.perf_counter()
        return super().parse_request()

    # http.server's own access log is replaced by log_line.
    def log_request(self, code="-", size="-"):
        pass

    def log_line(self, status):
        with lock:
            n = next(counter)
        took = f"{(time.perf_counter() - self.t0) * 1000:.1f} ms"
        colour = 32 if status < 300 else 36 if status < 400 else 33
        print(f"{paint(90, time.strftime('%H:%M:%S'))}  {paint(90, '#' + str(n))}  "
              f"{self.command} {self.path}  {paint(colour, status)}  {paint(90, took)}")

    def send(self, status, ctype, body=b"", headers=()):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        self.log_line(status)

    def text(self, status, msg):
        self.send(status, "text/plain; charset=utf-8", (msg + "\n").encode())

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path in ("/", "/index.html"):
            self.send(200, "text/html; charset=utf-8", render().encode())
        elif url.path == "/api/notes":
            try:
                limit = min(max(int(parse_qs(url.query).get("limit", [SHOWN])[0]), 1), 1000)
            except ValueError:
                return self.text(400, "limit must be a number")
            rows, total, _ = recent(limit)
            body = {
                "total": total,
                "notes": [{"id": r["id"], "name": r["name"], "message": r["message"],
                           "created": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(r["created"]))}
                          for r in rows],
            }
            self.send(200, "application/json", json.dumps(body, indent=2).encode() + b"\n")
        elif url.path == "/favicon.ico":
            self.send(204, "text/plain")
        else:
            self.text(404, "not found: " + url.path)

    def do_POST(self):
        if urlsplit(self.path).path not in ("/", "/index.html"):
            return self.text(404, "not found: " + self.path)
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if not 0 <= length <= MAX_BODY:
            self.close_connection = True
            return self.text(413, f"a note is at most {MAX_BODY} bytes")
        form = parse_qs(self.rfile.read(length).decode("utf-8", "replace"))
        name = " ".join(form.get("name", [""])[0].split())[:MAX_NAME] or "anonymous"
        message = form.get("message", [""])[0].replace("\r\n", "\n").strip()[:MAX_MESSAGE]
        if message:
            add(name, message)
        # Post, redirect, get: relative, so it stays under the preview's prefix.
        self.send(303, "text/plain; charset=utf-8", b"see ./\n", [("Location", "./")])

    def log_error(self, fmt, *args):
        print(paint(33, "error: " + (fmt % args)))


def render():
    t0 = time.perf_counter()
    rows, total, query_ms = recent(SHOWN)
    notes = "\n".join(
        f'<article class="note{" y" if r["id"] % 2 else ""}">'
        f'<header><b>{html.escape(r["name"])}</b>'
        f'<time datetime="{time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(r["created"]))}" '
        f'title="{html.escape(stamp(r["created"]))}">{ago(r["created"])}</time></header>'
        f'<p>{html.escape(r["message"])}</p></article>'
        for r in rows)
    more = total - len(rows)
    return PAGE.substitute(
        notes=notes or '<p class="empty">No notes yet: be the first.</p>',
        count=f"{total} note{'' if total == 1 else 's'}",
        more=f'<p class="more">and {more} older, not shown (see api/notes?limit=1000)</p>' if more > 0 else "",
        max_name=MAX_NAME,
        max_message=MAX_MESSAGE,
        python=html.escape(platform.python_version()),
        version=html.escape(sys.version),
        impl=html.escape(platform.python_implementation()),
        machine=html.escape(platform.machine()),
        system=html.escape(f"{platform.system()} {platform.release()}"),
        sqlite=html.escape(sqlite3.sqlite_version),
        db=html.escape(DB),
        where=html.escape(WHERE),
        ready=f"{ready_in:.2f} s" if ready_in is not None else "-",
        up=span(time.time() - started) or "under a minute",
        query=f"{query_ms:.1f} ms",
        render=f"{(time.perf_counter() - t0) * 1000:.1f} ms",
        now=html.escape(stamp(time.time())),
    )


PAGE = string.Template("""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Python in unkernel</title>
<style>
  :root { color-scheme: dark; --fg: #e8eaf0; --dim: #9aa3b5; --line: #232a38; --card: #0d121c; --blue: #4b8bbe; --deep: #306998; --yellow: #ffd43b; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #06090f; color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 60rem; margin: 0 auto; padding: 2rem 1rem 3rem; }
  .top { display: flex; gap: 1rem; align-items: center; }
  .top svg { flex: none; width: 3.2rem; height: 3.2rem; }
  h1 { margin: 0; font-size: 1.6rem; }
  h2 { margin: 0 0 .75rem; font-size: .8rem; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); }
  p { color: var(--dim); }
  .mono, code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
  code { background: #161d2a; padding: .1rem .35rem; border-radius: 4px; color: var(--fg); }
  .pill { margin-left: auto; padding: .2rem .7rem; border: 1px solid var(--line); border-radius: 99px; font-size: 13px; color: var(--dim); white-space: nowrap; }
  form { display: grid; grid-template-columns: 1fr auto; gap: .6rem; align-items: start; margin: 1.5rem 0; padding: 1rem; border: 1px solid var(--line); border-radius: 12px; background: linear-gradient(135deg, #0f1e30, var(--card) 60%, #1f1c0c); }
  input, textarea { width: 100%; font: inherit; color: var(--fg); background: #070b12; border: 1px solid var(--line); border-radius: 8px; padding: .5rem .65rem; }
  input:focus, textarea:focus { outline: 2px solid var(--blue); outline-offset: -1px; }
  textarea { grid-column: 1 / -1; resize: vertical; min-height: 4.8rem; }
  button { font: inherit; font-weight: 600; color: #0b1320; background: linear-gradient(135deg, var(--yellow), #ffe873); border: 0; border-radius: 8px; padding: .5rem 1.1rem; cursor: pointer; }
  .hint { grid-column: 1 / -1; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0 1rem; margin: -.2rem 0 0; font-size: 12px; }
  .wall { display: grid; grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr)); gap: .75rem; align-items: start; }
  .note { padding: .8rem 1rem; border: 1px solid var(--line); border-top: 3px solid var(--blue); border-radius: 10px; background: var(--card); }
  .note.y { border-top-color: var(--yellow); }
  .note header { display: flex; justify-content: space-between; gap: .5rem; font-size: 13px; }
  .note header b { overflow-wrap: anywhere; }
  .note time { color: var(--dim); white-space: nowrap; }
  .note p { margin: .4rem 0 0; color: var(--fg); white-space: pre-wrap; overflow-wrap: anywhere; }
  .empty, .more { grid-column: 1 / -1; text-align: center; }
  footer { margin-top: 2rem; padding: 1rem; border: 1px solid var(--line); border-radius: 12px; background: var(--card); }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .3rem 1rem; align-items: baseline; margin: 0; }
  dt { color: var(--dim); }
  dd { margin: 0; font: 13px/1.6 ui-monospace, monospace; overflow-wrap: anywhere; }
</style>
</head>
<body>
<main>
  <div class="top">
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <defs><path id="snake" d="M24 4h-4c-4.5 0-6 2-6 5v4h10v2H10c-3.5 0-6 2.5-6 9s2.5 9 6 9h3v-5c0-3 2-5 5-5h11c2.8 0 5-2.2 5-5V9c0-3-2.5-5-6-5z"/></defs>
      <use href="#snake" fill="#4b8bbe"/>
      <use href="#snake" fill="#ffd43b" transform="rotate(180 24 24)"/>
      <circle cx="19" cy="8.6" r="1.6" fill="#06090f"/><circle cx="29" cy="39.4" r="1.6" fill="#06090f"/>
    </svg>
    <div>
      <h1>A notes wall, in Python</h1>
      <div class="mono" style="color:var(--dim)">Python $python &middot; $system &middot; $machine</div>
    </div>
    <span class="pill">$count</span>
  </div>
  <p>This page comes from <code>app.py</code>: <code>http.server</code>, <code>sqlite3</code> and <code>html</code> from the standard library, no pip. Python is the distro's aarch64 build, unmodified, on a Linux kernel compiled to WebAssembly, in your browser. Notes are stored in SQLite; times are the guest's clock.</p>

  <form method="post" action="./">
    <textarea name="message" maxlength="$max_message" placeholder="Leave a note..." required></textarea>
    <input name="name" maxlength="$max_name" placeholder="Your name (optional)" autocomplete="nickname">
    <button>Pin it</button>
    <p class="hint"><span>POST, then a 303 back here: reloading never posts twice.</span><span id="left">$max_message characters</span></p>
  </form>

  <div class="wall">
$notes
  </div>
  $more

  <footer>
    <h2>Rendered by Python</h2>
    <dl>
      <dt>platform.machine()</dt><dd>$machine</dd>
      <dt>sys.version</dt><dd>$version ($impl)</dd>
      <dt>sqlite3.sqlite_version</dt><dd>$sqlite</dd>
      <dt>database</dt><dd>$db ($where)</dd>
      <dt>exec to listening</dt><dd>$ready</dd>
      <dt>up for</dt><dd>$up</dd>
      <dt>this page</dt><dd>query $query, render $render, at $now</dd>
    </dl>
    <p>JSON: <a href="api/notes" style="color:var(--yellow)">api/notes</a>. After editing <code>app.py</code> in the terminal, press Ctrl-C there and run <code>./run.sh</code> again.</p>
  </footer>
</main>
<script>
  // Optional: the page works without it. A character count, and Ctrl-Enter posts.
  const ta = document.querySelector("textarea"), left = document.getElementById("left");
  const count = () => { left.textContent = (ta.maxLength - ta.value.length) + " characters left"; };
  ta.addEventListener("input", count);
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ta.form.requestSubmit(); });
</script>
</body>
</html>
""")


def main():
    global ready_in
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    ready_in = since_exec()
    after = f", ready {ready_in:.1f} s after exec" if ready_in is not None else ""
    print(paint(1, f"Python {platform.python_version()}") +
          f" on {platform.system()} {platform.release()} {platform.machine()}, pid {os.getpid()}{after}")
    print(f"Notes: {DB} ({WHERE}).")
    print(f"Listening on http://{HOST}:{PORT}/, one line per request. Ctrl-C stops it.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
`;

export default {
	id: "python",
	title: "Python",
	desc: "A notes wall from Python's standard library: http.server and SQLite, kept on the data disk",
	// The Python logo, from Simple Icons (CC0 1.0), slug python, split into its
	// two snakes: white and Python's yellow.
	icon: { svg: '<path d="M11.858 0c-.978.005-1.913.088-2.736.234C6.7.662 6.26 1.558 6.26 3.21v2.182h5.725v.727H4.111c-1.664 0-3.121 1-3.577 2.903-.526 2.181-.549 3.542 0 5.82.407 1.694 1.379 2.902 3.043 2.902h1.969v-2.616c0-1.89 1.635-3.557 3.576-3.557h5.72c1.591 0 2.862-1.31 2.862-2.91v-5.45c0-1.553-1.309-2.718-2.863-2.977A18 18 0 0 0 11.858 0M8.762 1.755c.591 0 1.074.491 1.074 1.095 0 .601-.483 1.087-1.074 1.087A1.08 1.08 0 0 1 7.688 2.85c0-.604.48-1.095 1.074-1.095"/><path fill="#ffd43b" d="M18.418 6.119v2.543c0 1.971-1.671 3.63-3.577 3.63H9.122c-1.566 0-2.862 1.34-2.862 2.91v5.452c0 1.551 1.349 2.464 2.862 2.91 1.813.532 3.55.628 5.72 0 1.44-.418 2.862-1.258 2.862-2.91V18.47h-5.719v-.727h8.582c1.664 0 2.284-1.16 2.862-2.903.598-1.793.573-3.518 0-5.819-.41-1.656-1.196-2.903-2.862-2.903zm-3.216 13.807a1.08 1.08 0 0 1 1.074 1.088c0 .604-.48 1.094-1.074 1.094-.592 0-1.075-.49-1.075-1.094 0-.601.483-1.088 1.075-1.088"/>' },
	colors: ["#4b8bbe", "#1d3d63"],
	needs: { net: true },
	files: {
		"app.py": { content: APP, mode: 0o755 },
	},
	packages: { alpine: ["python3"], debian: ["python3"] },
	commands: ["python3 -u app.py"],
	ports: [8000],
} satisfies Demo;
