"""Local HTTP service for the ChatNotice desktop app.

Loopback-only in this phase; the mobile client will reuse the same API
over the pairing channel added later.
"""
from __future__ import annotations

import base64
import io
import ipaddress
import json
import re
import secrets
import socket
import subprocess
import threading
import time
import uuid
from collections import defaultdict, deque
from datetime import datetime
from pathlib import Path

import qrcode
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from project_core import project_path
from todo_store import TodoStore

from . import automation, manual_sync, setup_groups
from .scheduler import scheduler
from .tunnel import tunnel

APP_VERSION = '2.1.4-dev'
UI_DIR = Path(__file__).resolve().parent / 'ui'
VIRTUAL_NETWORKS = [ipaddress.ip_network('198.18.0.0/15')]
RATE_LIMIT = 120
AUTH_FAILURE_LIMIT = 10
_RATE_LOCK = threading.Lock()
_RATE_WINDOWS: dict[tuple[str, str], deque] = defaultdict(deque)
_SYNC_LOCK = threading.Lock()


def _client_ip(request: Request) -> str:
    forwarded = (request.headers.get('cf-connecting-ip')
                 or request.headers.get('x-forwarded-for') or '')
    if forwarded:
        return forwarded.split(',')[0].strip()
    return request.client.host if request.client else 'unknown'


def _rate_hit(ip: str, kind: str, limit: int) -> bool:
    now = time.monotonic()
    with _RATE_LOCK:
        window = _RATE_WINDOWS[(ip, kind)]
        while window and now - window[0] > 60:
            window.popleft()
        if len(window) >= limit:
            return False
        window.append(now)
        return True


def _store() -> TodoStore:
    return TodoStore()


def get_token() -> str:
    path = project_path('state/api-token.txt')
    if path.is_file():
        token = path.read_text(encoding='ascii').strip()
        if token:
            return token
    token = secrets.token_hex(24)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(token, encoding='ascii')
    return token


def _lan_addresses() -> list[str]:
    found = set()
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(('8.8.8.8', 80))
            found.add(probe.getsockname()[0])
        finally:
            probe.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.add(info[4][0])
    except OSError:
        pass
    usable = []
    for address in found:
        try:
            ip = ipaddress.ip_address(address)
        except ValueError:
            continue
        if not ip.is_private or ip.is_link_local or ip.is_loopback:
            continue
        if any(ip in network for network in VIRTUAL_NETWORKS):
            continue
        usable.append(address)
    return sorted(usable)


def _is_trusted_local(request: Request) -> bool:
    client = request.client.host if request.client else ''
    forwarded = (request.headers.get('cf-connecting-ip')
                 or request.headers.get('x-forwarded-for'))
    return client in ('127.0.0.1', '::1') and not forwarded


def _config_groups() -> dict:
    path = project_path('state/agent-config.json')
    if not path.is_file():
        return {'groups': [], 'sources': []}
    data = json.loads(path.read_text(encoding='utf-8'))
    sources = data.get('sources') or {}
    groups = []
    for key, item in (data.get('groups') or {}).items():
        source = sources.get(item.get('source_id'), {})
        groups.append({
            'key': key,
            'name': item.get('name') or item.get('group_id'),
            'group_id': item.get('group_id'),
            'platform': source.get('platform', ''),
            'source_name': source.get('name', ''),
            'enabled': bool(item.get('enabled')),
        })
    groups.sort(key=lambda g: (g['platform'], g['name']))
    return {'groups': groups}


class TaskCreate(BaseModel):
    title: str
    due: str | None = None
    due_label: str = ''
    note: str = ''
    optional: bool = False


class TaskPatch(BaseModel):
    changes: dict
    baseline: dict


class BoolValue(BaseModel):
    value: bool


class ClearCompleted(BaseModel):
    ids: list[str]


class TunnelToggle(BaseModel):
    enabled: bool


class SetupAuthorize(BaseModel):
    platforms: list[str]
    confirmed: bool = False
    paths: dict = {}


class GroupUpdate(BaseModel):
    source_id: str
    group_id: str
    name: str = ''
    enabled: bool = False


class GroupsSave(BaseModel):
    groups: list[GroupUpdate]


class FolderRequest(BaseModel):
    platform: str = 'wechat'


class SyncRead(BaseModel):
    group_keys: list[str] = []
    limit: int = 50
    since_days: int = 1


class SyncItem(BaseModel):
    message_key: str
    content_hash: str
    action: str = 'create'
    text: str = ''
    group: str = ''
    time: str = ''


class SyncCommit(BaseModel):
    batch_id: str
    items: list[SyncItem]
    mode: str = 'plain'


class AutomationSettings(BaseModel):
    window_start: str
    window_end: str
    check_interval_seconds: int
    min_read_interval_minutes: int
    model: str = 'deepseek-flash'
    daily_model_call_limit: int = 20
    read_platform: str = 'all'
    auto_start: bool = False
    enabled: bool = False
    privacy_confirmed: bool = False
    api_key: str | None = None
    clear_api_key: bool = False


def create_app() -> FastAPI:
    app = FastAPI(title='ChatNotice', version=APP_VERSION)

    @app.middleware('http')
    async def access_guard(request: Request, call_next):
        if _is_trusted_local(request):
            return await call_next(request)
        ip = _client_ip(request)
        if not _rate_hit(ip, 'all', RATE_LIMIT):
            return JSONResponse({'ok': False, 'error': 'rate_limited'},
                                status_code=429, headers={'Retry-After': '30'})
        if request.url.path.startswith('/api'):
            supplied = (request.headers.get('x-api-token')
                        or request.query_params.get('token')
                        or request.cookies.get('cn_token'))
            token = get_token()
            if supplied and secrets.compare_digest(supplied, token):
                return await call_next(request)
            if not _rate_hit(ip, 'authfail', AUTH_FAILURE_LIMIT):
                return JSONResponse({'ok': False, 'error': 'rate_limited'},
                                    status_code=429, headers={'Retry-After': '30'})
            return JSONResponse({'ok': False, 'error': 'unauthorized'},
                                status_code=401)
        return JSONResponse({'ok': False, 'error': 'not_found'}, status_code=404)

    @app.middleware('http')
    async def no_store(request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith('/api'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    @app.get('/api/status')
    def status():
        store = _store()
        tasks = store.tasks(include_removed=True)
        return {
            'ok': True,
            'version': APP_VERSION,
            'counts': {
                'active': sum(1 for t in tasks if not t['removed'] and not t['done']),
                'done': sum(1 for t in tasks if not t['removed'] and t['done']),
                'removed': sum(1 for t in tasks if t['removed']),
            },
        }

    @app.get('/api/todos')
    def list_todos(view: str = 'active', q: str = ''):
        store = _store()
        if view == 'active':
            tasks = store.tasks(done=False)
        elif view == 'done':
            tasks = store.tasks(done=True)
        elif view == 'removed':
            tasks = [t for t in store.tasks(include_removed=True) if t['removed']]
        elif view == 'all':
            tasks = store.tasks(include_removed=True)
        else:
            raise HTTPException(400, 'view 必须是 active/done/removed/all')
        if q.strip():
            needle = q.strip().lower()
            tasks = [t for t in tasks
                     if needle in t['title'].lower() or needle in t['note'].lower()]
        return {'ok': True, 'tasks': tasks}

    @app.get('/api/todos/{task_id}')
    def get_todo(task_id: str):
        try:
            return {'ok': True, 'task': _store().get(task_id)}
        except ValueError as error:
            raise HTTPException(404, str(error))

    @app.post('/api/todos')
    def create_todo(body: TaskCreate):
        store = _store()
        try:
            task_id = store.upsert(
                body.title, due=body.due, due_label=body.due_label,
                note=body.note, source='', optional=body.optional)
            return {'ok': True, 'task': store.get(task_id)}
        except ValueError as error:
            raise HTTPException(400, str(error))

    @app.patch('/api/todos/{task_id}')
    def patch_todo(task_id: str, body: TaskPatch):
        try:
            return {'ok': True, 'task': _store().patch_fields(
                task_id, body.changes, body.baseline)}
        except ValueError as error:
            raise HTTPException(409, str(error))

    @app.post('/api/todos/{task_id}/done')
    def mark_todo(task_id: str, body: BoolValue):
        try:
            _store().mark(task_id, body.value)
            return {'ok': True, 'task': _store().get(task_id)}
        except ValueError as error:
            raise HTTPException(404, str(error))

    @app.post('/api/todos/{task_id}/removed')
    def remove_todo(task_id: str, body: BoolValue):
        try:
            _store().remove(task_id, body.value)
            return {'ok': True, 'task': _store().get(task_id)}
        except ValueError as error:
            raise HTTPException(404, str(error))

    @app.post('/api/todos/clear-completed')
    def clear_completed(body: ClearCompleted):
        return {'ok': True, 'removed': _store().remove_completed(body.ids)}

    @app.post('/api/inbox')
    def upload_inbox(files: list[UploadFile] = File(...)):
        if not files:
            raise HTTPException(400, '没有收到文件')
        if len(files) > 10:
            raise HTTPException(400, '一次最多上传 10 个文件')
        folder_rel = ('state/inbox/' + datetime.now().strftime('%Y%m%d-%H%M%S')
                      + '-' + uuid.uuid4().hex[:6])
        folder = project_path(folder_rel)
        folder.mkdir(parents=True, exist_ok=True)
        saved = []
        limit = 25 * 1024 * 1024
        for upload in files:
            name = Path(upload.filename or 'file').name
            name = re.sub(r'[\\/:*?"<>|]', '_', name)[:120] or 'file'
            data = upload.file.read(limit + 1)
            if len(data) > limit:
                raise HTTPException(413, '单个文件不能超过 25MB')
            target = folder / name
            counter = 1
            while target.exists():
                target = folder / f'{counter}-{name}'
                counter += 1
            target.write_bytes(data)
            saved.append({'name': target.name, 'size': len(data),
                          'stored': f'{folder_rel}/{target.name}'})
        return {'ok': True, 'files': saved}

    @app.get('/api/inbox/{relpath:path}')
    def read_inbox(relpath: str):
        root = project_path('state/inbox').resolve()
        try:
            candidate = (root / relpath).resolve()
            candidate.relative_to(root)
        except (ValueError, OSError):
            raise HTTPException(404, '文件不存在')
        if not candidate.is_file():
            raise HTTPException(404, '文件不存在')
        return FileResponse(candidate, filename=candidate.name,
                            content_disposition_type='inline')

    @app.get('/api/settings/automation')
    def get_automation(request: Request):
        if not _is_trusted_local(request):
            raise HTTPException(403, '仅本机可修改读取设置')
        return {'ok': True, **automation.public_state(), 'running': scheduler.busy()}

    @app.put('/api/settings/automation')
    def save_automation(body: AutomationSettings, request: Request):
        if not _is_trusted_local(request):
            raise HTTPException(403, '仅本机可修改读取设置')
        try:
            will_have_key = automation.api_key_set()
            if body.clear_api_key:
                will_have_key = False
            elif body.api_key:
                will_have_key = True
            if body.enabled:
                if not will_have_key:
                    raise ValueError('请先保存 DeepSeek API Key')
                if not body.privacy_confirmed:
                    raise ValueError('请先确认隐私提示')
            if body.clear_api_key:
                automation.clear_api_key()
            elif body.api_key:
                automation.save_api_key(body.api_key)
            automation.save_config(body.model_dump())
        except ValueError as error:
            raise HTTPException(400, str(error))
        warning = None
        try:
            automation.set_auto_start(body.auto_start)
        except (OSError, ValueError) as error:
            warning = f'开机自启未生效：{error}'
        state = automation.public_state()
        if warning:
            state['auto_start_warning'] = warning
        state['running'] = scheduler.busy()
        return {'ok': True, **state}

    @app.post('/api/automation/run')
    def run_automation(request: Request):
        if not _is_trusted_local(request):
            raise HTTPException(403, '仅本机可触发读取')
        if not automation.api_key_set():
            raise HTTPException(400, '请先保存 DeepSeek API Key')
        if scheduler.busy():
            raise HTTPException(409, '已有读取在进行')
        if not scheduler.request_manual_run():
            raise HTTPException(409, '已有读取在进行')
        return {'ok': True, 'started': True}

    @app.get('/api/setup/status')
    def setup_status(request: Request):
        if not _is_trusted_local(request):
            raise HTTPException(403, '仅本机可查看标定')
        return {'ok': True, **setup_groups.status()}

    @app.get('/api/setup/scan')
    def setup_scan(request: Request):
        if not _is_trusted_local(request):
            raise HTTPException(403, '仅本机可识别群聊')
        try:
            return {'ok': True, **setup_groups.scan()}
        except (RuntimeError, OSError, ValueError) as error:
            raise HTTPException(500, str(error))

    @app.post('/api/setup/authorize')
    def setup_authorize(body: SetupAuthorize, request: Request):
        if not _is_trusted_local(request):
            raise HTTPException(403, '仅本机可识别群聊')
        platforms = [item for item in body.platforms if item in ('qq', 'wechat')]
        try:
            result = setup_groups.authorize(platforms, body.paths, body.confirmed)
        except (RuntimeError, OSError, ValueError) as error:
            raise HTTPException(400, str(error))
        return {'ok': True, 'results': result}

    @app.get('/api/setup/groups')
    def setup_group_list(source_id: str, request: Request):
        if not _is_trusted_local(request):
            raise HTTPException(403, '仅本机可识别群聊')
        try:
            return {'ok': True, 'groups': setup_groups.list_groups(source_id)}
        except (RuntimeError, OSError, ValueError) as error:
            raise HTTPException(400, str(error))

    @app.post('/api/setup/groups')
    def setup_save_groups(body: GroupsSave, request: Request):
        if not _is_trusted_local(request):
            raise HTTPException(403, '仅本机可修改标定')
        try:
            result = setup_groups.save_groups([item.model_dump() for item in body.groups])
        except (RuntimeError, OSError, ValueError) as error:
            raise HTTPException(400, str(error))
        return {'ok': True, **result}

    @app.post('/api/setup/folder')
    def setup_folder(body: FolderRequest, request: Request):
        if not _is_trusted_local(request):
            raise HTTPException(403, '仅本机可选择目录')
        if body.platform != 'wechat':
            raise HTTPException(400, '目前只支持选择微信目录')
        try:
            return {'ok': True, 'paths': setup_groups.pick_wechat_folder()}
        except (OSError, ValueError, subprocess.TimeoutExpired) as error:
            raise HTTPException(400, str(error))

    @app.post('/api/sync/read')
    def sync_read(body: SyncRead, request: Request):
        if not _is_trusted_local(request):
            raise HTTPException(403, '仅本机可读取群消息')
        if scheduler.busy():
            raise HTTPException(409, '自动读取正在进行，请稍后再试')
        if not _SYNC_LOCK.acquire(blocking=False):
            raise HTTPException(409, '已有手动读取在进行')
        try:
            result = manual_sync.read_new(body.group_keys, body.limit, body.since_days)
        except (RuntimeError, OSError, ValueError) as error:
            raise HTTPException(400, str(error))
        finally:
            _SYNC_LOCK.release()
        return {'ok': True, **result}

    @app.post('/api/sync/commit')
    def sync_commit(body: SyncCommit, request: Request):
        if not _is_trusted_local(request):
            raise HTTPException(403, '仅本机可修改待办')
        try:
            result = manual_sync.commit(
                body.batch_id, [item.model_dump() for item in body.items], body.mode)
        except (RuntimeError, OSError, ValueError) as error:
            raise HTTPException(400, str(error))
        return {'ok': True, **result}

    @app.post('/api/pairing/tunnel')
    def toggle_tunnel(body: TunnelToggle, request: Request):
        if not _is_trusted_local(request):
            raise HTTPException(403, '仅本机可修改公网访问')
        tunnel.set_enabled(body.enabled)
        return {'ok': True, 'tunnel': tunnel.status()}

    @app.get('/api/pairing')
    def pairing(request: Request, mode: str = ''):
        if not _is_trusted_local(request):
            raise HTTPException(403, '仅本机可查看配对信息')
        port = request.url.port
        urls = [f'http://{address}:{port}' for address in _lan_addresses()]
        if not urls:
            urls = [f'http://127.0.0.1:{port}']
        token = get_token()
        tunnel_state = tunnel.status()
        remote_url = tunnel_state.get('url') if tunnel_state.get('enabled') else None
        preferred = ('remote' if remote_url else 'lan') if mode not in ('lan', 'remote') else mode
        qr_url = remote_url if preferred == 'remote' and remote_url else urls[0]
        qr_payload = json.dumps({'v': 2, 'url': qr_url, 'token': token,
                                 'lan': urls, 'remote': remote_url,
                                 'preferred': preferred}, ensure_ascii=False)
        image = qrcode.make(qr_payload)
        buffer = io.BytesIO()
        image.save(buffer, format='PNG')
        qr_png = 'data:image/png;base64,' + base64.b64encode(
            buffer.getvalue()).decode('ascii')
        return {'ok': True, 'urls': urls, 'remote_url': remote_url,
                'preferred': preferred, 'tunnel': tunnel_state, 'token': token,
                'qr_payload': qr_payload, 'qr_png': qr_png}

    @app.get('/api/groups')
    def groups():
        return {'ok': True, **_config_groups()}

    app.mount('/', StaticFiles(directory=str(UI_DIR), html=True), name='ui')
    app.add_middleware(
        CORSMiddleware,
        allow_origins=['*'],
        allow_methods=['*'],
        allow_headers=['*'],
    )
    return app