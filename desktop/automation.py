"""Auto-read configuration, API key storage, runtime state and startup registration."""
from __future__ import annotations

import json
import os
from datetime import date, datetime
from pathlib import Path
import re
import sys
import threading

from project_core import LOCAL_TZ, ROOT, project_path

CONFIG_REL = 'state/automation.json'
SECRET_REL = 'state/model-secrets.dpapi'
LOCK_REL = 'state/automation.lock'
RUN_KEY = r'Software\Microsoft\Windows\CurrentVersion\Run'
VALUE_NAME = 'ChatNotice'
TIME_RE = re.compile(r'^([01]\d|2[0-3]):[0-5]\d$')
MODEL_RE = re.compile(r'^[A-Za-z0-9._-]{1,100}$')

DEFAULTS = {
    'schema_version': 1,
    'enabled': False,
    'window_start': '08:00',
    'window_end': '22:00',
    'check_interval_seconds': 60,
    'min_read_interval_minutes': 5,
    'model': 'deepseek-flash',
    'daily_model_call_limit': 20,
    'privacy_confirmed': False,
    'pending_batch': None,
    'pending_cursor': None,
    'model_calls_date': None,
    'model_calls_count': 0,
    'last_check_at': None,
    'last_attempt_at': None,
    'last_success_at': None,
    'last_source_signature': None,
    'last_result': None,
    'recent_runs': [],
}

_LOCK = threading.RLock()


def load_config() -> dict:
    config = dict(DEFAULTS)
    path = project_path(CONFIG_REL)
    with _LOCK:
        if path.is_file():
            try:
                stored = json.loads(path.read_text(encoding='utf-8'))
            except (OSError, ValueError):
                stored = {}
            if isinstance(stored, dict):
                for key in DEFAULTS:
                    if key in stored:
                        config[key] = stored[key]
    return config


def _write_config(config: dict) -> None:
    path = project_path(CONFIG_REL)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.tmp')
    temp.write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n',
                    encoding='utf-8')
    os.replace(temp, path)


def validate_config(values: dict) -> dict:
    start = str(values.get('window_start', '')).strip()
    end = str(values.get('window_end', '')).strip()
    if not TIME_RE.fullmatch(start) or not TIME_RE.fullmatch(end):
        raise ValueError('时间格式应为 HH:MM')
    if start == end:
        raise ValueError('开始时间和结束时间不能相同')
    check = values.get('check_interval_seconds')
    if type(check) is not int or not 30 <= check <= 600:
        raise ValueError('检查间隔需在 30 到 600 秒之间')
    minutes = values.get('min_read_interval_minutes')
    if type(minutes) is not int or not 1 <= minutes <= 1440:
        raise ValueError('完整读取间隔需在 1 到 1440 分钟之间')
    model = str(values.get('model', '')).strip()
    if not MODEL_RE.fullmatch(model):
        raise ValueError('模型名不合法')
    limit = values.get('daily_model_call_limit')
    if type(limit) is not int or not 1 <= limit <= 99999:
        raise ValueError('每日模型调用上限需在 1 到 99999 次之间')
    return {
        'window_start': start,
        'window_end': end,
        'check_interval_seconds': check,
        'min_read_interval_minutes': minutes,
        'model': model,
        'daily_model_call_limit': limit,
    }


def save_config(values: dict) -> dict:
    validated = validate_config(values)
    with _LOCK:
        config = load_config()
        config.update(validated)
        if 'enabled' in values:
            if type(values['enabled']) is not bool:
                raise ValueError('enabled 必须是布尔值')
            config['enabled'] = values['enabled']
        if 'privacy_confirmed' in values:
            if type(values['privacy_confirmed']) is not bool:
                raise ValueError('privacy_confirmed 必须是布尔值')
            config['privacy_confirmed'] = values['privacy_confirmed']
        _write_config(config)
    return config


def update_runtime(**changes) -> dict:
    with _LOCK:
        config = load_config()
        config.update(changes)
        if 'recent_runs' in config and isinstance(config['recent_runs'], list):
            config['recent_runs'] = config['recent_runs'][-20:]
        _write_config(config)
    return config


def local_today() -> str:
    return datetime.now(LOCAL_TZ).date().isoformat()


def today_calls(config: dict | None = None) -> int:
    config = config or load_config()
    if config.get('model_calls_date') != local_today():
        return 0
    count = config.get('model_calls_count')
    return count if type(count) is int and count >= 0 else 0


def increment_model_calls() -> int:
    today = local_today()
    with _LOCK:
        config = load_config()
        count = today_calls(config) + 1
        config['model_calls_date'] = today
        config['model_calls_count'] = count
        _write_config(config)
    return count


def reset_daily_calls() -> None:
    update_runtime(model_calls_date=local_today(), model_calls_count=0)


def load_api_key() -> str | None:
    path = project_path(SECRET_REL)
    if not path.is_file():
        return None
    try:
        from memory_reader import unprotect_secret
        data = json.loads(unprotect_secret(path.read_bytes()).decode('utf-8'))
        key = data.get('deepseek_api_key')
        return key if isinstance(key, str) and key.strip() else None
    except (OSError, ValueError, ImportError):
        return None


def api_key_set() -> bool:
    return bool(load_api_key())


def save_api_key(api_key: str) -> None:
    key = str(api_key or '').strip()
    if not key or len(key) > 300 or any(ch.isspace() for ch in key):
        raise ValueError('API Key 格式不正确')
    from memory_reader import protect_secret
    protected = protect_secret(json.dumps({'deepseek_api_key': key}).encode('utf-8'))
    path = project_path(SECRET_REL)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.tmp')
    temp.write_bytes(protected)
    os.replace(temp, path)


def clear_api_key() -> None:
    path = project_path(SECRET_REL)
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def _startup_command() -> str:
    pythonw = ROOT / '.venv' / 'Scripts' / 'pythonw.exe'
    executable = pythonw if pythonw.is_file() else Path(sys.executable)
    return f'"{executable}" -B -X utf8 "{ROOT / "desktop_app.py"}"'


def auto_start_enabled() -> bool:
    if os.name != 'nt':
        return False
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            value, _ = winreg.QueryValueEx(key, VALUE_NAME)
            return bool(value)
    except OSError:
        return False


def set_auto_start(enabled: bool) -> None:
    if os.name != 'nt':
        if enabled:
            raise ValueError('当前系统不支持开机自启')
        return
    import winreg
    if enabled:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            winreg.SetValueEx(key, VALUE_NAME, 0, winreg.REG_SZ, _startup_command())
        return
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0,
                            winreg.KEY_SET_VALUE) as key:
            winreg.DeleteValue(key, VALUE_NAME)
    except FileNotFoundError:
        pass


def ensure_auto_start() -> None:
    """Repair the registry command when the project moved."""
    if os.name != 'nt' or not auto_start_enabled():
        return
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            current, _ = winreg.QueryValueEx(key, VALUE_NAME)
        if current != _startup_command():
            set_auto_start(True)
    except OSError:
        pass


def lock_state() -> dict:
    path = project_path(LOCK_REL)
    if not path.is_file():
        return {'locked': False}
    try:
        age = datetime.now().timestamp() - path.stat().st_mtime
    except OSError:
        return {'locked': True, 'stale': False}
    return {'locked': True, 'age_seconds': round(age),
            'stale': age > 600}


def acquire_lock() -> bool:
    path = project_path(LOCK_REL)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return False
    try:
        os.write(fd, json.dumps({'pid': os.getpid(),
                                 'started_at': datetime.now().isoformat(timespec='seconds')}).encode())
    finally:
        os.close(fd)
    return True


def release_lock() -> None:
    try:
        project_path(LOCK_REL).unlink()
    except FileNotFoundError:
        pass


def public_state() -> dict:
    config = load_config()
    try:
        next_check = None
        if config.get('last_check_at'):
            base = datetime.fromisoformat(config['last_check_at'])
            from datetime import timedelta
            next_check = (base + timedelta(seconds=int(config['check_interval_seconds']))).isoformat(timespec='seconds')
    except (TypeError, ValueError):
        next_check = None
    return {
        'enabled': bool(config.get('enabled')),
        'window_start': config['window_start'],
        'window_end': config['window_end'],
        'check_interval_seconds': config['check_interval_seconds'],
        'min_read_interval_minutes': config['min_read_interval_minutes'],
        'model': config['model'],
        'daily_model_call_limit': config['daily_model_call_limit'],
        'auto_start': auto_start_enabled(),
        'privacy_confirmed': bool(config.get('privacy_confirmed')),
        'api_key_set': api_key_set(),
        'model_calls_today': today_calls(config),
        'last_check_at': config.get('last_check_at'),
        'last_attempt_at': config.get('last_attempt_at'),
        'last_success_at': config.get('last_success_at'),
        'last_result': config.get('last_result'),
        'next_check_at': next_check,
        'lock': lock_state(),
    }