"""Bounded auto-read scheduler: local stat checks, throttled reads, DeepSeek todos."""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, time as dtime, timedelta
from pathlib import Path
import re
import subprocess
import sys
import threading
import time

from project_core import LOCAL_TZ, ROOT, project_path

from . import automation, deepseek

PENDING_REL = 'state/automation-pending.json'
DUE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$')
MAX_CANDIDATES = 20

SYSTEM_PROMPT = """你是 ChatNotice 的群消息整理助手。根据候选群消息提取明确、可执行的事项。
只输出一个 JSON 对象，不要输出 Markdown：
{"todos":[{"message_keys":["K"],"title":"事项标题","note":"要求和已知说明","due":null,"due_label":"","optional":false}],"results":[{"message_key":"K","status":"done|skipped|pending","reason":"简短原因"}]}

规则：
- 每条候选消息必须有一条 results，message_key 必须原样使用。
- 只有明确事项（报名、缴费、会议、提交材料、截止时间、地点变更等）才 done 并生成 todo；广告、组队招募、闲聊、纯资讯 skipped。
- 信息不足或只有图片无法确认时 pending。
- 不确定日期必须 null，禁止编造。due 只能是 YYYY-MM-DD 或 YYYY-MM-DDTHH:MM 或 null。
- title 简洁明确（不超过 60 字）；note 保留关键时间、地点、金额、链接；optional 表示不紧急且不影响完成。
- 同一事项可关联多个 message_keys，只生成一个 todo。
- 已有待办中已覆盖的事项不要重复创建；只是重复提醒时 results 标记 skipped，reason 写“已有待办”。
- 参考给出的当前时间与时区解析“今天/明天/下午两点”等相对时间。"""


def _now() -> datetime:
    return datetime.now(LOCAL_TZ)


def _iso_now() -> str:
    return _now().isoformat(timespec='seconds')


def _parse_time(value: str) -> dtime:
    hour, minute = value.split(':')
    return dtime(int(hour), int(minute))


def in_window(start: str, end: str, now: datetime | None = None) -> bool:
    now = now or _now()
    current = now.timetz().replace(tzinfo=None)
    begin, finish = _parse_time(start), _parse_time(end)
    if begin < finish:
        return begin <= current < finish
    return current >= begin or current < finish


def source_signature() -> str | None:
    """Hash QQ/WeChat database stat info without opening or decrypting files."""
    path = project_path('state/agent-config.json')
    if not path.is_file():
        return None
    try:
        config = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    entries = []
    for source in (config.get('sources') or {}).values():
        paths = source.get('paths') or {}
        platform = source.get('platform')
        try:
            if platform == 'qq':
                root = Path(paths.get('database_dir', ''))
                files = [root / 'nt_msg.db', root / 'nt_msg.db-wal']
            elif platform == 'wechat':
                root = Path(paths.get('database_dir', '')) / 'message'
                files = []
                for name in sorted(root.glob('message_[0-9]*.db')):
                    files.extend([name, name.with_name(name.name + '-wal')])
            else:
                continue
            for item in files:
                stat = item.stat()
                entries.append(f'{source.get("id")}|{item.name}|{stat.st_size}|{stat.st_mtime_ns}')
        except (OSError, ValueError):
            continue
    if not entries:
        return None
    return hashlib.sha256('\n'.join(sorted(entries)).encode('utf-8')).hexdigest()


def _agent_json(args: list[str], stdin_payload: dict | None = None,
                timeout: float = 900.0) -> dict:
    command = [sys.executable, '-B', '-X', 'utf8', str(ROOT / 'agent_cli.py'), *args]
    env = dict(os.environ, PYTHONIOENCODING='utf-8')
    result = subprocess.run(
        command, cwd=str(ROOT), capture_output=True, encoding='utf-8',
        errors='replace', timeout=timeout, env=env,
        input=json.dumps(stdin_payload, ensure_ascii=False) if stdin_payload is not None else None,
    )
    try:
        data = json.loads(result.stdout)
    except ValueError:
        raise RuntimeError('agent_cli 返回了无法解析的结果') from None
    if result.returncode != 0 or not data.get('ok'):
        error = data.get('error') or {}
        raise RuntimeError(error.get('message') or 'agent_cli 执行失败')
    return data.get('data') or {}


def _valid_due(value) -> str | None:
    if value in (None, ''):
        return None
    if not isinstance(value, str) or not DUE_RE.fullmatch(value.strip()):
        raise ValueError('due 格式无效')
    datetime.fromisoformat(value.strip())
    return value.strip()


def _strip_json(text: str) -> dict:
    text = text.strip()
    if text.startswith('```'):
        text = re.sub(r'^```[a-zA-Z]*\s*', '', text)
        text = re.sub(r'\s*```$', '', text)
    start, end = text.find('{'), text.rfind('}')
    if start < 0 or end <= start:
        raise ValueError('模型输出不是 JSON 对象')
    return json.loads(text[start:end + 1])


def _validate_model_output(raw: str, candidates: list[dict]) -> tuple[list[dict], list[dict]]:
    payload = _strip_json(raw)
    todos = payload.get('todos')
    results = payload.get('results')
    if not isinstance(todos, list) or not isinstance(results, list):
        raise ValueError('模型输出缺少 todos/results')
    keys = {item['message_key'] for item in candidates}
    by_key = {}
    for row in results:
        if not isinstance(row, dict):
            raise ValueError('results 项必须是对象')
        key = row.get('message_key')
        if key not in keys:
            raise ValueError(f'未知消息 key：{key}')
        status = row.get('status')
        if status not in ('done', 'skipped', 'pending'):
            raise ValueError('结果状态无效')
        by_key[key] = {'status': status,
                       'reason': str(row.get('reason') or '')[:300]}
    for key in keys:
        if key not in by_key:
            by_key[key] = {'status': 'pending', 'reason': '模型未返回结果'}
    accepted = []
    for todo in todos:
        if not isinstance(todo, dict):
            raise ValueError('todos 项必须是对象')
        message_keys = todo.get('message_keys')
        if (not isinstance(message_keys, list) or not message_keys
                or any(not isinstance(key, str) or key not in keys for key in message_keys)):
            raise ValueError('todo 关联了未知消息 key')
        title = str(todo.get('title') or '').strip()
        if not title or len(title) > 300:
            raise ValueError('todo 标题为空或过长')
        note = str(todo.get('note') or '')
        if len(note) > 12000:
            raise ValueError('todo 说明过长')
        due = _valid_due(todo.get('due'))
        due_label = str(todo.get('due_label') or '')[:100]
        optional = todo.get('optional', False)
        if type(optional) is not bool:
            raise ValueError('optional 必须是布尔值')
        if any(by_key[key]['status'] != 'done' for key in message_keys):
            for key in message_keys:
                by_key[key] = {'status': 'pending', 'reason': '关联待办被拒绝'}
            continue
        accepted.append({'message_keys': message_keys, 'title': title, 'note': note,
                         'due': due, 'due_label': due_label, 'optional': optional})
    rows = []
    for candidate in candidates:
        key = candidate['message_key']
        row = by_key[key]
        rows.append({'message_key': key,
                     'content_hash': candidate['content_hash'],
                     'status': row['status'], 'reason': row['reason']})
    return accepted, rows


def _pending_path() -> Path:
    return project_path(PENDING_REL)


def _load_pending() -> dict | None:
    path = _pending_path()
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def _save_pending(batch_id: str, operations: list[dict], results: list[dict]) -> None:
    path = _pending_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.tmp')
    temp.write_text(json.dumps({'batch_id': batch_id, 'operations': operations,
                                'results': results}, ensure_ascii=False),
                    encoding='utf-8')
    os.replace(temp, path)


def _clear_pending() -> None:
    try:
        _pending_path().unlink()
    except FileNotFoundError:
        pass


def _write_payload(batch_id: str, operations: list[dict], results: list[dict]) -> dict:
    chunks = [results[index:index + 200] for index in range(0, len(results), 200)] or [[]]
    last = {}
    for index, chunk in enumerate(chunks):
        if index == 0:
            _save_pending(batch_id, operations, chunk)
        payload = {'batch_id': batch_id, 'results': chunk}
        if index == 0 and operations:
            payload['operations'] = operations
        last = _agent_json(['write', '--input', '-'], payload, timeout=300)
        if last.get('has_failures'):
            raise RuntimeError('部分待办写入失败')
    _clear_pending()
    return last


class AutomationScheduler:
    def __init__(self):
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._run_lock = threading.Lock()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._loop, name='chatnotice-scheduler', daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def busy(self) -> bool:
        return self._run_lock.locked() or automation.lock_state().get('locked', False)

    def trigger_startup_run(self) -> bool:
        """Read once when the desktop app opens, ignoring the normal throttle."""
        config = automation.load_config()
        if not config.get('enabled') or not config.get('privacy_confirmed'):
            return False
        if not automation.api_key_set():
            return False
        return self.request_manual_run()

    def request_manual_run(self) -> bool:
        if self.busy():
            return False
        threading.Thread(target=self.run_cycle, kwargs={'manual': True},
                         name='chatnotice-manual-run', daemon=True).start()
        return True

    def _loop(self) -> None:
        while not self._stop.wait(2):
            try:
                self.tick()
            except Exception:
                # Status is recorded inside run_cycle; never let the loop die.
                pass

    def tick(self) -> None:
        config = automation.load_config()
        if not config.get('enabled'):
            return
        now = _now()
        last_check = config.get('last_check_at')
        try:
            last = datetime.fromisoformat(last_check) if last_check else None
        except ValueError:
            last = None
        interval = int(config.get('check_interval_seconds') or 60)
        if last and (now - last).total_seconds() < interval:
            return
        automation.update_runtime(last_check_at=_iso_now())
        if not in_window(config['window_start'], config['window_end'], now):
            return
        if not config.get('privacy_confirmed'):
            return
        if not config.get('pending_batch'):
            try:
                last_attempt = datetime.fromisoformat(config['last_attempt_at']) if config.get('last_attempt_at') else None
            except ValueError:
                last_attempt = None
            throttle = int(config.get('min_read_interval_minutes') or 5) * 60
            if last_attempt and (now - last_attempt).total_seconds() < throttle:
                return
            signature = source_signature()
            if signature is None:
                self._record('error', error='无法检查源数据库状态')
                return
            if signature == config.get('last_source_signature'):
                return
        self.run_cycle(manual=False)

    def run_cycle(self, manual: bool = False) -> dict:
        if not self._run_lock.acquire(blocking=False):
            return {'ok': False, 'error': '已有读取在进行'}
        try:
            if not automation.acquire_lock():
                automation.clear_stale_lock()
                if not automation.acquire_lock():
                    return {'ok': False, 'error': '已有读取在进行（锁被占用）'}
            try:
                return self._run(manual)
            finally:
                automation.release_lock()
        finally:
            self._run_lock.release()

    def _run(self, manual: bool) -> dict:
        config = automation.load_config()
        if not config.get('privacy_confirmed'):
            self._record('error', error='尚未确认隐私提示')
            return {'ok': False, 'error': '尚未确认隐私提示'}
        api_key = automation.load_api_key()
        if not api_key:
            self._record('error', error='未配置 DeepSeek API Key')
            return {'ok': False, 'error': '未配置 DeepSeek API Key'}
        try:
            last_attempt = datetime.fromisoformat(config['last_attempt_at']) if config.get('last_attempt_at') else None
        except ValueError:
            last_attempt = None
        signature = None
        pending_batch = config.get('pending_batch')
        pending_cursor = config.get('pending_cursor')
        if not pending_batch:
            signature = source_signature()
            if signature is None:
                self._record('error', error='无法检查源数据库状态')
                return {'ok': False, 'error': '无法检查源数据库状态'}
            if not manual:
                throttle = int(config.get('min_read_interval_minutes') or 5) * 60
                if last_attempt and (_now() - last_attempt).total_seconds() < throttle:
                    return {'ok': False, 'error': '未到完整读取间隔'}
                if signature == config.get('last_source_signature'):
                    return {'ok': False, 'error': '源数据库未变化'}
        automation.update_runtime(last_attempt_at=_iso_now())
        args = ['read', '--limit', '50']
        if pending_batch:
            args = ['read', '--batch', pending_batch, '--cursor', str(pending_cursor or 0), '--limit', '50']
        try:
            page = _agent_json(args, timeout=1800)
        except Exception as error:
            message = str(error)
            if pending_batch and any(word in message for word in ('群未授权', '已停用', '已撤销')):
                # The batch was opened before a group was disabled. Drop the stale
                # cursor and read the currently enabled groups afresh.
                automation.update_runtime(pending_batch=None, pending_cursor=None)
                pending_batch = None
                signature = source_signature()
                try:
                    page = _agent_json(['read', '--limit', '50'], timeout=1800)
                except Exception as retry_error:
                    self._record('error', error=f'读取失败：{retry_error}')
                    return {'ok': False, 'error': f'读取失败：{retry_error}'}
            else:
                self._record('error', error=f'读取失败：{message}')
                return {'ok': False, 'error': f'读取失败：{message}'}
        batch_id = page.get('batch_id')
        messages = page.get('messages') or []
        next_cursor = page.get('next_cursor')
        if not pending_batch and signature:
            automation.update_runtime(last_source_signature=signature,
                                      last_success_at=_iso_now())
        automation.update_runtime(
            pending_batch=batch_id if next_cursor is not None else None,
            pending_cursor=next_cursor,
        )
        candidates = []
        seen = set()
        for item in messages:
            if item.get('task_ids') or item.get('message_key') in seen:
                continue
            if not (item.get('analysis_state') == 'pending' or item.get('changed_since_batch')):
                continue
            text = (item.get('message') or {}).get('text') or ''
            if not text.strip():
                continue
            seen.add(item['message_key'])
            candidates.append(item)
            if len(candidates) >= MAX_CANDIDATES:
                break
        created = 0
        skipped = 0
        model_calls = 0
        pending = _load_pending()
        if (pending and pending.get('batch_id') == batch_id
                and pending.get('operations')):
            pending_keys = {key for op in pending['operations']
                            for key in op.get('message_keys') or []}
            candidate_keys = {item['message_key'] for item in candidates}
            if pending_keys and pending_keys <= candidate_keys:
                try:
                    _agent_json(['write', '--input', '-'],
                                {'batch_id': batch_id,
                                 'operations': pending['operations'],
                                 'results': pending['results']}, timeout=300)
                    _clear_pending()
                    created = len(pending['operations'])
                    candidates = [item for item in candidates
                                  if item['message_key'] not in pending_keys]
                except Exception as error:
                    self._record('error', read=len(messages), candidates=len(candidates),
                                 error=f'重试写入失败：{error}')
                    return {'ok': False, 'error': f'重试写入失败：{error}'}
        if candidates:
            config = automation.load_config()
            today_count = automation.today_calls(config)
            limit = int(config.get('daily_model_call_limit') or 20)
            if today_count >= limit:
                self._record('limited', read=len(messages), candidates=len(candidates),
                             error='达到今日模型调用上限')
                return {'ok': True, 'limited': True, 'candidates': len(candidates)}
            messages_for_model = [{'key': item['message_key'],
                                   'group': (item.get('message') or {}).get('group_name', ''),
                                   'time': (item.get('message') or {}).get('time', ''),
                                   'sender': (item.get('message') or {}).get('sender', ''),
                                   'text': ((item.get('message') or {}).get('text') or '')[:2000]}
                                  for item in candidates]
            try:
                from todo_store import TodoStore
                existing_todos = [{'title': task['title'], 'due': task['due']}
                                  for task in TodoStore().tasks(done=False)[:100]]
            except (OSError, ValueError):
                existing_todos = []
            user_payload = json.dumps({
                'timezone': 'Asia/Shanghai',
                'now': _now().isoformat(timespec='minutes'),
                'existing_todos': existing_todos,
                'messages': messages_for_model,
            }, ensure_ascii=False)
            raw = None
            validation_error = None
            for attempt in range(2):
                if automation.today_calls() >= limit:
                    break
                automation.increment_model_calls()
                model_calls += 1
                try:
                    prompt = user_payload
                    if attempt:
                        prompt += '\n\n上次输出校验失败：' + validation_error + '\n请重新只输出合法 JSON。'
                    raw = deepseek.chat_json(
                        [{'role': 'system', 'content': SYSTEM_PROMPT},
                         {'role': 'user', 'content': prompt}],
                        automation.load_config().get('model', 'deepseek-flash'), api_key)
                    todos, results = _validate_model_output(raw, candidates)
                    break
                except ValueError as error:
                    validation_error = str(error)
                    raw = None
                    continue
                except deepseek.DeepSeekError as error:
                    self._record('error', read=len(messages), candidates=len(candidates),
                                 model_calls=model_calls, error=f'模型调用失败：{error}')
                    return {'ok': False, 'error': str(error)}
            if raw is None:
                reason = '模型输出校验失败' if validation_error else '未调用模型'
                self._record('error', read=len(messages), candidates=len(candidates),
                             model_calls=model_calls, error=reason + (f'：{validation_error}' if validation_error else ''))
                return {'ok': False, 'error': reason}
            operations = []
            for index, todo in enumerate(todos, 1):
                operation_id = f"auto:{todo['message_keys'][0][:16]}:{index}"
                operations.append({'operation_id': operation_id, 'action': 'create',
                                   'message_keys': todo['message_keys'],
                                   'fields': {'title': todo['title'], 'note': todo['note'],
                                              'due': todo['due'], 'due_label': todo['due_label'],
                                              'optional': todo['optional']}})
                skipped += 0
            try:
                _write_payload(batch_id, operations, results)
                created = len(operations)
                skipped = sum(1 for row in results if row['status'] == 'skipped')
                result_status = 'ok'
                error = None
            except Exception as error_value:
                result_status = 'error'
                error = f'写入失败：{error_value}'
                self._record(result_status, read=len(messages), candidates=len(candidates),
                             created=0, skipped=0, model_calls=model_calls, error=error)
                return {'ok': False, 'error': error}
        else:
            result_status = 'empty'
            error = None
        self._record(result_status, read=len(messages), candidates=len(candidates),
                     created=created, skipped=skipped, model_calls=model_calls, error=error)
        return {'ok': True, 'read': len(messages), 'candidates': len(candidates),
                'created': created, 'skipped': skipped, 'model_calls': model_calls}

    def _record(self, status: str, *, read: int = 0, candidates: int = 0,
                created: int = 0, skipped: int = 0, model_calls: int = 0,
                error: str | None = None) -> None:
        entry = {'at': _iso_now(), 'status': status, 'read': read,
                 'candidates': candidates, 'created': created,
                 'skipped': skipped, 'model_calls': model_calls,
                 'error': (error or '')[:300]}
        config = automation.load_config()
        runs = config.get('recent_runs') or []
        runs = (runs + [entry])[-20:]
        automation.update_runtime(last_result=entry, recent_runs=runs)


scheduler = AutomationScheduler()