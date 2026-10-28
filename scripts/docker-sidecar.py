#!/usr/bin/env python3
"""
Docker sidecar for MediaOps Dashboard's System page.

MediaOps lists, restarts and shows logs for the containers on the machine it
runs on through the local Docker socket. Run this on any OTHER server whose
containers you want on the System page too. It forwards only the handful of
Docker API calls the System page makes, and strips what it doesn't need
(environment variables hold API keys), so it is much narrower than exposing
the Docker API itself.

Stdlib only. Needs read access to /var/run/docker.sock and a shared token:

    DOCKER_SIDECAR_TOKEN=<long random string> python3 docker-sidecar.py        # 0.0.0.0:8767
    DOCKER_SIDECAR_TOKEN=... python3 docker-sidecar.py 9000                      # custom port

or as a container (see scripts/docker-sidecar.compose.yml).

Then in MediaOps: Settings -> Monitored Servers -> that server -> Docker port
and Docker token.

Every request needs "Authorization: Bearer <token>". Allowed:
    GET  /containers/json?all=1
    GET  /containers/{id}/json           (only Image and Config.Image)
    GET  /containers/{id}/logs?...       (stdout/stderr/tail/timestamps)
    GET  /images/{id}/json               (only RepoDigests)
    POST /containers/{id}/restart?t=10
Everything else is 404.
"""

import hmac
import http.client
import json
import os
import re
import socket
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlencode, urlsplit

SOCKET = os.environ.get("DOCKER_SOCKET", "/var/run/docker.sock")
TOKEN = os.environ.get("DOCKER_SIDECAR_TOKEN", "")
NAME = r"[A-Za-z0-9_.-]+"
LOG_PARAMS = {"stdout", "stderr", "tail", "timestamps"}


class DockerConnection(http.client.HTTPConnection):
    def __init__(self, timeout):
        super().__init__("localhost", timeout=timeout)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(SOCKET)


def docker(method, path, timeout=20):
    conn = DockerConnection(timeout)
    try:
        conn.request(method, path, headers={"Host": "localhost", "Content-Length": "0"})
        res = conn.getresponse()
        return res.status, res.getheader("Content-Type", "application/json"), res.read()
    finally:
        conn.close()


def only(params, allowed):
    return urlencode({k: v[0] for k, v in params.items() if k in allowed})


class Handler(BaseHTTPRequestHandler):
    def send(self, status, body, content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def error(self, status, message):
        self.send(status, json.dumps({"message": message}).encode())

    def authorized(self):
        given = self.headers.get("Authorization", "")
        return bool(TOKEN) and hmac.compare_digest(given.encode(), f"Bearer {TOKEN}".encode())

    def route(self, method):
        if not self.authorized():
            return self.error(401, "Missing or wrong token")
        url = urlsplit(self.path)
        params = parse_qs(url.query)
        path = unquote(url.path)

        if method == "GET" and path == "/containers/json":
            return self.forward("GET", "/containers/json?all=1")

        m = re.fullmatch(rf"/containers/({NAME})/json", path)
        if method == "GET" and m:
            status, _, raw = docker("GET", f"/containers/{m[1]}/json")
            if status != 200:
                return self.send(status, raw)
            info = json.loads(raw)
            slim = {"Image": info.get("Image"), "Config": {"Image": (info.get("Config") or {}).get("Image")}}
            return self.send(200, json.dumps(slim).encode())

        m = re.fullmatch(rf"/containers/({NAME})/logs", path)
        if method == "GET" and m:
            return self.forward("GET", f"/containers/{m[1]}/logs?{only(params, LOG_PARAMS)}")

        m = re.fullmatch(rf"/images/({NAME}(?::[A-Za-z0-9]+)?)/json", path)
        if method == "GET" and m:
            status, _, raw = docker("GET", f"/images/{m[1]}/json")
            if status != 200:
                return self.send(status, raw)
            return self.send(200, json.dumps({"RepoDigests": json.loads(raw).get("RepoDigests", [])}).encode())

        m = re.fullmatch(rf"/containers/({NAME})/restart", path)
        if method == "POST" and m:
            return self.forward("POST", f"/containers/{m[1]}/restart?t=10", timeout=40)

        return self.error(404, "Not found")

    def forward(self, method, path, timeout=20):
        try:
            status, content_type, body = docker(method, path, timeout)
        except OSError as e:
            return self.error(502, f"Docker socket: {e}")
        self.send(status, body, content_type)

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    if len(TOKEN) < 16:
        sys.exit("Set DOCKER_SIDECAR_TOKEN to a random string of at least 16 characters")
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8767
    print(f"Docker sidecar listening on 0.0.0.0:{port}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
