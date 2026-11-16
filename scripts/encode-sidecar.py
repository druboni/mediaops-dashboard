#!/usr/bin/env python3
"""
Encode sidecar for MediaOps Dashboard's Reclaim page: shrink a video in place
with the GPU.

MediaOps sends it a file path. Jobs run one at a time:

    1. copy      the file from the (spinning-disk) library to a fast local work dir
    2. encode    ffmpeg hevc_nvenc -rc vbr -cq N -preset p4, audio/subtitles copied
    3. verify    the output is HEVC, as long as the source, has every audio track,
                 and is actually smaller (if not, it's thrown away and the
                 original is left alone)
    4. replace   copy back next to the original under a hidden temp name, rename
                 it over the original (an .mp4/.avi source becomes .mkv and the
                 old file is removed)

The original is only touched in step 4, after every check has passed, and not
at all if it changed on disk while the job ran (say Radarr upgraded it).

Stdlib only. Needs ffmpeg/ffprobe with hevc_nvenc on the PATH, write access to
the library, and a shared token:

    ENCODE_SIDECAR_TOKEN=<long random string> python3 encode-sidecar.py      # 0.0.0.0:8768
    ENCODE_SIDECAR_TOKEN=... python3 encode-sidecar.py 9000                    # custom port

Environment:
    ENCODE_SIDECAR_TOKEN   required; every request needs "Authorization: Bearer <token>"
    ENCODE_ROOTS           colon-separated folders a job may touch (default /mnt/plex)
    ENCODE_WORK_DIR        scratch space on fast disk (default ~/mediaops-encode)

On plexgpu (.21) it runs as encode-sidecar.service (scripts/encode-sidecar.service).
Then in MediaOps: Settings -> Monitored Servers -> that server -> Encode.

API:
    GET  /jobs                 every job, newest first, plus work-dir free space
    GET  /history              every finished job ever (history.jsonl): totals + newest 1000
    POST /jobs                 {path, cq?, label?, meta?} -> the job (an existing
                               queued/running job for the same path is returned instead)
    POST /jobs/{id}/cancel     stop a queued or running job (the original is untouched)
    POST /jobs/{id}/ack        mark a finished job as handled by MediaOps
    DELETE /jobs/{id}          forget a finished job
"""

import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

TOKEN = os.environ.get("ENCODE_SIDECAR_TOKEN", "")
ROOTS = [os.path.realpath(r) for r in os.environ.get("ENCODE_ROOTS", "/mnt/plex").split(":") if r]
WORK = os.path.expanduser(os.environ.get("ENCODE_WORK_DIR", "~/mediaops-encode"))
STATE = os.path.join(WORK, "jobs.json")
HISTORY = os.path.join(WORK, "history.jsonl")

VIDEO_EXTS = {".mkv", ".mp4", ".m4v", ".avi", ".mov", ".wmv", ".ts", ".m2ts", ".mpg", ".mpeg", ".webm"}
# Containers whose text subtitles (mov_text) can't be copied into Matroska as-is.
MP4ISH = {".mp4", ".m4v", ".mov"}
ACTIVE = ("copying", "encoding", "verifying", "replacing")
FINISHED = ("done", "skipped", "failed", "cancelled")
KEEP_FINISHED = 300
CHUNK = 8 * 1024 * 1024
# Free space needed in the work dir: source + output (never larger than the
# source, or it's discarded) + headroom.
HEADROOM = 10 * 1024**3
# An output has to save at least this much to be worth swapping in.
MIN_SAVING = 0.05
CQ_RANGE = (15, 40)

lock = threading.Lock()
wake = threading.Event()
jobs = {}            # id -> job dict
cancel_flags = {}    # id -> threading.Event
current_proc = {}    # id -> subprocess.Popen


class Cancelled(Exception):
    pass


class JobError(Exception):
    pass


# ── State ──────────────────────────────────────────────────────────────────

def now():
    return time.time()


def save_state():
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(list(jobs.values()), f)
    os.replace(tmp, STATE)


def load_state():
    try:
        with open(STATE) as f:
            for job in json.load(f):
                # A restart mid-job leaves only scratch files behind; the
                # original is never touched until the final rename.
                if job["status"] in ACTIVE:
                    job.update(status="failed", error="Interrupted by a sidecar restart", finished=now())
                jobs[job["id"]] = job
    except FileNotFoundError:
        pass
    except Exception as e:
        print(f"Couldn't read {STATE}: {e}", file=sys.stderr)


def update(job, **fields):
    with lock:
        job.update(fields)
        save_state()


def prune():
    finished = sorted((j for j in jobs.values() if j["status"] in FINISHED), key=lambda j: j.get("finished") or 0)
    for j in finished[:-KEEP_FINISHED] if len(finished) > KEEP_FINISHED else []:
        jobs.pop(j["id"], None)


def record_history(job):
    try:
        with open(HISTORY, "a") as f:
            f.write(json.dumps({k: job.get(k) for k in (
                "id", "path", "outPath", "status", "error", "cq", "origSize", "newSize", "started", "finished", "label")}) + "\n")
    except OSError:
        pass


HISTORY_LIMIT = 1000


def read_history():
    """Totals over every finished job ever, plus the newest HISTORY_LIMIT entries."""
    entries, totals = [], {s: 0 for s in FINISHED}
    saved = before = 0
    try:
        with open(HISTORY) as f:
            for line in f:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                totals[e.get("status")] = totals.get(e.get("status"), 0) + 1
                if e.get("status") == "done" and e.get("origSize") and e.get("newSize"):
                    saved += e["origSize"] - e["newSize"]
                    before += e["origSize"]
                entries.append(e)
    except FileNotFoundError:
        pass
    entries.sort(key=lambda e: e.get("finished") or 0, reverse=True)
    return {"entries": entries[:HISTORY_LIMIT], "total": len(entries), "counts": totals,
            "savedBytes": saved, "originalBytes": before}


# ── Paths ──────────────────────────────────────────────────────────────────

def allowed_path(path):
    """The real path if it's an existing video file under one of ROOTS, else raises."""
    if not isinstance(path, str) or not path.startswith("/"):
        raise JobError("path must be absolute")
    real = os.path.realpath(path)
    if not any(real == r or real.startswith(r + os.sep) for r in ROOTS):
        raise JobError(f"{path} is outside {', '.join(ROOTS)}")
    if os.path.splitext(real)[1].lower() not in VIDEO_EXTS:
        raise JobError(f"{os.path.basename(path)} isn't a video file")
    if not os.path.isfile(real):
        raise JobError(f"{path} doesn't exist")
    return real


# ── Media probing ──────────────────────────────────────────────────────────

def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
        capture_output=True, text=True, timeout=120,
    )
    if out.returncode != 0:
        raise JobError(f"ffprobe failed: {out.stderr.strip()[-300:]}")
    data = json.loads(out.stdout)
    streams = data.get("streams", [])
    return {
        "duration": float(data.get("format", {}).get("duration") or 0),
        "video": [s for s in streams if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")],
        "audio": [s for s in streams if s.get("codec_type") == "audio"],
        "subs": [s for s in streams if s.get("codec_type") == "subtitle"],
        "attachments": [s for s in streams if s.get("codec_type") == "attachment"],
    }


# ── Steps ──────────────────────────────────────────────────────────────────

def copy_with_progress(job, src, dst, phase):
    total = os.path.getsize(src) or 1
    done = 0
    last = 0
    flag = cancel_flags[job["id"]]
    update(job, status=phase, progress=0.0, speed=None, eta=None)
    started = now()
    with open(src, "rb") as fi, open(dst, "wb") as fo:
        while True:
            if flag.is_set():
                raise Cancelled()
            buf = fi.read(CHUNK)
            if not buf:
                break
            fo.write(buf)
            done += len(buf)
            if now() - last > 1:
                last = now()
                rate = done / max(last - started, 0.001)
                update(job, progress=done / total, speed=f"{rate / 1024**2:.0f} MB/s",
                       eta=int((total - done) / rate) if rate else None)
        fo.flush()
        os.fsync(fo.fileno())
    if os.path.getsize(dst) != os.path.getsize(src):
        raise JobError(f"Copy to {dst} came out the wrong size")


def encode(job, src, dst, info, src_ext):
    video = info["video"][0]
    cmd = [
        "ffmpeg", "-nostdin", "-hide_banner", "-y", "-i", src,
        # The main video stream by index (skips embedded cover art), every audio
        # and subtitle track, and fonts that styled subtitles need.
        "-map", f"0:{video['index']}", "-map", "0:a?", "-map", "0:s?", "-map", "0:t?",
        "-c:v", "hevc_nvenc", "-rc", "vbr", "-cq", str(job["cq"]), "-preset", "p4",
    ]
    if "10" in (video.get("pix_fmt") or "") or video.get("bits_per_raw_sample") == "10":
        cmd += ["-profile:v", "main10", "-pix_fmt", "p010le"]
    cmd += ["-c:a", "copy", "-c:t", "copy"]
    cmd += ["-c:s", "srt"] if src_ext in MP4ISH and info["subs"] else ["-c:s", "copy"]
    cmd += ["-max_muxing_queue_size", "9999", "-progress", "pipe:1", "-nostats", dst]

    update(job, status="encoding", progress=0.0, speed=None, eta=None)
    log_path = os.path.join(os.path.dirname(dst), "ffmpeg.log")
    with open(log_path, "w") as log:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=log, text=True)
        current_proc[job["id"]] = proc
        duration = info["duration"] or 1
        stats = {}
        last = 0
        try:
            for line in proc.stdout:
                key, _, value = line.strip().partition("=")
                stats[key] = value
                if key == "progress" and now() - last > 1:
                    last = now()
                    out_us = int(stats.get("out_time_us") or stats.get("out_time_ms") or 0)
                    pos = max(out_us / 1e6, 0)
                    speed = stats.get("speed", "").strip()
                    try:
                        x = float(speed.rstrip("x"))
                    except ValueError:
                        x = 0
                    update(job, progress=min(pos / duration, 1.0), speed=speed or None,
                           eta=int((duration - pos) / x) if x > 0 else None)
            proc.wait()
        finally:
            current_proc.pop(job["id"], None)
    if cancel_flags[job["id"]].is_set():
        raise Cancelled()
    if proc.returncode != 0:
        with open(log_path, errors="replace") as log:
            tail = log.read()[-600:]
        raise JobError(f"ffmpeg exited {proc.returncode}: {tail.strip().splitlines()[-1] if tail.strip() else ''}")


def verify(job, src_info, out_path, orig_size):
    update(job, status="verifying", progress=None, speed=None, eta=None)
    out = probe(out_path)
    if not out["video"] or out["video"][0].get("codec_name") != "hevc":
        raise JobError("Output has no HEVC video stream")
    src_dur, out_dur = src_info["duration"], out["duration"]
    if src_dur and abs(out_dur - src_dur) > max(2.0, src_dur * 0.01):
        raise JobError(f"Output runs {out_dur:.0f}s, source {src_dur:.0f}s")
    if len(out["audio"]) != len(src_info["audio"]):
        raise JobError(f"Output has {len(out['audio'])} audio tracks, source {len(src_info['audio'])}")
    if len(out["subs"]) != len(src_info["subs"]):
        raise JobError(f"Output has {len(out['subs'])} subtitle tracks, source {len(src_info['subs'])}")
    new_size = os.path.getsize(out_path)
    if new_size < 1024 * 1024:
        raise JobError("Output is suspiciously small")
    return new_size


def replace(job, src, out_path, src_stat):
    # The file the job was queued for has to still be the same file.
    st = os.stat(src)
    if st.st_size != src_stat.st_size or st.st_mtime != src_stat.st_mtime:
        raise JobError("The original changed on disk while encoding; left it alone")
    folder = os.path.dirname(src)
    final = os.path.splitext(src)[0] + ".mkv"
    if final != src and os.path.exists(final):
        raise JobError(f"{os.path.basename(final)} already exists next to the original")
    tmp = os.path.join(folder, f".{os.path.basename(final)}.mediaops-{job['id'][:8]}.tmp")
    try:
        copy_with_progress(job, out_path, tmp, "replacing")
        os.chmod(tmp, st.st_mode & 0o777)
        update(job, progress=None, speed=None, eta=None)
        os.replace(tmp, final)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    if final != src:
        os.remove(src)
    return final


def run(job):
    jid = job["id"]
    scratch = os.path.join(WORK, jid)
    os.makedirs(scratch, exist_ok=True)
    try:
        src = allowed_path(job["path"])
        src_stat = os.stat(src)
        orig_size = src_stat.st_size
        ext = os.path.splitext(src)[1].lower()
        update(job, origSize=orig_size, started=now())

        free = shutil.disk_usage(WORK).free
        need = orig_size * 2 + HEADROOM
        if free < need:
            raise JobError(f"Not enough space in {WORK}: {free / 1024**3:.0f} GB free, needs {need / 1024**3:.0f} GB")

        work_src = os.path.join(scratch, "src" + ext)
        work_out = os.path.join(scratch, "out.mkv")
        copy_with_progress(job, src, work_src, "copying")

        info = probe(work_src)
        if not info["video"]:
            raise JobError("No video stream found")
        encode(job, work_src, work_out, info, ext)
        new_size = verify(job, info, work_out, orig_size)

        if new_size > orig_size * (1 - MIN_SAVING):
            why = (f"Came out larger ({orig_size / 1024**3:.1f} → {new_size / 1024**3:.1f} GB)" if new_size >= orig_size
                   else f"Only {100 * (1 - new_size / orig_size):.0f}% smaller")
            update(job, status="skipped", newSize=new_size, progress=None, speed=None, eta=None, finished=now(),
                   error=f"{why}; kept the original")
            return

        final = replace(job, src, work_out, src_stat)
        update(job, status="done", newSize=new_size, outPath=final, progress=1.0, speed=None, eta=None, finished=now())
    except Cancelled:
        update(job, status="cancelled", progress=None, speed=None, eta=None, finished=now())
    except Exception as e:
        update(job, status="failed", error=str(e)[:500], progress=None, speed=None, eta=None, finished=now())
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
        cancel_flags.pop(jid, None)
        record_history(job)
        with lock:
            prune()
            save_state()


def worker():
    while True:
        with lock:
            queued = sorted((j for j in jobs.values() if j["status"] == "queued"), key=lambda j: j["created"])
            job = queued[0] if queued else None
            if job:
                cancel_flags.setdefault(job["id"], threading.Event())
                job["status"] = "copying"
                save_state()
        if job:
            run(job)
        else:
            wake.wait(30)
            wake.clear()


# ── HTTP ───────────────────────────────────────────────────────────────────

def public(job):
    return dict(job)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        got = self.headers.get("Authorization", "")
        ok = bool(TOKEN) and hmac.compare_digest(got.encode(), f"Bearer {TOKEN}".encode())
        if not ok:
            self.send(401, {"error": "unauthorized"})
        return ok

    def body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 64 * 1024:
            raise JobError("body too large")
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        if not self.authorized():
            return
        path = urlsplit(self.path).path
        if path == "/jobs":
            with lock:
                listing = sorted((public(j) for j in jobs.values()), key=lambda j: j["created"], reverse=True)
            disk = shutil.disk_usage(WORK)
            return self.send(200, {"jobs": listing, "workDir": WORK, "workFree": disk.free, "roots": ROOTS})
        if path == "/history":
            return self.send(200, read_history())
        self.send(404, {"error": "not found"})

    def do_POST(self):
        if not self.authorized():
            return
        path = urlsplit(self.path).path
        try:
            if path == "/jobs":
                return self.create(self.body())
            m = re.fullmatch(r"/jobs/([0-9a-f-]{36})/(cancel|ack)", path)
            if m:
                return self.act(m.group(1), m.group(2))
        except JobError as e:
            return self.send(400, {"error": str(e)})
        except (ValueError, json.JSONDecodeError):
            return self.send(400, {"error": "bad request"})
        self.send(404, {"error": "not found"})

    def do_DELETE(self):
        if not self.authorized():
            return
        m = re.fullmatch(r"/jobs/([0-9a-f-]{36})", urlsplit(self.path).path)
        if not m:
            return self.send(404, {"error": "not found"})
        with lock:
            job = jobs.get(m.group(1))
            if not job:
                return self.send(404, {"error": "no such job"})
            if job["status"] not in FINISHED:
                return self.send(409, {"error": "cancel it first"})
            jobs.pop(job["id"])
            save_state()
        self.send(200, {"ok": True})

    def create(self, b):
        real = allowed_path(b.get("path"))
        cq = int(b.get("cq", 24))
        if not CQ_RANGE[0] <= cq <= CQ_RANGE[1]:
            raise JobError(f"cq must be between {CQ_RANGE[0]} and {CQ_RANGE[1]}")
        meta = b.get("meta") if isinstance(b.get("meta"), dict) else {}
        with lock:
            for j in jobs.values():
                if j["path"] == real and j["status"] not in FINISHED:
                    return self.send(200, public(j))
            job = {
                "id": str(uuid.uuid4()), "path": real, "label": str(b.get("label") or os.path.basename(real))[:200],
                "cq": cq, "meta": meta, "status": "queued", "created": now(), "started": None, "finished": None,
                "progress": None, "speed": None, "eta": None, "error": None,
                "origSize": os.path.getsize(real), "newSize": None, "outPath": None, "acked": False,
            }
            jobs[job["id"]] = job
            save_state()
        wake.set()
        self.send(201, public(job))

    def act(self, jid, action):
        with lock:
            job = jobs.get(jid)
            if not job:
                return self.send(404, {"error": "no such job"})
            if action == "ack":
                job["acked"] = True
            elif job["status"] == "queued":
                job.update(status="cancelled", finished=now())
            elif job["status"] in ACTIVE:
                # "replacing" is the copy back and the rename; cancelling there
                # removes the temp copy and leaves the original in place.
                cancel_flags.setdefault(jid, threading.Event()).set()
                proc = current_proc.get(jid)
                if proc:
                    proc.terminate()
            save_state()
            self.send(200, public(job))


if __name__ == "__main__":
    if not TOKEN:
        sys.exit("Set ENCODE_SIDECAR_TOKEN")
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        sys.exit("ffmpeg and ffprobe must be on the PATH")
    os.makedirs(WORK, exist_ok=True)
    # Scratch folders left by a crash.
    for name in os.listdir(WORK):
        p = os.path.join(WORK, name)
        if os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)
    load_state()
    save_state()
    threading.Thread(target=worker, daemon=True).start()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8768
    print(f"encode sidecar on :{port}, roots {ROOTS}, work {WORK}")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
