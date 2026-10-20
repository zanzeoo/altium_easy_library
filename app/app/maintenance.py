"""Opérations de maintenance exécutées une seule fois au démarrage (suivies dans la table app_meta)."""
import shutil

from . import altium_ops as ao
from . import config, db, gitrepo

PENDING = config.WORK_DIR / "pending"


def _done(key: str) -> bool:
    return bool(db.one("SELECT 1 AS x FROM app_meta WHERE key=%s", (key,)))


def _mark(key: str, value: str) -> None:
    db.one("INSERT INTO app_meta(key, value) VALUES (%s,%s) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, at=now() RETURNING key",
           (key, value))


def fix_symbol_references() -> None:
    """Versions ≤ 2026-10-20 : la LibReference des symboles gardait le nom du fabricant,
    si bien qu'Altium ne trouvait pas le symbole indiqué par « Library Ref »."""
    key = "fix_symbol_libref_v1"
    if _done(key):
        return
    fixed, errors = 0, 0
    for p in db.all_("SELECT id, symbol_file, footprint_file FROM parts WHERE symbol_file IS NOT NULL"):
        path = config.LIB_DIR / p["symbol_file"]
        try:
            if path.exists() and ao.fix_symbol_reference(path, p["id"]):
                fixed += 1
                shutil.rmtree(ao.SVG / p["id"], ignore_errors=True)
                ao.render_part_svgs(p["id"], path, config.LIB_DIR / p["footprint_file"] if p["footprint_file"] else None)
        except Exception as e:
            errors += 1
            print(f"Réparation du symbole {p['id']} impossible : {e}")
    # Symboles de remplacement en attente de validation
    for f in PENDING.glob("*/*/*.SchLib"):
        pid = f.parent.parent.name
        try:
            if ao.fix_symbol_reference(f, pid):
                fixed += 1
        except Exception as e:
            errors += 1
            print(f"Réparation du symbole en attente {pid} impossible : {e}")
    if fixed:
        admin = db.one("SELECT * FROM users WHERE role='admin' ORDER BY created_at LIMIT 1")
        if admin:
            gitrepo.commit(f"Maintenance : référence des symboles alignée sur la référence interne ({fixed} fichier(s))", admin)
    print(f"Maintenance {key} : {fixed} symbole(s) corrigé(s), {errors} erreur(s)")
    if not errors:
        _mark(key, str(fixed))


def run_all() -> None:
    fix_symbol_references()
