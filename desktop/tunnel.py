"""Cloudflare quick-tunnel lifecycle for optional public pairing."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import time
import urllib.request

from project_core import ROOT, project_path

STATE_REL = 'state/remote-access.json'
BINARY_REL = 'state/tools/cloudflared.exe'
VERSION = '2026.11.1'
DOWNLOAD_URL = ('https://github.com/cloudflare/cloudflared/releases/download/'
                f'{VERSION}/cloudflared-windows-amd64.exe')
SHA256 = '341deda3db5ec498a0482254d6c38c0b7cf01a30c37bb5dd95d2216d08955e35'
URL_RE = re.compile(r'https://[a-z0-9-]+\.trycloudflare\.com')


def load_enabled() -> bool:
    path = project_path(STATE_REL)
    try:
        return bool(json.loads(path.read_text(encoding='utf-8')).get('enabled'))
    except (OSError, ValueError):
        return False


def save_enabled(enabled: bool) -> None:
    path = project_path(STATE_REL)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.tmp')
    temp.write_text(json.dumps({'enabled': bool(enabled)}, ensure_ascii=False) + '\n',
                    encoding='utf-8')
    os.replace(temp, path)


def parse_public_url(text: str) -> str | None:
    match = URL_RE.search(text or '')
    return match.group(0) if match else None


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_binary(path: Path | None = None) -> Path:
    target = path or project_path(BINARY_REL)
    if target.is_file() and target.stat().st_size > 1_000_000:
        if not SHA256 or _sha256(target) == SHA256:
            return target
        target.unlink()
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(target.name + '.part')
    request = urllib.request.Request(DOWNLOAD_URL, headers={'User-Agent': 'ChatNotice'})
    with urllib.request.urlopen(request, timeout=120) as response, temp.open('wb') as output:
        while True:
            chunk = response.read(1024 * 256)
            if not chunk:
                break
            output.write(chunk)
    digest = _sha256(temp)
    if SHA256 and digest != SHA256:
        temp.unlink(missing_ok=True)
        raise RuntimeError('cloudflared 校验失败')
    os.replace(temp, target)
    return target


class TunnelManager:
    def __init__(self):
        self._lock = threading.RLock()
        self._proc: subprocess.Popen | None = None
        self._reader: threading.Thread | None = None
        self._port: int | None = None
        self._stopping = False
        self._state = 'disabled'
        self._url: str | None = None
        self._error: str | None = None
        self._retry = 0

    def configure(self, port: int) -> None:
        self._port = port

    def set_enabled(self, enabled: bool) -> None:
        save_enabled(enabled)
        if enabled:
            self.start()
        else:
            self.stop()

    def status(self) -> dict:
        with self._lock:
            return {'enabled': load_enabled(), 'state': self._state,
                    'url': self._url, 'error': self._error,
                    'version': VERSION}

    def start(self) -> None:
        with self._lock:
            if not load_enabled():
                self._state = 'disabled'
                return
            if self._proc and self._proc.poll() is None:
                return
            if self._port is None:
                self._error = '端口尚未就绪'
                self._state = 'error'
                return
            self._stopping = False
        threading.Thread(target=self._start_worker, name='cloudflared-start',
                         daemon=True).start()

    def _start_worker(self) -> None:
        with self._lock:
            self._state = 'downloading'
            self._error = None
        try:
            binary = ensure_binary()
        except Exception as error:
            if not load_enabled():
                with self._lock:
                    self._state = 'disabled'
                return
            with self._lock:
                self._state = 'error'
                self._error = f'下载 cloudflared 失败：{error}'
            return
        with self._lock:
            if self._stopping or not load_enabled() or self._port is None:
                self._state = 'disabled'
                return
            self._state = 'starting'
        try:
            self._spawn(binary)
        except Exception as error:
            with self._lock:
                self._state = 'error'
                self._error = f'cloudflared 启动失败：{error}'

    def _spawn(self, binary: Path) -> None:
        command = [str(binary), 'tunnel', '--url',
                   f'http://127.0.0.1:{self._port}', '--no-autoupdate']
        try:
            proc = subprocess.Popen(
                command, cwd=str(ROOT), stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE, text=True, encoding='utf-8',
                errors='replace', bufsize=1,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            )
        except OSError as error:
            with self._lock:
                self._state = 'error'
                self._error = f'cloudflared 启动失败：{error}'
            self._schedule_restart()
            return
        with self._lock:
            self._proc = proc
            self._url = None
        self._reader = threading.Thread(target=self._read_output, args=(proc,),
                                        name='cloudflared-log', daemon=True)
        self._reader.start()

    def _read_output(self, proc: subprocess.Popen) -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            url = parse_public_url(line)
            if url:
                with self._lock:
                    self._url = url
                    self._state = 'ready'
                    self._error = None
                    self._retry = 0
        code = proc.wait()
        with self._lock:
            self._proc = None
            if self._stopping or not load_enabled():
                self._state = 'disabled'
                return
            self._state = 'error'
            self._error = f'cloudflared 已退出（{code}）'
        self._schedule_restart()

    def _schedule_restart(self) -> None:
        with self._lock:
            if self._stopping or not load_enabled():
                return
            delay = (5, 15, 60)[min(self._retry, 2)]
            self._retry += 1
        threading.Timer(delay, self.start).start()

    def stop(self) -> None:
        with self._lock:
            self._stopping = True
            proc = self._proc
            self._proc = None
            self._state = 'disabled'
            self._url = None
            self._error = None
        if proc and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    proc.kill()
                except OSError:
                    pass


tunnel = TunnelManager()