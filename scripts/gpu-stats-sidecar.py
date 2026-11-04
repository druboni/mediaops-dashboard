#!/usr/bin/env python3
"""
GPU stats sidecar for MediaOps Dashboard's System page (NVIDIA only).

Glances' own GPU plugin only reports the compute/3D load. Plex and Jellyfin
transcode on the separate NVENC/NVDEC video engines, which nvidia-smi reports
on their own, so a busy transcoding GPU shows ~0% there. This reports all
three, plus VRAM in MB and power.

Stdlib only, needs nvidia-smi on the PATH:

    python3 gpu-stats-sidecar.py          # 0.0.0.0:61209
    python3 gpu-stats-sidecar.py 9000     # custom port

Then in MediaOps: Settings -> Monitored Servers -> that server -> GPU port.
On plexgpu (.21) it runs as gpu-stats.service from /opt/gpu-stats/server.py.
"""

import json
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

FIELDS = [
    ("name", "name"),
    ("gpu_util", "utilization.gpu"),
    ("enc_util", "utilization.encoder"),
    ("dec_util", "utilization.decoder"),
    ("mem_util", "utilization.memory"),   # memory bandwidth, not VRAM used
    ("mem_used", "memory.used"),
    ("mem_total", "memory.total"),
    ("temp", "temperature.gpu"),
    ("power_draw", "power.draw"),
    ("power_limit", "power.limit"),
]


def number(value):
    """nvidia-smi prints [N/A] or [Not Supported] for fields a card lacks."""
    try:
        return float(value)
    except ValueError:
        return None


def read_gpu():
    out = subprocess.check_output(
        ["nvidia-smi", f"--query-gpu={','.join(f for _, f in FIELDS)}", "--format=csv,noheader,nounits"],
        text=True, timeout=10,
    ).splitlines()[0].split(",")
    data = {key: value.strip() if key == "name" else number(value.strip()) for (key, _), value in zip(FIELDS, out)}
    # Older clients do .toFixed() on these, so never send null for them.
    for key in ("gpu_util", "mem_util", "mem_used", "mem_total", "temp", "power_draw", "power_limit"):
        data[key] = data[key] or 0.0
    return data


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        try:
            data = read_gpu()
        except Exception as e:
            data = {"error": str(e)}
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 61209
    HTTPServer(("0.0.0.0", port), Handler).serve_forever()
