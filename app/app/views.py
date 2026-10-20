"""Vues SQL lues par Altium (une par catégorie, schéma « altium ») et rôle lecture seule."""
import re
import unicodedata

from psycopg import sql

from . import config

MOUNT = {"fr": {"smd": "CMS", "tht": "Traversant"}, "en": {"smd": "SMD", "tht": "Through-hole"}}
LIFECYCLE = {"fr": {"active": "Actif", "nrnd": "NRND", "obsolete": "Obsolète"},
             "en": {"active": "Active", "nrnd": "NRND", "obsolete": "Obsolete"}}
FIXED = {
    "fr": {"pkg": "Boîtier", "mount": "Montage", "temp": "Température", "lc": "Cycle de vie",
           "by": "Ajouté par", "val": "Validé par", "cat": "Catégorie", "ds": "Datasheet"},
    "en": {"pkg": "Package", "mount": "Mounting", "temp": "Temperature", "lc": "Lifecycle",
           "by": "Added By", "val": "Approved By", "cat": "Category", "ds": "Datasheet"},
}
SUPPLIER_COLS = 3


def _ascii(s: str) -> str:
    s = unicodedata.normalize("NFD", s)
    return "".join(ch for ch in s if unicodedata.category(ch) != "Mn")


def view_name_for(labels: dict, used: set[str]) -> str:
    """Nom de table lisible et sans accents, ex. « Inductances_Ferrites »."""
    base = labels.get(config.ALTIUM_LANG) or labels.get("fr") or labels.get("en") or "Categorie"
    name = re.sub(r"[^A-Za-z0-9]+", "_", _ascii(base)).strip("_") or "Categorie"
    cand, i = name, 2
    while cand.lower() in {u.lower() for u in used}:
        cand, i = f"{name}_{i}", i + 1
    return cand


def _lit(v: str) -> sql.Literal:
    return sql.Literal(v)


def regenerate(conn) -> list[str]:
    """Recrée toutes les vues Altium à partir des définitions de catégories."""
    lang = config.ALTIUM_LANG if config.ALTIUM_LANG in FIXED else "fr"
    fx = FIXED[lang]
    cats = conn.execute("SELECT id, labels, params, view_name FROM categories ORDER BY sort, id").fetchall()
    existing = [r["table_name"] for r in conn.execute(
        "SELECT table_name FROM information_schema.views WHERE table_schema='altium'").fetchall()]
    for v in existing:
        conn.execute(sql.SQL("DROP VIEW IF EXISTS altium.{}").format(sql.Identifier(v)))

    mount_case = sql.SQL("CASE p.mount WHEN 'tht' THEN {} ELSE {} END").format(
        _lit(MOUNT[lang]["tht"]), _lit(MOUNT[lang]["smd"]))
    lc_case = sql.SQL("CASE p.lifecycle WHEN 'nrnd' THEN {} WHEN 'obsolete' THEN {} ELSE {} END").format(
        _lit(LIFECYCLE[lang]["nrnd"]), _lit(LIFECYCLE[lang]["obsolete"]), _lit(LIFECYCLE[lang]["active"]))
    temp_expr = sql.SQL(
        "CASE WHEN p.tmin IS NULL OR p.tmax IS NULL THEN '' ELSE "
        "(CASE WHEN p.tmin > 0 THEN '+' ELSE '' END) || trim(to_char(p.tmin,'FM999990.##'),'.') || '°C ~ ' || "
        "(CASE WHEN p.tmax > 0 THEN '+' ELSE '' END) || trim(to_char(p.tmax,'FM999990.##'),'.') || '°C' END")
    ds_url = sql.SQL("CASE WHEN p.datasheet_sha IS NOT NULL OR coalesce(p.datasheet_url,'') <> '' THEN {} || p.id ELSE '' END").format(
        _lit(config.PUBLIC_URL + "/ds/"))

    names = []
    for c in cats:
        cols: list[tuple[str, sql.Composable]] = [
            ("Part Number", sql.SQL("p.id")),
            ("Library Ref", sql.SQL("p.symbol_ref")),
            ("Library Path", sql.SQL("replace(p.symbol_file, '/', '\\')")),
            ("Footprint Ref", sql.SQL("p.footprint_ref")),
            ("Footprint Path", sql.SQL("replace(p.footprint_file, '/', '\\')")),
            ("Comment", sql.SQL("p.comment")),
            ("Description", sql.SQL("p.description")),
            ("Manufacturer", sql.SQL("p.mfr")),
            ("Manufacturer Part Number", sql.SQL("p.mpn")),
            ("Manufacturer 2", sql.SQL("coalesce(p.alternates->0->>0, '')")),
            ("Manufacturer Part Number 2", sql.SQL("coalesce(p.alternates->0->>1, '')")),
        ]
        for i in range(SUPPLIER_COLS):
            cols.append((f"Supplier {i + 1}", sql.SQL("coalesce(p.suppliers->{}->>0, '')").format(sql.Literal(i))))
            cols.append((f"Supplier Part Number {i + 1}", sql.SQL("coalesce(p.suppliers->{}->>1, '')").format(sql.Literal(i))))
        cols += [
            (fx["pkg"], sql.SQL("p.package")),
            (fx["mount"], mount_case),
            (fx["temp"], temp_expr),
            (fx["lc"], lc_case),
        ]
        taken = {n.lower() for n, _ in cols}
        for d in c["params"]:
            lab = d["labels"].get(lang) or d["labels"].get("fr") or d["k"]
            col = lab
            if col.lower() in taken:
                col = f"{lab} ({d['k']})"
            taken.add(col.lower())
            cols.append((col, sql.SQL("coalesce(p.params_display->>{}, '')").format(sql.Literal(d["k"]))))
        cols += [
            ("ComponentLink1Description", sql.SQL("CASE WHEN {} <> '' THEN {} ELSE '' END").format(ds_url, _lit(fx["ds"]))),
            ("ComponentLink1URL", ds_url),
            (fx["by"], sql.SQL("coalesce(ub.full_name, '')")),
            (fx["val"], sql.SQL("coalesce(uv.full_name, '')")),
        ]
        select = sql.SQL(", ").join(sql.SQL("{} AS {}").format(expr, sql.Identifier(name)) for name, expr in cols)
        q = sql.SQL(
            "CREATE VIEW altium.{} AS SELECT {} FROM parts p "
            "LEFT JOIN users ub ON ub.id = p.created_by LEFT JOIN users uv ON uv.id = p.validated_by "
            "WHERE p.cat = {} AND p.status = 'valid'"
        ).format(sql.Identifier(c["view_name"]), select, sql.Literal(c["id"]))
        conn.execute(q)
        names.append(c["view_name"])
    grant_readonly(conn)
    return names


def grant_readonly(conn) -> None:
    """Crée ou met à jour le rôle lecture seule utilisé par Altium."""
    if not config.ALTIUM_RO_PASSWORD:
        return
    role = config.ALTIUM_RO_USER
    exists = conn.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (role,)).fetchone()
    if exists:
        conn.execute(sql.SQL("ALTER ROLE {} WITH LOGIN PASSWORD {}").format(sql.Identifier(role), sql.Literal(config.ALTIUM_RO_PASSWORD)))
    else:
        conn.execute(sql.SQL("CREATE ROLE {} WITH LOGIN PASSWORD {}").format(sql.Identifier(role), sql.Literal(config.ALTIUM_RO_PASSWORD)))
    dbname = conn.execute("SELECT current_database() AS d").fetchone()["d"]
    conn.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(sql.Identifier(dbname), sql.Identifier(role)))
    conn.execute(sql.SQL("GRANT USAGE ON SCHEMA altium TO {}").format(sql.Identifier(role)))
    conn.execute(sql.SQL("GRANT SELECT ON ALL TABLES IN SCHEMA altium TO {}").format(sql.Identifier(role)))
    conn.execute(sql.SQL("ALTER ROLE {} SET search_path = altium").format(sql.Identifier(role)))
