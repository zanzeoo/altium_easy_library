"""Règles métier partagées : lecture des formulaires, sérialisation, historique, notifications."""
from datetime import datetime

from fastapi import HTTPException

from . import db, values

DISTRIS = {"Mouser", "DigiKey", "Farnell", "LCSC", "RS", "other"}


def iso(v):
    return v.isoformat() if isinstance(v, datetime) else v


def part_out(r: dict, hist: list | None = None) -> dict:
    out = {
        "id": r["id"], "cat": r["cat"], "mpn": r["mpn"], "mfr": r["mfr"], "desc": r["description"],
        "comment": r["comment"], "pkg": r["package"], "mount": r["mount"], "t": [r["tmin"], r["tmax"]],
        "st": r["status"], "lc": r["lifecycle"], "p": r["params"] or {}, "sup": r["suppliers"] or [],
        "alt": r["alternates"] or [], "by": r["created_by"], "val": r["validated_by"],
        "date": iso(r["created_at"]), "vdate": iso(r["validated_at"]), "rev": iso(r["updated_at"]),
        "sym": {"ref": r["symbol_ref"], "file": r["symbol_file"], "pins": r["pins"]},
        "fp": {"ref": r["footprint_ref"] or "—", "file": r["footprint_file"], "pads": r["pads"], "has3d": r["has_3d"]},
        "ds": {"name": r["datasheet_name"] or "datasheet.pdf"} if r["datasheet_sha"] else ({"url": r["datasheet_url"]} if r["datasheet_url"] else None),
        "pending": r["pending"],
        "arc": {"by": r["archived_by"], "at": iso(r["archived_at"]), "reason": r["archive_reason"] or ""} if r["status"] == "archived" else None,
    }
    if hist is not None:
        out["hist"] = [{"a": h["action"], "u": h["user_id"], "at": iso(h["at"]), **(h["data"] or {})} for h in hist]
    return out


def get_part(conn, pid: str, lock: bool = False) -> dict:
    r = conn.execute("SELECT * FROM parts WHERE id=%s" + (" FOR UPDATE" if lock else ""), (pid,)).fetchone()
    if not r:
        raise HTTPException(404, "not_found")
    return r


def category(conn, cid: str) -> dict:
    c = conn.execute("SELECT * FROM categories WHERE id=%s", (cid,)).fetchone()
    if not c:
        raise HTTPException(422, {"errors": [{"field": "cat", "code": "required"}]})
    return c


def parse_form(conn, form: dict, exclude_id: str | None = None) -> dict:
    """Valide les champs saisis et renvoie les valeurs normalisées (erreurs → 422)."""
    errors = []
    g = lambda k: str(form.get(k) or "").strip()
    cat = conn.execute("SELECT * FROM categories WHERE id=%s", (g("cat"),)).fetchone()
    if not cat:
        errors.append({"field": "cat", "code": "required"})
    data = {"cat": g("cat"), "mpn": g("mpn"), "mfr": g("mfr"), "desc": g("desc"), "comment": g("comment"), "pkg": g("pkg")}
    for k in ("mpn", "mfr", "desc", "comment", "pkg"):
        if not data[k]:
            errors.append({"field": k, "code": "required"})
    if data["mpn"]:
        dup = conn.execute("SELECT id FROM parts WHERE lower(mpn)=lower(%s) AND id<>%s", (data["mpn"], exclude_id or "")).fetchone()
        if dup:
            errors.append({"field": "mpn", "code": "duplicate", "id": dup["id"]})
    data["mount"] = form.get("mount") if form.get("mount") in ("smd", "tht") else "smd"
    data["lc"] = form.get("lc") if form.get("lc") in ("active", "nrnd", "obsolete") else "active"
    t = []
    for k in ("tmin", "tmax"):
        v = form.get(k)
        try:
            t.append(None if v in (None, "") else float(str(v).replace(",", ".")))
        except ValueError:
            errors.append({"field": k, "code": "bad_value"})
            t.append(None)
    if t[0] is not None and t[1] is not None and t[0] >= t[1]:
        errors.append({"field": "tmin", "code": "temp_range"})
    data["t"] = t
    p, disp = {}, {}
    if cat:
        raw = form.get("p") or {}
        for d in cat["params"]:
            try:
                v = values.parse_param(d, raw.get(d["k"]))
            except values.BadValue:
                errors.append({"field": "p." + d["k"], "code": "bad_value"})
                v = None
            p[d["k"]] = v
            if v is not None:
                disp[d["k"]] = values.fmt_param(d, v)
    data["p"], data["disp"] = p, disp
    sup = []
    for row in form.get("sup") or []:
        if isinstance(row, (list, tuple)) and len(row) == 2 and str(row[1]).strip():
            name = row[0] if row[0] in DISTRIS else "other"
            sup.append([name, str(row[1]).strip()])
    data["sup"] = sup[:10]
    alt = []
    for row in form.get("alt") or []:
        if isinstance(row, (list, tuple)) and len(row) == 2 and str(row[1]).strip():
            alt.append([str(row[0]).strip(), str(row[1]).strip()])
    data["alt"] = alt[:5]
    data["dsUrl"] = g("dsUrl") if g("dsUrl").lower().startswith(("http://", "https://")) else ""
    if errors:
        raise HTTPException(422, {"errors": errors})
    return data


def data_for_client(d: dict) -> dict:
    """Forme des données « proposées » telle que l'interface l'utilise pour afficher les différences."""
    return {"cat": d["cat"], "mpn": d["mpn"], "mfr": d["mfr"], "desc": d["desc"], "comment": d["comment"], "pkg": d["pkg"],
            "mount": d["mount"], "t": d["t"], "lc": d["lc"], "p": d["p"], "sup": d["sup"], "alt": d.get("alt", []),
            "disp": d.get("disp", {}), "dsUrl": d.get("dsUrl", "")}


def apply_data(conn, pid: str, d: dict) -> None:
    conn.execute("""UPDATE parts SET cat=%s, mpn=%s, mfr=%s, description=%s, comment=%s, package=%s, mount=%s,
                    tmin=%s, tmax=%s, lifecycle=%s, params=%s, params_display=%s, suppliers=%s, alternates=%s,
                    datasheet_url=CASE WHEN %s <> '' THEN %s ELSE datasheet_url END, updated_at=now() WHERE id=%s""",
                 (d["cat"], d["mpn"], d["mfr"], d["desc"], d["comment"], d["pkg"], d["mount"], d["t"][0], d["t"][1],
                  d["lc"], db.J(d["p"]), db.J(d.get("disp", {})), db.J(d["sup"]), db.J(d.get("alt", [])),
                  d.get("dsUrl", ""), d.get("dsUrl", ""), pid))


def add_history(conn, pid: str, action: str, user_id: str, **data) -> None:
    conn.execute("INSERT INTO history(part_id, action, user_id, data) VALUES (%s,%s,%s,%s)", (pid, action, user_id, db.J(data)))


def notify(conn, frm: str, to: str, pid: str, mpn: str, kind: str, msg: str = "") -> None:
    if frm == to:
        return
    conn.execute("INSERT INTO notifications(from_user, to_user, part_id, part_mpn, kind, message) VALUES (%s,%s,%s,%s,%s,%s)",
                 (frm, to, pid, mpn, kind, msg[:2000]))


def check_validator(conn, uid: str) -> None:
    u = conn.execute("SELECT role FROM users WHERE id=%s AND active", (uid,)).fetchone()
    if not u or u["role"] not in ("librarian", "admin"):
        raise HTTPException(422, {"errors": [{"field": "ask", "code": "cannot_validate"}]})
