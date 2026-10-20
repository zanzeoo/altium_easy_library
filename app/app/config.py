"""Configuration lue dans les variables d'environnement (voir .env.example)."""
import os
from pathlib import Path


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


DATABASE_URL = _env("DATABASE_URL", "postgresql://altium:altium@db:5432/altiumlib")
SECRET_KEY = _env("SECRET_KEY", "change-me")
COOKIE_SECURE = _env("COOKIE_SECURE", "0") == "1"
SESSION_DAYS = int(_env("SESSION_DAYS", "30"))

DATA_DIR = Path(_env("DATA_DIR", "/data"))
LIB_DIR = DATA_DIR / "lib"            # partagé en lecture seule (Samba), dépôt git
WORK_DIR = DATA_DIR / "work"          # imports en cours, fichiers en attente, cache SVG
DS_DIR = DATA_DIR / "datasheets"      # PDF, nommés par empreinte SHA-256

PUBLIC_URL = _env("PUBLIC_URL", "http://localhost:8080").rstrip("/")
SHARE_UNC = _env("SHARE_UNC", r"\\serveur\altium-lib")
DATASHEETS_PUBLIC = _env("DATASHEETS_PUBLIC", "1") == "1"

# Accès lecture seule pour Altium (ODBC)
ALTIUM_RO_USER = _env("ALTIUM_RO_USER", "altium_ro")
ALTIUM_RO_PASSWORD = _env("ALTIUM_RO_PASSWORD", "")
ODBC_HOST = _env("ODBC_HOST", "serveur")
ODBC_PORT = _env("ODBC_PORT", "5432")
DB_NAME = _env("POSTGRES_DB", "altiumlib")
ALTIUM_LANG = _env("ALTIUM_LANG", "fr")   # langue des noms de tables/colonnes vus par Altium

# Premier administrateur (créé seulement si aucun utilisateur n'existe)
ADMIN_EMAIL = _env("ADMIN_EMAIL", "admin@exemple.fr")
ADMIN_PASSWORD = _env("ADMIN_PASSWORD", "")
ADMIN_NAME = _env("ADMIN_NAME", "Administrateur")

MOUSER_API_KEY = _env("MOUSER_API_KEY", "")
MAX_UPLOAD_MB = int(_env("MAX_UPLOAD_MB", "150"))

for d in (LIB_DIR, WORK_DIR, DS_DIR, WORK_DIR / "imports", WORK_DIR / "pending", WORK_DIR / "svg"):
    d.mkdir(parents=True, exist_ok=True)
