#!/usr/bin/env python3
"""Desktop launcher for the Neguedri-Stream web application."""

from __future__ import annotations

import ipaddress
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import tkinter as tk
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from tkinter import messagebox, simpledialog


APP_NAME = "Neguedri Streaming"
APP_DATA_NAME = "Neguedri-Stream"
BG = "#09090c"
PANEL = "#151519"
TEXT = "#f4f4f6"
MUTED = "#a1a1aa"
RED = "#e50914"
GREEN = "#40d39a"
SEED_FILES = (
    "favoritos.json",
    "historico.json",
    "progresso.json",
)
APP_REQUIRED_FILES = (
    "server.js",
    "index.html",
    "player.html",
    "sw.js",
    "manifest.webmanifest",
    "neguedri.png",
    "2neguedri.png",
    "package.json",
)
SHEETDB_API_URL = "https://sheetdb.io/api/v1/ds6y8emd7rcda"
SHEETDB_SHEET_NAME = "BancodeDados"
LOCAL_ACCESS_HOST = "neguedri-stream.local"
ZEROCONF_VERSION = "0.132.2"


def user_data_dir() -> Path:
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    elif os.name == "nt":
        base = Path(os.environ.get("APPDATA", str(Path.home())))
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local" / "share")))
    return base / APP_DATA_NAME


def choose_port() -> int:
    port = 1219
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("0.0.0.0", port))
        except OSError as exc:
            raise RuntimeError(
                "A porta fixa 1219 já está em uso. Feche o outro servidor e tente novamente."
            ) from exc
    return port


class Launcher:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.app_dir = Path(__file__).resolve().parent
        self.data_dir = user_data_dir()
        self.log_file = None
        self.zeroconf = None
        self.mdns_service = None
        self.local_ips: list[str] = []
        self.mdns_error: str | None = None
        self.local_ips: list[str] = []
        self.server: subprocess.Popen[bytes] | None = None
        self.port: int | None = None
        self.url: str | None = None
        self.starting = False
        self.stopping = False

        root.title(APP_NAME)
        root.configure(bg=BG)
        root.geometry("560x390")
        root.minsize(520, 360)
        root.protocol("WM_DELETE_WINDOW", self.close)
        self._build_ui()
        threading.Thread(target=self._start_server, daemon=True).start()

    def _build_ui(self) -> None:
        shell = tk.Frame(self.root, bg=BG, padx=30, pady=25)
        shell.pack(fill="both", expand=True)

        brand = tk.Frame(shell, bg=BG)
        brand.pack(fill="x")
        self.logo_image = None
        try:
            source = tk.PhotoImage(file=str(self.app_dir / "neguedri.png"))
            self.logo_image = source.subsample(max(1, source.width() // 190), max(1, source.height() // 108))
            tk.Label(brand, image=self.logo_image, bg=BG).pack(side="left", padx=(0, 16))
        except tk.TclError:
            tk.Label(brand, text="N", bg=RED, fg="white", font=("Arial", 22, "bold"), width=2, height=1).pack(side="left", padx=(0, 16))

        brand_text = tk.Frame(brand, bg=BG)
        brand_text.pack(side="left", fill="y", pady=8)
        tk.Label(brand_text, text="Iniciador NeguedriStream", bg=BG, fg=TEXT, font=("Arial", 17, "bold")).pack(anchor="w")
        tk.Label(brand_text, text="Seu sistema está sendo iniciado", bg=BG, fg=MUTED, font=("Arial", 10)).pack(anchor="w", pady=(5, 0))

        self.status_card = tk.Frame(shell, bg=PANEL, padx=18, pady=16)
        self.status_card.pack(fill="x", pady=(23, 14))
        self.status_title = tk.Label(self.status_card, text="Iniciando servidor local…", bg=PANEL, fg=TEXT, font=("Arial", 11, "bold"), anchor="w")
        self.status_title.pack(fill="x")
        self.status_detail = tk.Label(self.status_card, text="Preparando seus dados e verificando Node.js", bg=PANEL, fg=MUTED, font=("Arial", 9), anchor="w", wraplength=440, justify="left")
        self.status_detail.pack(fill="x", pady=(7, 0))

        self.url_label = tk.Label(shell, text="", bg=BG, fg=GREEN, font=("Arial", 9, "bold"), anchor="w", wraplength=480, justify="left")
        self.url_label.pack(fill="x", pady=(0, 12))

        row = tk.Frame(shell, bg=BG)
        row.pack(fill="x")
        self.open_button = tk.Button(row, text="Abrir Neguedri Streaming", command=self.open_browser, state="disabled", bg=RED, fg="white", activebackground="#ff3043", activeforeground="white", relief="flat", bd=0, padx=18, pady=11, font=("Arial", 10, "bold"), cursor="hand2")
        self.open_button.pack(side="left")
        self.close_button = tk.Button(row, text="Fechar app", command=self.close, bg=PANEL, fg=TEXT, activebackground="#24242a", activeforeground=TEXT, relief="flat", bd=0, padx=15, pady=11, font=("Arial", 9), cursor="hand2")
        self.close_button.pack(side="right")

        tk.Label(shell, text="Este painel mantém o servidor ativo. Fechá-lo encerra o aplicativo.", bg=BG, fg="#6f6f78", font=("Arial", 8), anchor="w").pack(fill="x", side="bottom", pady=(17, 0))

    def _start_server(self) -> None:
        self.starting = True
        try:
            if self.stopping:
                return
            missing = [name for name in APP_REQUIRED_FILES if not (self.app_dir / name).is_file()]
            if missing:
                raise RuntimeError("A pasta raiz selecionada não contém: " + ", ".join(missing))

            node = shutil.which("node")
            if not node:
                raise RuntimeError("Node.js não foi encontrado. Instale Node.js 18 ou superior e abra o app novamente.")
            version = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=8, check=False).stdout.strip()
            digits = version.lstrip("v").split(".", 1)[0]
            if not digits.isdigit() or int(digits) < 18:
                raise RuntimeError(f"O app precisa de Node.js 18 ou superior. Versão encontrada: {version or 'desconhecida'}.")

            self.data_dir.mkdir(parents=True, exist_ok=True)
            self.log_file = (self.data_dir / "servidor.log").open("a", encoding="utf-8")
            token_path = self.data_dir / "sheetdb-token.txt"
            sheetdb_token = token_path.read_text(encoding="utf-8").strip() if token_path.is_file() else ""
            if not sheetdb_token:
                raise RuntimeError("O token Bearer do SheetDB não foi configurado. Feche o app e inicie novamente para informar o token.")

            for name in SEED_FILES:
                source = self.app_dir / name
                target = self.data_dir / name
                if not source.is_file():
                    raise RuntimeError(f"Não encontrei {name} na pasta raiz do app.")
                if not target.exists():
                    shutil.copy2(source, target)

            if not (self.app_dir / "node_modules" / "express").is_dir():
                npm = shutil.which("npm")
                if not npm:
                    raise RuntimeError("As dependências do servidor não estão instaladas e o npm não foi encontrado. Reinstale o Node.js incluindo npm.")
                self._set_startup_message("Preparando o servidor…", "Instalando as dependências locais na primeira execução.")
                result = subprocess.run(
                    [npm, "install", "--omit=dev"],
                    cwd=self.app_dir,
                    stdout=self.log_file,
                    stderr=subprocess.STDOUT,
                    timeout=240,
                    check=False,
                )
                if result.returncode != 0:
                    raise RuntimeError("Não consegui instalar as dependências. Confira a conexão com a internet e o arquivo servidor.log.")

            if self.stopping:
                return

            self.port = choose_port()
            self.url = f"http://127.0.0.1:{self.port}/"

            environment = os.environ.copy()
            environment.update({
                "PORT": str(self.port),
                "HOST": "0.0.0.0",
                "NEGUEDRI_DATA_DIR": str(self.data_dir),
                "SHEETDB_API_URL": SHEETDB_API_URL,
                "SHEETDB_SHEET_NAME": SHEETDB_SHEET_NAME,
                "SHEETDB_BEARER_TOKEN": sheetdb_token,
            })
            self.server = subprocess.Popen(
                [node, "server.js"],
                cwd=self.app_dir,
                env=environment,
                stdout=self.log_file,
                stderr=subprocess.STDOUT,
            )
            if self.stopping:
                self.server.terminate()
                return

            for _ in range(80):
                if self.stopping:
                    return
                if self.server.poll() is not None:
                    raise RuntimeError(self._server_error())
                try:
                    with urllib.request.urlopen(self.url, timeout=1) as response:
                        if response.status == 200:
                            self._set_startup_message(
                                "Publicando endereço fixo…",
                                f"Anunciando {LOCAL_ACCESS_HOST} na rede local."
                            )
                            self._publish_local_address()
                            self.root.after(0, self._server_ready)
                            return
                except (urllib.error.URLError, TimeoutError, OSError):
                    time.sleep(0.25)
            raise RuntimeError("O servidor não respondeu a tempo. Consulte o arquivo servidor.log na pasta de dados do app.")
        except Exception as exc:
            if self.server is not None and self.server.poll() is None:
                self.server.terminate()
                try:
                    self.server.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.server.kill()
            self._stop_local_address()
            if not self.stopping:
                self.root.after(0, lambda error=str(exc): self._server_failed(error))
        finally:
            self.starting = False

    def _set_startup_message(self, title: str, detail: str) -> None:
        if self.stopping:
            return

        def update() -> None:
            if not self.stopping:
                self.status_title.configure(text=title, fg=TEXT)
                self.status_detail.configure(text=detail)

        self.root.after(0, update)

    def _server_error(self) -> str:
        log_path = self.data_dir / "servidor.log"
        try:
            tail = log_path.read_text(encoding="utf-8", errors="replace")[-1800:].strip()
        except OSError:
            tail = ""
        return f"O servidor encerrou durante a inicialização.\n\n{tail or 'Consulte servidor.log na pasta de dados do app.'}"

    def _zeroconf_modules(self):
        package_dir = self.data_dir / "python-packages"
        package_dir.mkdir(parents=True, exist_ok=True)
        package_path = str(package_dir)
        if package_path not in sys.path:
            sys.path.insert(0, package_path)

        try:
            from zeroconf import IPVersion, ServiceInfo, Zeroconf
            return IPVersion, ServiceInfo, Zeroconf
        except ImportError:
            self._set_startup_message(
                "Preparando o endereço fixo…",
                "Instalando o suporte de rede local na primeira execução."
            )
            result = subprocess.run(
                [
                    sys.executable, "-m", "pip", "install",
                    "--disable-pip-version-check", "--target", package_path,
                    f"zeroconf=={ZEROCONF_VERSION}"
                ],
                capture_output=True,
                text=True,
                timeout=240,
                check=False,
            )
            if result.returncode != 0:
                detail = (result.stderr or result.stdout or "").strip()[-700:]
                raise RuntimeError(
                    "Não consegui instalar o suporte ao nome local fixo. "
                    "Verifique a conexão com a internet e tente novamente. " + detail
                )
            if package_path not in sys.path:
                sys.path.insert(0, package_path)
            import importlib
            importlib.invalidate_caches()
            try:
                from zeroconf import IPVersion, ServiceInfo, Zeroconf
                return IPVersion, ServiceInfo, Zeroconf
            except ImportError as exc:
                raise RuntimeError("O suporte ao endereço local não foi carregado após a instalação.") from exc

    def _local_ipv4_addresses(self) -> list[str]:
        found: list[str] = []
        try:
            for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET, socket.SOCK_STREAM):
                address = item[4][0]
                parsed = ipaddress.ip_address(address)
                if parsed.is_private and not parsed.is_loopback and not parsed.is_link_local and address not in found:
                    found.append(address)
        except OSError:
            pass

        if not found:
            probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                probe.connect(("1.1.1.1", 80))
                address = probe.getsockname()[0]
                parsed = ipaddress.ip_address(address)
                if parsed.is_private and not parsed.is_loopback and not parsed.is_link_local:
                    found.append(address)
            except OSError:
                pass
            finally:
                probe.close()

        if not found:
            raise RuntimeError("Não encontrei um endereço IPv4 da rede local para publicar o link fixo.")
        return found

    def _publish_local_address(self) -> None:
        addresses = self._local_ipv4_addresses()
        self.local_ips = addresses
        try:
            IPVersion, ServiceInfo, Zeroconf = self._zeroconf_modules()
            zeroconf = Zeroconf(interfaces=addresses, ip_version=IPVersion.V4Only)
            service = ServiceInfo(
                "_http._tcp.local.",
                "Neguedri Streaming._http._tcp.local.",
                addresses=[socket.inet_aton(address) for address in addresses],
                port=self.port,
                properties={"path": "/"},
                server=f"{LOCAL_ACCESS_HOST}.",
            )
            zeroconf.register_service(service, allow_name_change=False)
        except Exception as exc:
            if "zeroconf" in locals():
                zeroconf.close()
            self.mdns_error = str(exc)
            return
        self.zeroconf = zeroconf
        self.mdns_service = service

    def _stop_local_address(self) -> None:
        if self.zeroconf is None:
            return
        try:
            if self.mdns_service is not None:
                self.zeroconf.unregister_service(self.mdns_service)
        except Exception:
            pass
        try:
            self.zeroconf.close()
        except Exception:
            pass
        self.zeroconf = None
        self.mdns_service = None

    def _server_ready(self) -> None:
        if self.stopping:
            return
        self.status_title.configure(text="Neguedri Streaming está pronto", fg=GREEN)
        if self.zeroconf is not None:
            self.status_detail.configure(text="Use o mesmo endereço fixo na rede local, em Mac, Windows e aparelhos compatíveis.")
            address_text = f"Link fixo na rede: http://{LOCAL_ACCESS_HOST}:{self.port}/"
        else:
            self.status_detail.configure(text="O servidor iniciou. O nome fixo não foi anunciado; use o endereço IP abaixo.")
            address_text = "Endereço IP na rede: disponível abaixo"
        fallback = f"\nAlternativa se .local não abrir: http://{self.local_ips[0]}:{self.port}/" if self.local_ips else ""
        self.url_label.configure(text=f"Neste computador: {self.url}\n{address_text}{fallback}")
        self.open_button.configure(state="normal")
        self.open_browser()

    def _server_failed(self, error: str) -> None:
        if self.stopping:
            return
        self.status_title.configure(text="Não foi possível iniciar", fg="#ff6672")
        self.status_detail.configure(text=error)
        self.open_button.configure(state="disabled")
        messagebox.showerror(APP_NAME, error, parent=self.root)

    def open_browser(self) -> None:
        if self.url:
            webbrowser.open(self.url, new=1)

    def close(self) -> None:
        if self.stopping:
            return
        self.stopping = True
        if self.server is not None and self.server.poll() is None:
            self.server.terminate()
            try:
                self.server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.server.kill()
                self.server.wait(timeout=3)
        self._stop_local_address()
        if self.log_file is not None:
            self.log_file.close()
        self.root.destroy()


def main() -> None:
    root = tk.Tk()
    token_path = user_data_dir() / "sheetdb-token.txt"
    saved_token = token_path.read_text(encoding="utf-8").strip() if token_path.is_file() else ""
    if not saved_token:
        root.withdraw()
        token = simpledialog.askstring(
            "Configurar SheetDB",
            "Cole o Bearer token da API SheetDB.\n\nAtive autenticação Bearer e permissões Read, Create, Update e Delete nas configurações da API. O token será guardado somente neste computador.",
            show="*",
            parent=root,
        )
        if not token or not token.strip():
            root.destroy()
            return
        token_path.parent.mkdir(parents=True, exist_ok=True)
        token_path.write_text(token.strip(), encoding="utf-8")
        try:
            token_path.chmod(0o600)
        except OSError:
            pass
        root.deiconify()
    Launcher(root)
    root.mainloop()


if __name__ == "__main__":
    main()
