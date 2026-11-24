"""Local-only group discovery and calibration used by the desktop wizard."""
from __future__ import annotations

import csv
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from project_core import ROOT, project_path

CONFIG_REL = 'state/agent-config.json'
QQ_NAMES = ['QQ.exe']
WECHAT_NAMES = ['WeChat.exe', 'Weixin.exe']
SKIP_DIRS = {'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData',
             '$Recycle.Bin', 'System Volume Information', 'AppData', 'node_modules',
             '.git', 'venv', '.venv'}


def _run(args: list[str], payload: dict | None = None, timeout: float = 180.0) -> dict:
    command = [sys.executable, '-B', '-X', 'utf8', str(ROOT / 'agent_setup.py'), *args]
    result = subprocess.run(
        command, cwd=str(ROOT), capture_output=True, encoding='utf-8',
        errors='replace', timeout=timeout,
        input=json.dumps(payload, ensure_ascii=False) if payload is not None else None,
        env=dict(os.environ, PYTHONIOENCODING='utf-8'),
    )
    try:
        data = json.loads(result.stdout)
    except ValueError:
        raise RuntimeError('agent_setup 返回了无法解析的结果')
    if result.returncode != 0 or not data.get('ok'):
        error = data.get('error') or {}
        raise RuntimeError(error.get('message') or '配置命令执行失败')
    return data.get('data') or {}


def _config() -> dict:
    path = project_path(CONFIG_REL)
    if not path.is_file():
        return {'revision': 0, 'sources': {}, 'groups': {}}
    return json.loads(path.read_text(encoding='utf-8'))


def _pids(names: list[str]) -> list[int]:
    found = []
    for name in names:
        try:
            result = subprocess.run(
                ['tasklist', '/FI', f'IMAGENAME eq {name}', '/FO', 'CSV', '/NH'],
                capture_output=True, text=True, encoding='utf-8', errors='replace',
                timeout=20, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        except (OSError, subprocess.TimeoutExpired):
            continue
        for row in csv.reader(io.StringIO(result.stdout)):
            if len(row) >= 2 and row[1].strip().isdigit():
                found.append(int(row[1]))
    return sorted(set(found))


def _wechat_candidates() -> list[dict]:
    bases = set()
    home = Path.home()
    for known in (home / 'Documents' / 'xwechat_files',
                  home / 'Documents' / 'WeChat Files'):
        if known.is_dir():
            bases.add(known)
    deadline = time.monotonic() + 6
    for letter in 'CDEFGHIJKLMNOPQRSTUVWXYZ':
        root = Path(f'{letter}:/')
        if not root.exists():
            continue
        for current, dirs, _files in os.walk(root):
            if time.monotonic() > deadline:
                break
            try:
                depth = len(Path(current).relative_to(root).parts)
            except ValueError:
                depth = 99
            dirs[:] = [name for name in dirs
                       if name not in SKIP_DIRS and not name.startswith('.')]
            if depth >= 3:
                dirs[:] = []
            if Path(current).name == 'xwechat_files':
                bases.add(Path(current))
                dirs[:] = []
    results = []
    for base in sorted(bases):
        for account in sorted(base.glob('*')):
            db = account / 'db_storage'
            if not db.is_dir():
                continue
            messages = db / 'message'
            if not messages.is_dir() or not list(messages.glob('message_*.db')):
                continue
            results.append({
                'paths': {'account_dir': str(account), 'database_dir': str(db)},
                'validated': False,
            })
    def modified(item):
        try:
            return (Path(item['paths']['database_dir']) / 'message' / 'message_0.db').stat().st_mtime
        except OSError:
            return 0
    results.sort(key=modified, reverse=True)
    return results


def status() -> dict:
    config = _config()
    groups = config.get('groups') or {}
    return {
        'configured_groups': sum(1 for group in groups.values() if group.get('enabled')),
        'total_groups': len(groups),
        'sources': len(config.get('sources') or {}),
        'revision': config.get('revision', 0),
    }


def scan() -> dict:
    qq_candidates = []
    try:
        qq_candidates = _run(['source', 'candidates', '--platform', 'qq']).get('candidates', [])
    except RuntimeError:
        pass
    wechat = _wechat_candidates()
    try:
        for item in _run(['source', 'candidates', '--platform', 'wechat']).get('candidates', []):
            if item.get('paths') not in [entry.get('paths') for entry in wechat]:
                wechat.append(item)
    except RuntimeError:
        pass
    config = _config()
    sources = [{'id': key, 'platform': item.get('platform'), 'name': item.get('name'),
                'paths': item.get('paths', {})}
               for key, item in (config.get('sources') or {}).items()]
    groups = config.get('groups') or {}
    return {
        'sources': sources,
        'candidates': {'qq': qq_candidates, 'wechat': wechat},
        'processes': {'qq': _pids(QQ_NAMES), 'wechat': _pids(WECHAT_NAMES)},
        'configured_groups': sum(1 for group in groups.values() if group.get('enabled')),
        'total_groups': len(groups),
        'revision': config.get('revision', 0),
    }


def _source_for(platform: str, config: dict) -> dict | None:
    for source in (config.get('sources') or {}).values():
        if source.get('platform') == platform:
            return source
    return None


def _check(source_id: str) -> str:
    try:
        data = _run(['source', 'check', '--source', source_id])
        return str(data.get('status') or '')
    except RuntimeError:
        return ''


def _connect(source_id: str, pids: list[int]) -> None:
    def attempt(subset: list[int]) -> None:
        args = ['source', 'connect', '--source', source_id]
        for pid in subset:
            args.extend(['--pid', str(pid)])
        args.append('--authorize-memory-read')
        _run(args, timeout=300)

    try:
        attempt(pids)
        return
    except RuntimeError as first_error:
        last_error = first_error
    for pid in pids:
        try:
            attempt([pid])
            return
        except RuntimeError as error:
            last_error = error
    raise last_error


def _configure_source(platform: str, wanted: dict, config: dict) -> str:
    payload = {'expected_revision': config.get('revision', 0),
               'confirmed': True, 'platform': platform,
               'name': '我的QQ' if platform == 'qq' else '我的微信',
               'paths': wanted}
    data = _run(['source', 'configure', '--input', '-'], payload)
    source = data.get('source') or {}
    source_id = source.get('id')
    if not source_id:
        raise RuntimeError('来源配置未返回来源 ID')
    return source_id


def _ensure_ready(platform: str, source_id: str) -> None:
    status = _check(source_id)
    if status == 'ready':
        return
    pids = _pids(QQ_NAMES if platform == 'qq' else WECHAT_NAMES)
    if not pids:
        raise RuntimeError('未检测到已登录的客户端进程，请打开并登录后重试')
    _connect(source_id, pids)
    if _check(source_id) != 'ready':
        raise RuntimeError('凭据仍未就绪，请确认客户端已登录且与 ChatNotice 权限一致')


def _wanted_paths(platform: str, supplied: dict, source: dict | None) -> dict:
    if not supplied and source:
        supplied = source.get('paths') or {}
    if platform == 'qq':
        if not supplied:
            candidates = _run(['source', 'candidates', '--platform', 'qq']).get('candidates', [])
            if not candidates:
                raise RuntimeError('没有找到 QQ 数据目录，请先登录 QQ 客户端')
            supplied = candidates[0].get('paths') or {}
        return {'database_dir': supplied.get('database_dir', ''),
                'media_dir': supplied.get('media_dir', '')}
    if not supplied:
        candidates = _wechat_candidates()
        if not candidates:
            raise RuntimeError('没有找到微信数据目录，请选择 xwechat_files 下的账号文件夹')
        supplied = candidates[0].get('paths') or {}
    return {'account_dir': supplied.get('account_dir', ''),
            'database_dir': supplied.get('database_dir', '')}


def authorize(platforms: list[str], paths: dict, confirmed: bool) -> dict:
    if not confirmed:
        raise ValueError('需要明确同意读取本机客户端凭据')
    out = {}
    for platform in ('qq', 'wechat'):
        if platform not in platforms:
            continue
        errors = []
        try:
            config = _config()
            source = _source_for(platform, config)
            supplied = (paths or {}).get(platform) or {}
            wanted = _wanted_paths(platform, supplied, source)
            selected = None
            if source and all((source.get('paths') or {}).get(key) == value
                              for key, value in wanted.items() if value):
                try:
                    _ensure_ready(platform, source['id'])
                    selected = source['id']
                except RuntimeError as error:
                    errors.append(str(error))
            if selected is None:
                try:
                    source_id = _configure_source(platform, wanted, _config())
                    _ensure_ready(platform, source_id)
                    selected = source_id
                except RuntimeError as error:
                    errors.append(str(error))
            if selected is None and platform == 'wechat':
                tried = {wanted.get('account_dir')}
                for candidate in _wechat_candidates():
                    candidate_paths = candidate.get('paths') or {}
                    if candidate_paths.get('account_dir') in tried:
                        continue
                    tried.add(candidate_paths.get('account_dir'))
                    try:
                        source_id = _configure_source(platform, candidate_paths, _config())
                        _ensure_ready(platform, source_id)
                        selected = source_id
                        break
                    except RuntimeError as error:
                        errors.append(str(error))
            if selected is None:
                raise RuntimeError(errors[-1] if errors else '无法读取聊天数据库')
            out[platform] = {'ok': True, 'source_id': selected}
        except (RuntimeError, ValueError) as error:
            out[platform] = {'ok': False, 'error': str(error)}
    return out

def list_groups(source_id: str) -> list[dict]:
    groups = []
    offset = 0
    while True:
        data = _run(['groups', 'list', '--source', source_id,
                     '--offset', str(offset), '--limit', '200'], timeout=300)
        groups.extend(data.get('groups') or [])
        next_offset = data.get('next_offset')
        if next_offset is None:
            break
        offset = int(next_offset)
    config = _config()
    configured = config.get('groups') or {}
    result = []
    for group in groups:
        key = f"{source_id}/{group.get('group_id')}"
        current = configured.get(key) or {}
        result.append({
            'source_id': source_id,
            'group_id': str(group.get('group_id')),
            'name': group.get('name') or str(group.get('group_id')),
            'platform': group.get('platform'),
            'configured': bool(current),
            'enabled': bool(current.get('enabled')),
        })
    result.sort(key=lambda item: (item['platform'], item['name']))
    return result


def save_groups(updates: list[dict]) -> dict:
    config = _config()
    configured = config.get('groups') or {}
    rows = []
    for update in updates:
        source_id = str(update.get('source_id') or '')
        group_id = str(update.get('group_id') or '')
        if not source_id or not group_id:
            continue
        key = f'{source_id}/{group_id}'
        existing = configured.get(key)
        enabled = bool(update.get('enabled'))
        if not existing and not enabled:
            continue
        rows.append({'source_id': source_id, 'group_id': group_id,
                     'name': update.get('name') or (existing or {}).get('name') or group_id,
                     'enabled': enabled})
    if not rows:
        return {'saved': 0, 'revision': config.get('revision', 0)}
    for index in range(0, len(rows), 100):
        chunk = rows[index:index + 100]
        revision = _config().get('revision', 0)
        _run(['groups', 'apply', '--input', '-'],
             {'expected_revision': revision, 'confirmed': True, 'groups': chunk},
             timeout=120)
    return {'saved': len(rows), 'revision': _config().get('revision', 0)}


def normalize_wechat_folder(folder: str) -> dict:
    path = Path(folder)
    if not path.exists():
        raise ValueError('文件夹不存在')
    if path.name == 'db_storage' and (path / 'message').is_dir():
        return {'account_dir': str(path.parent), 'database_dir': str(path)}
    if (path / 'db_storage' / 'message').is_dir():
        return {'account_dir': str(path), 'database_dir': str(path / 'db_storage')}
    if (path / 'xwechat_files').is_dir():
        path = path / 'xwechat_files'
    if path.name == 'xwechat_files':
        accounts = [child for child in path.glob('*')
                    if (child / 'db_storage' / 'message').is_dir()]
        if len(accounts) == 1:
            account = accounts[0]
            return {'account_dir': str(account),
                    'database_dir': str(account / 'db_storage')}
        raise ValueError('请选择 xwechat_files 下的具体账号文件夹')
    raise ValueError('请选择包含 db_storage 的微信账号文件夹')


def pick_wechat_folder() -> dict:
    script = (
        'Add-Type -AssemblyName System.Windows.Forms;'
        '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;'
        '$dialog.Description = "选择微信账号文件夹（包含 db_storage）";'
        '$dialog.ShowNewFolderButton = $false;'
        'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) '
        '{ [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
        'Write-Output $dialog.SelectedPath }'
    )
    result = subprocess.run(
        ['powershell', '-NoProfile', '-STA', '-Command', script],
        capture_output=True, text=True, encoding='utf-8', errors='replace',
        timeout=180, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    folder = (result.stdout or '').strip()
    if not folder:
        raise ValueError('未选择文件夹')
    return normalize_wechat_folder(folder)