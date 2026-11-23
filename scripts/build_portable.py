"""Build a clean Windows portable zip without personal state or secrets."""
from __future__ import annotations

import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / 'dist'
BUILD = DIST / 'portable_build'
APP = BUILD / 'ChatNotice'
EMBED_ZIP = BUILD / 'python-embed.zip'
SITE = ROOT / '.venv' / 'Lib' / 'site-packages'
OUTPUT = DIST / 'ChatNotice-portable-v2.1.0-dev-win64.zip'

APP_FILES = [
    'agent_assets.py', 'agent_cli.py', 'agent_config.py', 'agent_imports.py',
    'agent_locator.py', 'agent_processing.py', 'agent_service.py',
    'agent_setup.py', 'agent_sources.py', 'attachments.py', 'cipher.py',
    'cleanup.py', 'cli_support.py', 'database_reader.py', 'desktop_app.py',
    'dingtalk_export.py', 'dingtalk_probe.py', 'document_formats.py',
    'glass_style.py', 'group_settings.py', 'groups.py', 'local_setup.py',
    'memory_reader.py', 'messages.py', 'project_core.py', 'rules_editor.py',
    'todo_detail.py', 'todo_store.py', 'todo_widget.py', 'wechat_content.py',
    'widget_ui.py',
]


def ignore(_directory, names):
    return {name for name in names if name == '__pycache__' or name.endswith('.pyc')}


def main() -> None:
    if not EMBED_ZIP.is_file():
        raise SystemExit(f'缺少 {EMBED_ZIP}，请先下载 Python 3.12 embeddable zip')
    if APP.exists():
        shutil.rmtree(APP)
    APP.mkdir(parents=True)
    with zipfile.ZipFile(EMBED_ZIP) as archive:
        archive.extractall(APP / 'runtime')
    pth = APP / 'runtime' / 'python312._pth'
    text = pth.read_text(encoding='utf-8').replace('#import site', 'import site')
    if '\n..\n' not in text:
        text = text.replace('.\n', '.\n..\n', 1)
    pth.write_text(text, encoding='utf-8')
    shutil.copytree(SITE, APP / 'runtime' / 'Lib' / 'site-packages',
                    ignore=ignore)
    for name in ('pip', 'pip-24.3.1.dist-info', 'setuptools', 'wheel'):
        target = APP / 'runtime' / 'Lib' / 'site-packages' / name
        if target.is_dir():
            shutil.rmtree(target)
        elif target.exists():
            target.unlink()
    for name in APP_FILES:
        shutil.copy2(ROOT / name, APP / name)
    shutil.copytree(ROOT / 'desktop', APP / 'desktop', ignore=ignore)
    shutil.copytree(ROOT / 'docs' / 'agent', APP / 'docs' / 'agent', ignore=ignore)
    shutil.copy2(ROOT / 'docs' / '使用配置说明.md', APP / 'README-使用配置说明.md')
    shutil.copy2(ROOT / 'docs' / 'AI-配置指南.md', APP / 'AI-配置指南.md')
    shutil.copy2(ROOT / 'todo.ico', APP / 'todo.ico')
    for name in ('README.md', 'CHANGELOG.md', 'SECURITY.md'):
        if (ROOT / name).is_file():
            shutil.copy2(ROOT / name, APP / name)
    apk = ROOT / 'mobile' / 'android' / 'app' / 'build' / 'outputs' / 'apk' / 'debug' / 'app-debug.apk'
    if apk.is_file():
        shutil.copy2(apk, APP / 'ChatNotice-mobile.apk')
    tools = APP / 'state' / 'tools'
    tools.mkdir(parents=True)
    binary = ROOT / 'state' / 'tools' / 'cloudflared.exe'
    if binary.is_file():
        shutil.copy2(binary, tools / 'cloudflared.exe')
    (APP / 'Start ChatNotice.bat').write_text(
        '@echo off\r\ncd /d "%~dp0"\r\nstart "" "%~dp0runtime\\pythonw.exe" -B -X utf8 "%~dp0desktop_app.py"\r\nexit /b\r\n',
        encoding='utf-8')
    (APP / 'Start ChatNotice (debug console).bat').write_text(
        '@echo off\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\python.exe" -B -X utf8 "%~dp0desktop_app.py"\r\npause\r\n',
        encoding='utf-8')
    result = subprocess.run(
        [str(APP / 'runtime' / 'python.exe'), '-c',
         'import fastapi,uvicorn,webview,pystray,qrcode,PIL,cryptography,zstandard,pypdf,olefile; print("runtime ok")'],
        cwd=APP, capture_output=True, text=True, encoding='utf-8', errors='replace')
    print(result.stdout.strip() or result.stderr.strip())
    if result.returncode != 0:
        raise SystemExit('嵌入式运行时依赖检查失败')
    if OUTPUT.exists():
        OUTPUT.unlink()
    with zipfile.ZipFile(OUTPUT, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(APP.rglob('*')):
            if path.is_file():
                archive.write(path, Path('ChatNotice') / path.relative_to(APP))
    print('built', OUTPUT, OUTPUT.stat().st_size)


if __name__ == '__main__':
    main()