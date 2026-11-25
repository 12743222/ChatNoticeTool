"""Read-only QQ group metadata diagnosis.

Prints table/column structure and counts only. It never exports chat bodies,
message text, keys, or contact lists. Run with the portable runtime:

    runtime\\python.exe -B -X utf8 diagnose_qq_groups.py
"""
from __future__ import annotations

import json
from pathlib import Path
import sys

from agent_config import AgentConfig
from database_reader import open_database
from groups import qq_groups


def quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def main() -> int:
    root = Path(__file__).resolve().parent
    config = AgentConfig(root)
    value = config.load()
    sources = [item for item in (value.get('sources') or {}).values()
               if item.get('platform') == 'qq']
    if not sources:
        report = {'ok': False, 'error': '没有已配置的 QQ 来源，请先完成 QQ 授权',
                  'root': str(root)}
    else:
        source = sources[0]
        report = {
            'ok': True,
            'root': str(root),
            'source': {'id': source.get('id'), 'name': source.get('name'),
                       'paths': source.get('paths', {})},
            'tables': {},
            'group_list': {},
            'qq_groups': {},
            'errors': [],
        }
        client = config.client_config(source)
        try:
            with open_database(client, 'qq', 'group_info.db') as (connection, metadata):
                report['snapshot'] = metadata
                tables = [row[0] for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type IN ('table','view') "
                    "ORDER BY name")]
                for table in tables:
                    entry = {}
                    try:
                        columns = [dict(row) for row in connection.execute(
                            'PRAGMA table_info(' + quote(table) + ')')]
                        entry['columns'] = [{'name': column.get('name'),
                                             'type': column.get('type')}
                                            for column in columns]
                    except Exception as error:
                        entry['columns_error'] = str(error)
                    try:
                        entry['row_count'] = connection.execute(
                            'SELECT COUNT(*) FROM ' + quote(table)).fetchone()[0]
                    except Exception as error:
                        entry['row_count_error'] = str(error)
                    report['tables'][table] = entry
                try:
                    columns = [row[1] for row in connection.execute(
                        'PRAGMA table_info("group_list")')]
                    report['group_list']['columns'] = columns
                    report['group_list']['row_count'] = connection.execute(
                        'SELECT COUNT(*) FROM "group_list"').fetchone()[0]
                    if '60001' in columns and '60007' in columns:
                        rows = connection.execute(
                            'SELECT "60001","60007" FROM "group_list" LIMIT 8').fetchall()
                        report['group_list']['sample'] = [
                            {'group_id': str(row[0]), 'name': row[1]} for row in rows]
                except Exception as error:
                    report['errors'].append({'stage': 'group_list', 'error': str(error)})
        except Exception as error:
            report['errors'].append({'stage': 'open_group_info', 'error': str(error)})
        try:
            result = qq_groups(client)
            report['qq_groups'] = {
                'count': len(result.get('groups') or []),
                'sample': (result.get('groups') or [])[:8],
            }
        except Exception as error:
            report['qq_groups'] = {'error': str(error)}
    output = root / 'qq-group-schema-report.json'
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n',
                      encoding='utf-8')
    print('written:', output)
    print('QQ tables:', ', '.join(report.get('tables', {})))
    print('qq_groups:', json.dumps(report.get('qq_groups', {}), ensure_ascii=False)[:500])
    return 0 if report.get('ok') else 2


if __name__ == '__main__':
    raise SystemExit(main())