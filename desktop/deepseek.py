"""Minimal DeepSeek chat-completions client for the auto-read scheduler."""
from __future__ import annotations

import json
import socket
import time
import urllib.error
import urllib.request

API_URL = 'https://api.deepseek.com/chat/completions'


class DeepSeekError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def chat_json(messages: list[dict], model: str, api_key: str,
              *, max_tokens: int = 8000, timeout: float = 150.0) -> str:
    body = json.dumps({
        'model': model,
        'messages': messages,
        'temperature': 0,
        'max_tokens': max_tokens,
        'response_format': {'type': 'json_object'},
    }).encode('utf-8')
    headers = {
        'Authorization': 'Bearer ' + api_key,
        'Content-Type': 'application/json',
    }
    last_error: DeepSeekError | None = None
    for attempt in range(2):
        request = urllib.request.Request(API_URL, data=body, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                data = json.load(response)
            content = (data.get('choices') or [{}])[0].get('message', {}).get('content')
            if not isinstance(content, str) or not content.strip():
                raise DeepSeekError('empty_response', '模型未返回内容', True)
            return content
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                raise DeepSeekError('invalid_key', 'API Key 无效或无权限') from None
            if error.code == 429:
                delay = 10
                try:
                    delay = min(30, max(2, int(error.headers.get('Retry-After', '10'))))
                except ValueError:
                    pass
                last_error = DeepSeekError('rate_limited', '模型接口限流', True)
                if attempt == 0:
                    time.sleep(delay)
                    continue
                raise last_error from None
            if 500 <= error.code < 600 and attempt == 0:
                last_error = DeepSeekError('server_error', f'模型服务异常 ({error.code})', True)
                time.sleep(5)
                continue
            raise DeepSeekError('http_error', f'模型接口返回 {error.code}') from None
        except (urllib.error.URLError, socket.timeout, TimeoutError):
            last_error = DeepSeekError('timeout', '模型请求超时', True)
            if attempt == 0:
                time.sleep(5)
                continue
        except ValueError:
            raise DeepSeekError('bad_response', '模型响应无法解析') from None
    raise last_error or DeepSeekError('unknown', '模型调用失败')