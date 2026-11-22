"""ChatNotice desktop entry: local API service + WebView window + tray."""
from __future__ import annotations

import os
import socket
import threading
import time
import urllib.request

from project_core import project_path

APP_TITLE = 'ChatNotice'
BIND_HOST = os.environ.get('CHATNOTICE_HOST', '0.0.0.0')


def free_port(preferred: int = 8760) -> int:
    for port in range(preferred, preferred + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(('127.0.0.1', port))
            except OSError:
                continue
            return port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def wait_ready(url: str, timeout: float = 15.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except OSError:
            time.sleep(0.15)
    raise RuntimeError('本地服务启动超时')


def main() -> None:
    import pystray
    import uvicorn
    import webview
    from PIL import Image
    from desktop.automation import ensure_auto_start
    from desktop.scheduler import scheduler
    from desktop.server import create_app
    from desktop.tunnel import load_enabled, tunnel

    ensure_auto_start()
    scheduler.start()
    port = free_port()
    tunnel.configure(port)
    if load_enabled():
        tunnel.start()
    server = uvicorn.Server(
        uvicorn.Config(create_app(), host=BIND_HOST, port=port, log_level='warning'))
    threading.Thread(target=server.run, daemon=True).start()
    wait_ready(f'http://127.0.0.1:{port}/api/status')

    window = webview.create_window(
        APP_TITLE, f'http://127.0.0.1:{port}',
        width=1120, height=740, min_size=(900, 620),
        background_color='#edf5fe')

    quitting = threading.Event()

    def on_closing():
        if quitting.is_set():
            return True
        window.hide()
        return False

    window.events.closing += on_closing

    icon_image = Image.open(project_path('todo.ico'))

    def show_window(icon=None, item=None):
        window.show()

    def quit_app(icon, item):
        quitting.set()
        icon.stop()
        window.destroy()

    tray = pystray.Icon(
        'chatnotice', icon_image, f'{APP_TITLE} - 待办工作台',
        pystray.Menu(
            pystray.MenuItem('打开工作台', show_window, default=True),
            pystray.MenuItem('退出', quit_app),
        ))
    tray.run_detached()

    webview.start()
    server.should_exit = True
    scheduler.stop()
    tunnel.stop()
    tray.stop()


if __name__ == '__main__':
    main()