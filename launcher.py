"""
LED Sign Launcher -- Windows system tray application.

Starts the Python FastAPI backend and Vite frontend dev server,
then opens http://localhost:5173/ in the default browser.
Lives in the system tray with a right-click menu to open, restart, or quit.

Requirements:  pystray  Pillow
Build to .exe: run  build_exe.bat
"""

import os
import shutil
import sys
import subprocess
import threading
import time
import webbrowser
import socket
import json
import urllib.request

# Windows: CREATE_NO_WINDOW prevents ANY console window from appearing for child processes
CREATE_NO_WINDOW = 0x08000000


def hidden_process_kwargs():
    """Prevent cmd.exe/npm and Python children from creating a console window."""
    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startupinfo.wShowWindow = subprocess.SW_HIDE
    return {"creationflags": CREATE_NO_WINDOW, "startupinfo": startupinfo}


def background_python_command() -> list[str]:
    """Find a real Python runtime for the separately-run backend."""
    if not getattr(sys, "frozen", False):
        return [sys.executable]

    # The Windows Python launcher resolves the installed runtime reliably where
    # the Store's python.exe app-execution alias can fail silently in a hidden
    # child process.
    python_launcher = shutil.which("py.exe")
    if python_launcher:
        return [python_launcher, "-3.12"]
    return [shutil.which("python.exe") or "python"]

BASE_DIR: str = ""


def find_base_dir() -> str:
    """
    Find the LED Sign project root (the folder containing server/main.py).
    When frozen to .exe by PyInstaller, sys.executable is the .exe itself,
    which may live in a 'dist' subfolder -- so we walk up until we find the root.
    When running as a plain .py script, __file__ gives us the location directly.
    """
    if getattr(sys, "frozen", False):
        start = os.path.dirname(sys.executable)
    else:
        start = os.path.dirname(os.path.abspath(__file__))

    candidate = start
    for _ in range(4):  # look up to 4 levels up
        if os.path.exists(os.path.join(candidate, "server", "main.py")):
            return candidate
        candidate = os.path.dirname(candidate)

    return start  # fallback


_backend_proc = None
_frontend_proc = None
_backend_log = None
_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def port_open(port: int, host: str = "127.0.0.1") -> bool:
    try:
        with socket.create_connection((host, port), timeout=0.5):
            return True
    except OSError:
        return False


def wait_for_port(port: int, timeout: float = 30.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if port_open(port):
            return True
        time.sleep(0.5)
    return False


def browser_tab_is_open() -> bool:
    """Ask the server whether a browser tab is actively heartbeating."""
    try:
        with urllib.request.urlopen("http://127.0.0.1:8000/ui-open", timeout=1) as response:
            return b'"open":true' in response.read().replace(b" ", b"")
    except Exception:
        return False


def launcher_log(message: str):
    """Record background-launch diagnostics without ever showing a console."""
    try:
        path = os.path.join(BASE_DIR, "led-sign-launcher.log")
        with open(path, "a", encoding="utf-8") as log:
            log.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}\n")
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Server lifecycle
# ---------------------------------------------------------------------------

def start_backend():
    global _backend_proc, _backend_log
    if port_open(8000):
        try:
            with urllib.request.urlopen('http://127.0.0.1:8000/status', timeout=3) as response:
                current = json.load(response).get('api_version', 0) >= 2
        except Exception:
            current = False
        if current:
            launcher_log("Current backend already listening on port 8000.")
            return
        launcher_log("Replacing an outdated LED Sign backend.")
        stop_project_server(8000, os.path.join(BASE_DIR, 'server', 'main.py'))
        # Windows may take a moment to release the listener after taskkill
        # returns, even though the process has already exited.
        deadline = time.monotonic() + 5
        while port_open(8000) and time.monotonic() < deadline:
            time.sleep(0.1)
        if port_open(8000):
            launcher_log("Port 8000 is still occupied; refusing to start a second backend.")
            return
    with _lock:
        command = [*background_python_command(), os.path.join(BASE_DIR, "server", "main.py")]
        try:
            _backend_log = open(os.path.join(BASE_DIR, "led-sign-server.log"), "a", encoding="utf-8")
            _backend_proc = subprocess.Popen(
                command,
                cwd=BASE_DIR,
                stdout=_backend_log,
                stderr=subprocess.STDOUT,
                **hidden_process_kwargs(),
            )
            launcher_log(f"Started backend (PID {_backend_proc.pid}): {' '.join(command)}")
        except OSError as error:
            launcher_log(f"Could not start backend: {error}")


def start_frontend():
    global _frontend_proc
    if port_open(5173):
        return
    with _lock:
        _frontend_proc = subprocess.Popen(
            ["cmd.exe", "/d", "/s", "/c", "npm.cmd run dev"],
            cwd=os.path.join(BASE_DIR, "client"),
            **hidden_process_kwargs(),
        )


def stop_project_server(port: int, source_path: str):
    """Stop only a listener whose command line contains this project's path.

    The Python launcher and cmd/npm are parents of the real servers. Killing
    only those parents leaves Python/Vite running, including across EXE launches.
    """
    expected_path = os.path.abspath(source_path).replace("'", "''")
    script = (
        f"$expected = '{expected_path}'; "
        f"Get-NetTCPConnection -LocalPort {int(port)} -State Listen -ErrorAction SilentlyContinue | "
        "Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { "
        "$server = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $_); "
        "if ($server.CommandLine -and $server.CommandLine.Replace('/', '\\').IndexOf($expected, [StringComparison]::OrdinalIgnoreCase) -ge 0) { "
        "$server.ProcessId } }"
    )
    try:
        found = subprocess.run(
            ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
            capture_output=True, text=True, timeout=15, **hidden_process_kwargs(),
        )
        for value in found.stdout.splitlines():
            if not value.strip().isdigit():
                continue
            pid = int(value.strip())
            launcher_log(f"Stopping project server on port {port} (PID {pid}).")
            subprocess.run(['taskkill.exe', '/PID', str(pid), '/T', '/F'],
                           capture_output=True, timeout=10, **hidden_process_kwargs())
    except Exception as error:
        launcher_log(f"Could not stop project server on port {port}: {error}")


def stop_servers():
    global _backend_proc, _frontend_proc
    try:
        urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8000/disconnect", method="POST"), timeout=2)
    except Exception:
        pass
    with _lock:
        stop_project_server(8000, os.path.join(BASE_DIR, 'server', 'main.py'))
        # npm can spell the entry point as .bin/../vite/bin/vite.js; the
        # project-specific modules path still identifies the listener safely.
        stop_project_server(5173, os.path.join(BASE_DIR, 'client', 'node_modules'))
        for proc in (_backend_proc, _frontend_proc):
            if proc and proc.poll() is None:
                try:
                    proc.terminate()
                except Exception:
                    pass
        _backend_proc = None
        _frontend_proc = None


def restart_servers(icon=None, item=None):
    stop_servers()
    time.sleep(1)
    threading.Thread(target=start_backend, daemon=True).start()
    threading.Thread(target=start_frontend, daemon=True).start()


# ---------------------------------------------------------------------------
# Tray icon
# ---------------------------------------------------------------------------

def make_icon_image():
    """Load the application artwork for the system-tray icon."""
    try:
        from PIL import Image
        artwork_path = os.path.join(BASE_DIR, "launcher_icon.png")
        if os.path.exists(artwork_path):
            with Image.open(artwork_path) as artwork:
                return artwork.convert("RGBA").resize((64, 64), Image.Resampling.LANCZOS)

        # Keep a recognizable fallback if the bundled artwork is unavailable.
        from PIL import ImageDraw
        img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        # Board body
        draw.rounded_rectangle([4, 14, 60, 50], radius=6,
                                fill=(28, 28, 36), outline=(134, 59, 255), width=2)
        # LED dots (two rows)
        led_colors = [(0, 230, 80), (0, 180, 255), (230, 60, 255), (255, 180, 0), (0, 230, 80)]
        for i, col in enumerate(led_colors):
            x = 10 + i * 10
            draw.ellipse([x, 23, x + 6, 29], fill=col)
            draw.ellipse([x, 35, x + 6, 41], fill=(col[0]//5, col[1]//5, col[2]//5))
        return img
    except Exception:
        try:
            from PIL import Image
            return Image.new("RGBA", (16, 16), (134, 59, 255, 255))
        except Exception:
            return None


def open_browser(icon=None, item=None):
    webbrowser.open("http://localhost:5173/")


def on_quit(icon, item):
    try:
        icon.notify("Stopping LED Sign servers...", "LED Sign")
    except Exception:
        pass
    stop_servers()
    icon.stop()


def run_tray():
    try:
        import pystray
    except ImportError:
        # Keep the background app alive silently if the tray dependency is unavailable.
        try:
            while True:
                time.sleep(60)
        except KeyboardInterrupt:
            stop_servers()
        return

    image = make_icon_image()
    if image is None:
        return

    menu = pystray.Menu(
        pystray.MenuItem("Open LED Sign", open_browser, default=True),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Restart Servers", restart_servers),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit", on_quit),
    )
    icon = pystray.Icon("LED Sign", image, "LED Sign", menu)
    icon.run()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    global BASE_DIR
    BASE_DIR = find_base_dir()
    # Start servers
    threading.Thread(target=start_backend, daemon=True).start()
    threading.Thread(target=start_frontend, daemon=True).start()

    # Only create a tab after the servers are ready and no existing LED Sign
    # page is reporting itself open. This works across separate browser windows.
    def open_if_needed():
        if '--background' in sys.argv:
            return
        if wait_for_port(5173) and wait_for_port(8000) and not browser_tab_is_open():
            webbrowser.open("http://localhost:5173/")
    threading.Thread(target=open_if_needed, daemon=True).start()

    # Live in system tray (blocks until Quit)
    run_tray()


if __name__ == "__main__":
    main()
