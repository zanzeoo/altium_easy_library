"""Comptes locaux : mots de passe (scrypt), session par cookie signé, contrôle des rôles."""
import base64
import hashlib
import hmac
import os
import re
import unicodedata

from fastapi import Depends, HTTPException, Request
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from . import config, db

COOKIE = "altlib_session"
_ser = URLSafeTimedSerializer(config.SECRET_KEY, salt="session")
PALETTE = ["#3d5a99", "#b0602a", "#8a4b9c", "#2f7a6a", "#a63d5a", "#5a7a2f", "#2f5f8a", "#8a6a2f"]


def hash_password(pw: str) -> str:
    salt = os.urandom(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return "scrypt$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(h).decode()


def check_password(pw: str, stored: str) -> bool:
    try:
        _, s, h = stored.split("$")
        calc = hashlib.scrypt(pw.encode(), salt=base64.b64decode(s), n=2 ** 14, r=8, p=1, dklen=32)
        return hmac.compare_digest(calc, base64.b64decode(h))
    except Exception:
        return False


def make_cookie(user_id: str) -> str:
    return _ser.dumps({"u": user_id})


def user_from_request(request: Request) -> dict | None:
    tok = request.cookies.get(COOKIE)
    if not tok:
        return None
    try:
        data = _ser.loads(tok, max_age=config.SESSION_DAYS * 86400)
    except (BadSignature, SignatureExpired):
        return None
    u = db.one("SELECT * FROM users WHERE id=%s AND active", (data.get("u"),))
    return u


def current_user(request: Request) -> dict:
    u = user_from_request(request)
    if not u:
        raise HTTPException(401, "login_required")
    return u


def is_librarian(u: dict) -> bool:
    return u["role"] in ("librarian", "admin")


def require_librarian(u: dict = Depends(current_user)) -> dict:
    if not is_librarian(u):
        raise HTTPException(403, "forbidden")
    return u


def require_admin(u: dict = Depends(current_user)) -> dict:
    if u["role"] != "admin":
        raise HTTPException(403, "forbidden")
    return u


def short_name(full: str) -> str:
    parts = full.split()
    if len(parts) >= 2:
        return f"{parts[0][0]}. {' '.join(parts[1:])}"
    return full


def new_user_id(conn, email: str) -> str:
    base = unicodedata.normalize("NFD", email.split("@")[0].lower())
    base = re.sub(r"[^a-z0-9.]+", "", "".join(c for c in base if unicodedata.category(c) != "Mn")) or "user"
    cand, i = base, 2
    while conn.execute("SELECT 1 FROM users WHERE id=%s", (cand,)).fetchone():
        cand, i = f"{base}{i}", i + 1
    return cand


def ensure_admin() -> None:
    with db.tx() as c:
        if c.execute("SELECT count(*) AS n FROM users").fetchone()["n"]:
            return
        if not config.ADMIN_PASSWORD:
            print("!! Aucun utilisateur et ADMIN_PASSWORD vide : définissez ADMIN_EMAIL / ADMIN_PASSWORD dans .env")
            return
        uid = new_user_id(c, config.ADMIN_EMAIL)
        c.execute("INSERT INTO users(id, full_name, short_name, email, role, titles, color, password_hash) "
                  "VALUES (%s,%s,%s,%s,'admin',%s,%s,%s)",
                  (uid, config.ADMIN_NAME, short_name(config.ADMIN_NAME), config.ADMIN_EMAIL.lower(),
                   ["validator"], PALETTE[0], hash_password(config.ADMIN_PASSWORD)))
        print(f"Administrateur créé : {config.ADMIN_EMAIL}")


def user_out(u: dict) -> dict:
    return {"id": u["id"], "full": u["full_name"], "name": u["short_name"], "email": u["email"],
            "role": u["role"], "titles": list(u["titles"] or []), "color": u["color"], "active": u["active"]}
