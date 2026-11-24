"""Local-only manual chat sync: read, lightweight filter, create/ignore todos."""
from __future__ import annotations

from datetime import datetime, timedelta
import hashlib
import json
import re

from project_core import LOCAL_TZ

from .scheduler import _agent_json

STRONG_WORDS = (
    '报名', '缴费', '交费', '截止', '提交', '会议', '开会', '讲座', '比赛', '竞赛',
    '领取', '填写', '登记', '面试', '培训', '宣讲', '活动', '申请', '签到', '考试',
    '作业', '选课', '问卷', '投票', '链接', '务必', '注意', '开始', '结束', '开放',
    '报名表', '报名费', '交流会', '分享会', '截止时间', '全体成员',
)
TIME_RE = re.compile(
    r'(\d{1,2}\s*月\s*\d{1,2}\s*[日号])|(\d{4}[-/]\d{1,2}[-/]\d{1,2})|'
    r'(\d{1,2}[:：]\d{2})|(今天|明天|后天|本周|下周|周[一二三四五六日天])')
URL_RE = re.compile(r'https?://|www\.')
NOISE = {'收到', '好的', '好', '嗯', '哦', '哈', '哈哈哈', '谢谢', 'ok', 'OK', '？', '?'}


def classify(text: str, has_attachments: bool = False) -> dict:
    value = (text or '').strip()
    reasons = []
    if not value:
        return {'likely': False, 'reasons': []}
    if value.startswith('[群公告]'):
        reasons.append('群公告')
    if '@全体成员' in value:
        reasons.append('@全体成员')
    hits = [word for word in STRONG_WORDS if word in value]
    if hits:
        reasons.append('关键词：' + '、'.join(dict.fromkeys(hits))[:60])
    time_hit = bool(TIME_RE.search(value))
    url_hit = bool(URL_RE.search(value))
    if url_hit:
        reasons.append('含链接')
    if time_hit and (len(value) >= 25 or hits):
        reasons.append('含时间')
    if len(value) >= 120:
        reasons.append('长消息')
    content = re.sub(r'@\S+', ' ', value).replace('[群公告]', ' ').strip()
    if not content or value in NOISE or (len(value) < 6 and not hits):
        return {'likely': False, 'reasons': []}
    likely = bool(reasons)
    return {'likely': likely, 'reasons': reasons[:5]}


def _read_messages(group_keys: list[str], limit: int, since_days: int) -> dict:
    limit = max(1, min(limit, 100))
    since = (datetime.now(LOCAL_TZ) - timedelta(days=max(1, min(since_days, 7))))
    args = ['read', '--limit', str(limit), '--no-prepare-images',
            '--since', since.isoformat(timespec='seconds')]
    for key in group_keys:
        args.extend(['--group', key])
    return _agent_json(args, timeout=1800)


def _display_text(message: dict) -> str:
    text = (message.get('text') or '').strip()
    if text:
        return text
    attachments = message.get('attachments') or []
    if attachments:
        names = '、'.join(str(item.get('filename') or '附件') for item in attachments)
        return f'[附件] {names}'
    return ''


def read_new(group_keys: list[str] | None = None, limit: int = 50,
             since_days: int = 1) -> dict:
    page = _read_messages(group_keys or [], limit, since_days)
    batch_id = page.get('batch_id')
    since_dt = datetime.now(LOCAL_TZ) - timedelta(days=max(1, min(since_days, 7)))
    items = []
    pages = 0
    while page is not None and pages < 40:
        for wrapper in page.get('messages') or []:
            message = wrapper.get('message') or {}
            try:
                if datetime.fromisoformat(message.get('time') or '') < since_dt:
                    continue
            except ValueError:
                pass
            raw_text = (message.get('text') or '').strip()
            text = _display_text(message)
            attachments = message.get('attachments') or []
            flag = classify(raw_text, bool(attachments))
            items.append({
                'message_key': wrapper.get('message_key'),
                'content_hash': wrapper.get('content_hash'),
                'group': message.get('group_name') or message.get('group_id') or '',
                'time': message.get('time') or '',
                'sender': message.get('sender') or '',
                'text': text,
                'attachments': [item.get('filename') for item in message.get('attachments') or []],
                'likely': flag['likely'],
                'reasons': flag['reasons'],
            })
        cursor = page.get('next_cursor')
        if cursor is None:
            break
        pages += 1
        page = _agent_json(['read', '--batch', batch_id, '--cursor', str(cursor),
                            '--limit', str(max(1, min(limit, 100))),
                            '--no-prepare-images'], timeout=600)
    items.sort(key=lambda item: item.get('time') or '', reverse=True)
    truncated = bool(page and page.get('next_cursor') is not None)
    if len(items) > 200:
        items = items[:200]
        truncated = True
    return {'batch_id': batch_id, 'items': items, 'truncated': truncated,
            'total': len(items), 'since_days': max(1, min(since_days, 7))}


def _clean_title(text: str) -> str:
    value = (text or '').strip()
    value = value.replace('[群公告]', ' ')
    value = re.sub(r'@全体成员', ' ', value)
    value = re.sub(r'@\S{1,20}', ' ', value)
    value = re.sub(r'https?://\S+', ' ', value)
    value = re.sub(r'[\U0001F300-\U0001FAFF\u2600-\u27BF]', ' ', value)
    value = re.sub(r'\s+', ' ', value).strip()
    first = re.split(r'[。！？!?\n]', value)[0].strip() or value
    return first[:80] or '新任务'


def _fields(item: dict, mode: str) -> dict:
    text = (item.get('text') or '').strip()
    title = _clean_title(text) if mode == 'rules' else (text.splitlines()[0].strip()[:80] or '新任务')
    note = text
    source = ' · '.join(part for part in (item.get('group'), item.get('time')) if part)
    if source:
        note = (note + '\n\n来源：' + source).strip()
    return {'title': title[:300], 'note': note[:12000], 'due': None,
            'due_label': '', 'optional': False}


def commit(batch_id: str, items: list[dict], mode: str = 'plain') -> dict:
    if not batch_id or not isinstance(items, list) or not 1 <= len(items) <= 200:
        raise ValueError('待办提交参数无效')
    operations, results = [], []
    for item in items:
        key = str(item.get('message_key') or '')
        content_hash = str(item.get('content_hash') or '')
        if not key or not content_hash:
            raise ValueError('消息标识缺失，请重新读取')
        action = item.get('action')
        if action == 'ignore':
            results.append({'message_key': key, 'content_hash': content_hash,
                            'status': 'skipped', 'reason': '手动忽略'})
            continue
        fields = _fields(item, 'rules' if mode == 'rules' else 'plain')
        digest = hashlib.sha256(json.dumps(fields, ensure_ascii=False,
                                           sort_keys=True).encode('utf-8')).hexdigest()[:8]
        operation_id = f"manual-sync:{key[:16]}:{digest}"
        operations.append({'operation_id': operation_id, 'action': 'create',
                           'message_keys': [key], 'fields': fields})
        results.append({'message_key': key, 'content_hash': content_hash, 'status': 'done'})
    if not results:
        raise ValueError('没有需要提交的消息')
    payload = {'batch_id': batch_id, 'operations': operations, 'results': results}
    data = _agent_json(['write', '--input', '-'], payload, timeout=300)
    return {'ok': not data.get('has_failures'),
            'created': sum(1 for item in data.get('operations') or [] if item.get('ok')),
            'ignored': sum(1 for item in results if item.get('status') == 'skipped'),
            'has_failures': bool(data.get('has_failures'))}