#!/usr/bin/env python3
"""
Speedtest sidecar for MediaOps Dashboard's System page.

Run this on any server you want a "Speed Test" button for. It's the same
pattern as the optional GPU stats sidecar — a tiny HTTP endpoint on the
server itself, since testing that server's actual internet connection has
to happen from that server, not from wherever MediaOps runs.

Requires Ookla's official `speedtest` CLI already installed and on PATH
(https://www.speedtest.net/apps/cli) — the same `speedtest` command you'd
run by hand. No Python packages needed, stdlib only.

Setup:
    speedtest --accept-license --accept-gdpr   # one-time, if you haven't already
    python3 speedtest-sidecar.py               # listens on 0.0.0.0:8765
    python3 speedtest-sidecar.py 9000           # or a custom port

Then in MediaOps: Settings -> Monitored Servers -> set "Speedtest port" to
whatever port you ran this on.

GET /speedtest runs a real speedtest (takes 10-30+ seconds) and returns:
    {"download": 943.2, "upload": 891.4, "ping": 12.3, "server": "...", "isp": "..."}
download/upload are in Mbps, ping in ms. Every other path returns 404.
"""

import json
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def run_speedtest():
    proc = subprocess.run(
        ["speedtest", "--accept-license", "--accept-gdpr", "-f", "json"],
        capture_output=True,
        text=True,
        timeout=90,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "speedtest CLI exited with an error")

    r = json.loads(proc.stdout)
    server = r.get("server", {})
    return {
        "download": round(r["download"]["bandwidth"] * 8 / 1_000_000, 2),  # bytes/sec -> Mbps
        "upload": round(r["upload"]["bandwidth"] * 8 / 1_000_000, 2),
        "ping": round(r["ping"]["latency"], 1),
        "server": " - ".join(filter(None, [server.get("name"), server.get("location")])) or None,
        "isp": r.get("isp"),
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[speedtest-sidecar] {self.address_string()} - {fmt % args}")

    def do_GET(self):
        if self.path != "/speedtest":
            self.send_response(404)
            self.end_headers()
            return

        try:
            result = run_speedtest()
            body = json.dumps(result).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as err:
            body = json.dumps({"error": str(err)}).encode()
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"speedtest-sidecar listening on :{port} (GET /speedtest)")
    server.serve_forever()
