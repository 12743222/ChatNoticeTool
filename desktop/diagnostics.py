"""In-app redacted diagnostics for QQ setup/read failures."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys

from project_core import ROOT, project_path

from . import setup_groups


def _agent_cli(args: list[str]) -> dict:
    command = [sys.executable, '-B', '-X', 'utf8', str(ROOT / 'agent_cli.py'), *args]
    result = subprocess.run(
        command, cwd=str(ROOT), capture_output=True, text=True,
        encoding='utf-8', errors='replace', timeout=300)
    try:
        data = json.loads(result.stdout)
    except ValueError:
        return {'exit': result.returncode,
                'error': (result.stderr or result.stdout or '')[-800:]}
    return {'exit': result.returncode, **data}


def _schema(config: dict) -> dict:
    from agent_config import AgentConfig
    from database_reader import open_database
    try:
        with open_database(config, 'qq', 'group_info.db') as (connection, metadata):
            result = {'snapshot': metadata, 'tables': {}}
            tables = [row[0] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")]
            for table in tables:
                quoted = '"' + table.replace('"', '""') + '"'
                entry = {}
                try:
                    entry['columns'] = [row[1] for row in connection.execute(
                        'PRAGMA table_info(' + quoted + ')')]
                except Exception as error:
                    entry['columns_error'] = str(error)
                try:
                    entry['row_count'] = connection.execute(
                        'SELECT COUNT(*) FROM ' + quoted).fetchone()[0]
                except Exception as error:
                    entry['row_count_error'] = str(error)
                result['tables'][table] = entry
            try:
                columns = [row[1] for row in connection.execute('PRAGMA table_info("group_list")')]
                result['group_list_columns'] = columns
                result['group_list_rows'] = connection.execute(
                    'SELECT COUNT(*) FROM "group_list"').fetchone()[0]
            except Exception as error:
                result['group_list_error'] = str(error)
            return result
    except Exception as error:
        return {'error': str(error)}


def run() -> dict:
    value = setup_groups._config()
    sources = value.get('sources') or {}
    groups = value.get('groups') or {}
    report = {
        'generated_at': __import__('datetime').datetime.now().isoformat(timespec='seconds'),
        'root': str(ROOT),
        'key_cache': {},
        'sources': [],
        'qq': {},
    }
    secret_path = project_path('state/secrets.dpapi')
    report['key_cache'] = {
        'path': str(secret_path),
        'exists': secret_path.is_file(),
        'size': secret_path.stat().st_size if secret_path.is_file() else None,
    }
    try:
        from memory_reader import load_secrets
        secrets = load_secrets()
        report['key_cache']['opened'] = True
        report['key_cache']['key_counts'] = {
            key: len(item) for key, item in secrets.items() if isinstance(item, dict)}
    except Exception as error:
        report['key_cache']['opened'] = False
        report['key_cache']['error'] = str(error)
    qq_sources = [source for source in sources.values() if source.get('platform') == 'qq']
    for source in sources.values():
        report['sources'].append({'id': source.get('id'), 'platform': source.get('platform'),
                                  'name': source.get('name')})
    if not qq_sources:
        report['qq']['error'] = '没有已配置的 QQ 来源'
    else:
        source = qq_sources[0]
        source_id = source.get('id')
        try:
            report['qq']['check'] = setup_groups._run(
                ['source', 'check', '--source', source_id])
        except Exception as error:
            report['qq']['check'] = {'error': str(error)}
        try:
            report['qq']['groups'] = setup_groups._run(
                ['groups', 'list', '--source', source_id, '--limit', '5'])
        except Exception as error:
            report['qq']['groups'] = {'error': str(error)}
        enabled = [key for key, group in groups.items()
                   if group.get('enabled') and key.startswith('qq:')]
        if enabled:
            read = _agent_cli(['read', '--limit', '3', '--no-prepare-images',
                               '--group', enabled[0]])
            if read.get('ok') and isinstance(read.get('data'), dict):
                page = read['data']
                messages = page.get('messages') or []
                report['qq']['read_test'] = {
                    'ok': True,
                    'message_count': len(messages),
                    'latest_time': max((item.get('message', {}).get('time', '')
                                        for item in messages), default=''),
                }
            else:
                report['qq']['read_test'] = {'ok': False,
                                             'error': read.get('error') or read}
        else:
            report['qq']['read_test'] = {'ok': False, 'error': '没有已启用的 QQ 群'}
        try:
            from agent_config import AgentConfig
            client = AgentConfig(ROOT).client_config(source)
            report['qq']['schema'] = _schema(client)
        except Exception as error:
            report['qq']['schema'] = {'error': str(error)}
    path = project_path('state/qq-diagnostics.json')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n',
                    encoding='utf-8')
    return {'path': str(path), 'generated_at': report['generated_at'],
            'key_cache_opened': report['key_cache'].get('opened'),
            'qq_check': report.get('qq', {}).get('check'),
            'qq_read_test': report.get('qq', {}).get('read_test')}