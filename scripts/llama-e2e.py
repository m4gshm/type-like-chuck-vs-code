#!/usr/bin/env python3
"""E2E tests for the llama.cpp engine used by the plugin, in the spirit of the
openvino backend's e2e suite: download the release build and a small GGUF, run
llama-server and exercise the OpenAI-compat surface the extension relies on.

Usage:
  python3 scripts/llama-e2e.py download-distro [--tag b12499] [--out DIR]
  python3 scripts/llama-e2e.py download-model [--out FILE]
  python3 scripts/llama-e2e.py smoke [--distro DIR]
  python3 scripts/llama-e2e.py test [--distro DIR] [--model FILE]
"""

import argparse
import json
import os
import platform
import socket
import subprocess
import sys
import tarfile
import time
import urllib.request
import zipfile

CACHE = os.path.join(os.path.dirname(__file__), "..", ".cache")
DEFAULT_TAG = "b12499"
DEFAULT_MODEL = os.path.join(CACHE, "models", "qwen2.5-coder-0.5b-q4_k_m.gguf")
MODEL_URL = ("https://huggingface.co/bartowski/Qwen2.5-Coder-0.5B-Instruct-GGUF"
             "/resolve/main/Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf")
FIM = "<|fim_prefix|>def add(a, b):\n    <|fim_suffix|>\n    <|fim_middle|>"
RESERVED = ("<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>", "<|fim_pad|>")


def fail(msg):
    raise SystemExit(f"llama-e2e: {msg}")


def release_asset_name(tag):
    plat = {"win32": "win-vulkan", "linux": "ubuntu-vulkan", "darwin": "macos"}.get(sys.platform)
    if plat is None:
        fail(f"no llama.cpp release asset for {sys.platform}")
    machine = platform.machine().lower()
    arch = "x64" if machine in ("amd64", "x86_64") else "arm64"
    if plat == "win-vulkan":
        return f"llama-{tag}-bin-{plat}-{arch}.zip"
    return f"llama-{tag}-bin-{plat}-{arch}.tar.gz"


def distro_dir(tag=DEFAULT_TAG, out=None):
    return out or os.path.join(CACHE, "llama", tag)


def find_server(distro):
    for root, _, files in os.walk(distro):
        for name in ("llama-server.exe", "llama-server"):
            if name in files:
                return os.path.join(root, name)
    fail(f"llama-server not found under {distro} (run download-distro first)")


def download(url, dest, min_size=1_000_000):
    print(f"downloading {url}")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".part"
    urllib.request.urlretrieve(url, tmp)
    if os.path.getsize(tmp) < min_size:
        fail(f"downloaded file is too small: {dest}")
    os.replace(tmp, dest)


def cmd_download_distro(args):
    dest = distro_dir(args.tag, args.out)
    if os.path.isfile(find_server(dest) if os.path.isdir(dest) else ""):
        print(f"distro already present: {dest}")
        return
    asset = release_asset_name(args.tag)
    archive = os.path.join(dest, asset)
    download(f"https://github.com/ggml-org/llama.cpp/releases/download/{args.tag}/{asset}", archive)
    if archive.endswith(".zip"):
        with zipfile.ZipFile(archive) as z:
            z.extractall(dest)
        os.remove(archive)
    else:
        with tarfile.open(archive) as t:
            t.extractall(dest)
        os.remove(archive)
    print(f"distro unpacked into {dest}")


def cmd_download_model(args):
    out = args.out or DEFAULT_MODEL
    if os.path.isfile(out) and os.path.getsize(out) > 100_000_000:
        print(f"model already present: {out}")
        return
    download(MODEL_URL, out, min_size=100_000_000)
    print(f"model saved: {out}")


def cmd_smoke(args):
    out = subprocess.run([find_server(distro_dir(args.tag, args.distro)), "--version"],
                         capture_output=True, text=True, timeout=30)
    print(out.stdout.strip() or out.stderr.strip())
    if out.returncode != 0:
        fail("llama-server --version failed")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def check(cond, name):
    print(("PASS " if cond else "FAIL ") + name)
    return cond


def wait_health(port, timeout=120):
    url = f"http://127.0.0.1:{port}/health"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=5) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(1)
    return False


def complete(port, body, timeout=120):
    req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/completions",
                                 data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def cmd_test(args):
    ok = True
    server = find_server(distro_dir(args.tag, args.distro))
    out = subprocess.run([server, "--version"], capture_output=True, text=True, timeout=30)
    ok &= check(out.returncode == 0, "llama-server --version")
    print(out.stdout.strip() or out.stderr.strip())
    if not args.model or not os.path.isfile(args.model):
        print(f"model tests skipped ({args.model or 'no --model'} does not exist)")
        return ok

    port = free_port()
    proc = subprocess.Popen([server, "-m", args.model, "--port", str(port),
                             "--host", "127.0.0.1"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ok &= check(wait_health(port), "server reaches /health")
        r = complete(port, {"prompt": FIM, "max_tokens": 32})
        text = r["choices"][0]["text"]
        ok &= check(len(text) > 0, "FIM generation returns text")
        ok &= check(not any(t in text for t in RESERVED), "no FIM control tokens leak")
        r = complete(port, {"prompt": FIM, "max_tokens": 4})
        ok &= check(r["choices"][0]["finish_reason"] == "length", "max_tokens gives finish_reason=length")
        r = complete(port, {"prompt": FIM, "max_tokens": 64, "stop": ["\n"]})
        ok &= check("\n" not in r["choices"][0]["text"], "stop string truncates the completion")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
    print(f"\n{'ALL PASSED' if ok else 'FAILURES'}")
    return ok


def main():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--tag", default=DEFAULT_TAG, help="llama.cpp release tag")
    common.add_argument("--distro", help="existing distro dir (default .cache/llama/<tag>)")
    common.add_argument("--model", help="GGUF model file (default the cached Qwen2.5-Coder 0.5B)")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    cmd = ap.add_subparsers(dest="cmd", required=True)
    cmd.add_parser("download-distro", parents=[common]).add_argument("--out")
    cmd.add_parser("download-model", parents=[common]).add_argument("--out")
    cmd.add_parser("smoke", parents=[common])
    cmd.add_parser("test", parents=[common])
    args = ap.parse_args()
    if args.cmd == "download-distro":
        cmd_download_distro(args)
    elif args.cmd == "download-model":
        cmd_download_model(args)
    elif args.cmd == "smoke":
        cmd_smoke(args)
    else:
        sys.exit(0 if cmd_test(args) else 1)


if __name__ == "__main__":
    main()
