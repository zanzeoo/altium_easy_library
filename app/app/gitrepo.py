"""Historique des fichiers de bibliothèque dans un dépôt git local (un commit par action)."""
import subprocess
import threading

from . import config

_lock = threading.Lock()


def _git(*args: str, env_user: dict | None = None) -> subprocess.CompletedProcess:
    cmd = ["git", "-C", str(config.LIB_DIR)]
    if env_user:
        cmd += ["-c", f"user.name={env_user['full_name']}", "-c", f"user.email={env_user['email']}"]
    return subprocess.run(cmd + list(args), capture_output=True, text=True)


def init() -> None:
    if not (config.LIB_DIR / ".git").exists():
        subprocess.run(["git", "init", "-q", str(config.LIB_DIR)], check=False)
        _git("config", "core.autocrlf", "false")
        (config.LIB_DIR / ".gitattributes").write_text("*.SchLib binary\n*.PcbLib binary\n*.DbLib text eol=crlf\n")
    _git("config", "--global", "--add", "safe.directory", str(config.LIB_DIR))


def commit(message: str, user: dict) -> None:
    with _lock:
        _git("add", "-A")
        st = _git("status", "--porcelain")
        if not st.stdout.strip():
            return
        r = _git("commit", "-q", "-m", message, env_user=user)
        if r.returncode != 0:
            print("git commit:", r.stderr.strip())
