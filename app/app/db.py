"""Accès PostgreSQL (psycopg 3 + pool), initialisation du schéma et données de départ."""
import json
from contextlib import contextmanager
from pathlib import Path

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from . import config

pool: ConnectionPool | None = None


def open_pool() -> None:
    global pool
    pool = ConnectionPool(config.DATABASE_URL, min_size=1, max_size=10,
                          kwargs={"row_factory": dict_row, "options": "-c search_path=public"}, open=True)
    pool.wait(timeout=60)


@contextmanager
def tx():
    """Connexion dans une transaction (commit automatique en sortie, rollback sur erreur)."""
    assert pool is not None
    with pool.connection() as conn:
        with conn.transaction():
            yield conn


def all_(sql: str, params=None) -> list[dict]:
    with tx() as c:
        return c.execute(sql, params).fetchall()


def one(sql: str, params=None) -> dict | None:
    with tx() as c:
        return c.execute(sql, params).fetchone()


def J(v):
    return Jsonb(v)


# ---------------------------------------------------------------- initialisation

SEED_GROUPS = ["passive", "discrete", "ic", "electromech", "mech"]
# (id, groupe, préfixe, paramètres [(k, clé de libellé ou libellé, unité, si)])
SEED_CATS = [
    ("res", "passive", [("R", "R", "Ω", 1), ("tol", "tol", None, 0), ("P", "P", "W", 1), ("V", "Vmax", "V", 1), ("tcr", "=TCR", None, 0)]),
    ("cap", "passive", [("C", "C", "F", 1), ("V", "V", "V", 1), ("diel", "diel", None, 0), ("tol", "tol", None, 0)]),
    ("ind", "passive", [("L", "L", None, 0), ("Isat", "=Isat", "A", 1), ("Irms", "=Irms", "A", 1), ("DCR", "=DCR", "Ω", 1)]),
    ("dio", "discrete", [("type", "type", None, 0), ("Vr", "=Vr", "V", 1), ("If", "=If", "A", 1), ("Vf", "=Vf", "V", 1)]),
    ("fet", "discrete", [("ch", "ch", None, 0), ("Vds", "=Vds", "V", 1), ("Id", "=Id", "A", 1), ("Rds", "=Rds(on)", "Ω", 1)]),
    ("led", "discrete", [("color", "color", None, 0), ("lambda", "=λ", "m", 1), ("Vf", "=Vf", "V", 1), ("If", "=If", "A", 1)]),
    ("mcu", "ic", [("core", "core", None, 0), ("flash", "=Flash", "B", 2), ("ram", "=RAM", "B", 2), ("f", "f", "Hz", 1), ("io", "io", None, 0)]),
    ("pwr", "ic", [("topo", "topo", None, 0), ("vin", "=Vin", None, 0), ("vout", "=Vout", None, 0), ("Iout", "=Iout", "A", 1)]),
    ("ana", "ic", [("fn", "fn", None, 0), ("ch", "chan", None, 0), ("spec", "spec", None, 0), ("sup", "sup", None, 0)]),
    ("itf", "ic", [("fn", "fn", None, 0), ("rate", "rate", None, 0), ("sup", "sup", None, 0)]),
    ("rf", "ic", [("fn", "fn", None, 0), ("band", "band", None, 0), ("pout", "=Pout", None, 0), ("sens", "sens", None, 0)]),
    ("con", "electromech", [("pitch", "pitch", "m", 1), ("pos", "pos", None, 0), ("rows", "rows", None, 0), ("orient", "orient", None, 0)]),
    ("sw", "electromech", [("type", "type", None, 0), ("force", "force", None, 0), ("rating", "rating", None, 0)]),
    ("osc", "electromech", [("f", "f", "Hz", 1), ("ppm", "ppm", None, 0), ("CL", "CL", "F", 1)]),
    ("mec", "mech", [("type", "type", None, 0), ("size", "size", None, 0)]),
]


def init_schema() -> None:
    sql = (Path(__file__).parent / "schema.sql").read_text(encoding="utf-8")
    with tx() as c:
        c.execute(sql)


def seed() -> None:
    """Groupes et catégories de départ, seulement si la base est vide."""
    from .views import view_name_for
    labels = json.loads((Path(__file__).parent / "seed_labels.json").read_text(encoding="utf-8"))
    with tx() as c:
        if c.execute("SELECT count(*) AS n FROM groups").fetchone()["n"]:
            return
        for i, g in enumerate(SEED_GROUPS):
            c.execute("INSERT INTO groups(id, labels, sort) VALUES (%s,%s,%s)", (g, J(labels["groups"][g]), i))
        used: set[str] = set()
        for i, (cid, gid, params) in enumerate(SEED_CATS):
            plist = []
            for k, lk, u, si in params:
                lab = {"fr": lk[1:], "en": lk[1:]} if lk.startswith("=") else labels["params"][lk]
                d = {"k": k, "labels": lab}
                if u:
                    d["u"] = u
                if si:
                    d["si"] = si
                plist.append(d)
            lab = labels["cats"][cid]
            vn = view_name_for(lab, used)
            used.add(vn)
            c.execute("INSERT INTO categories(id, group_id, labels, params, view_name, sort) VALUES (%s,%s,%s,%s,%s,%s)",
                      (cid, gid, J(lab), J(plist), vn, i))
