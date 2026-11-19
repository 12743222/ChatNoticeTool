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
import uuid
from datetime import datetime
from pathlib import Path

import qrcode
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from project_core import project_path
from todo_store import TodoStore

APP_VERSION = '2.1.0-dev'
UI_DIR = Path(__file__).resolve().parent / 'ui'
VIRTUAL_NETWORKS = [ipaddress.ip_network('198.18.0.0/15')]


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


def create_app() -> FastAPI:
    app = FastAPI(title='ChatNotice', version=APP_VERSION)

    @app.middleware('http')
    async def access_guard(request: Request, call_next):
        if _is_trusted_local(request):
            return await call_next(request)
        if request.url.path.startswith('/api'):
            supplied = (request.headers.get('x-api-token')
                        or request.query_params.get('token')
                        or request.cookies.get('cn_token'))
            token = get_token()
            if supplied and secrets.compare_digest(supplied, token):
                return await call_next(request)
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

    @app.get('/api/pairing')
    def pairing(request: Request):
        if not _is_trusted_local(request):
            raise HTTPException(403, '仅本机可查看配对信息')
        port = request.url.port
        urls = [f'http://{address}:{port}' for address in _lan_addresses()]
        if not urls:
            urls = [f'http://127.0.0.1:{port}']
        token = get_token()
        payload = json.dumps({'v': 1, 'url': urls[0], 'token': token},
                             ensure_ascii=False)
        image = qrcode.make(payload)
        buffer = io.BytesIO()
        image.save(buffer, format='PNG')
        qr_png = 'data:image/png;base64,' + base64.b64encode(
            buffer.getvalue()).decode('ascii')
        return {'ok': True, 'urls': urls, 'token': token,
                'qr_payload': payload, 'qr_png': qr_png}

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