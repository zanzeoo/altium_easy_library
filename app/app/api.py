"""Routes HTTP de l'application."""
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, Body, Depends, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse

from . import altium_ops as ao
from . import auth, config, db, gitrepo, service as svc, values, views
from .auth import current_user, is_librarian, require_admin, require_librarian

r = APIRouter()
LIBROOT = config.LIB_DIR / "lib"
PENDING = config.WORK_DIR / "pending"


def now():
    return datetime.now(timezone.utc).isoformat()


def rel(p: Path) -> str:
    return p.relative_to(config.LIB_DIR).as_posix()


def err(code: str, status: int = 409, **extra):
    raise HTTPException(status, {"errors": [{"code": code, **extra}]})


# ================================================================== session

@r.post("/api/login")
def login(response: Response, body: dict = Body(...)):
    u = db.one("SELECT * FROM users WHERE lower(email)=lower(%s) AND active", (str(body.get("email", "")).strip(),))
    if not u or not auth.check_password(str(body.get("password", "")), u["password_hash"]):
        err("bad_login", 401)
    response.set_cookie(auth.COOKIE, auth.make_cookie(u["id"]), max_age=config.SESSION_DAYS * 86400,
                        httponly=True, samesite="lax", secure=config.COOKIE_SECURE)
    return auth.user_out(u)


@r.post("/api/logout")
def logout(response: Response):
    response.delete_cookie(auth.COOKIE)
    return {"ok": True}


@r.post("/api/me/password")
def change_password(body: dict = Body(...), u=Depends(current_user)):
    if not auth.check_password(str(body.get("old", "")), u["password_hash"]):
        err("bad_password", 422)
    new = str(body.get("new", ""))
    if len(new) < 8:
        err("password_short", 422)
    db.one("UPDATE users SET password_hash=%s WHERE id=%s RETURNING id", (auth.hash_password(new), u["id"]))
    return {"ok": True}


def notifs_for(uid: str) -> list:
    rows = db.all_("SELECT * FROM notifications WHERE to_user=%s ORDER BY at DESC LIMIT 200", (uid,))
    return [{"id": n["id"], "from": n["from_user"], "to": n["to_user"], "part": n["part_id"], "mpn": n["part_mpn"],
             "kind": n["kind"], "msg": n["message"], "at": svc.iso(n["at"]), "read": n["read"]} for n in rows]


def cats_out() -> tuple[list, list]:
    groups = [{"id": g["id"], "labels": g["labels"], "cats": []} for g in db.all_("SELECT * FROM groups ORDER BY sort, id")]
    by = {g["id"]: g for g in groups}
    cats = []
    for c in db.all_("SELECT * FROM categories ORDER BY sort, created_at, id"):
        co = {"id": c["id"], "group": c["group_id"], "labels": c["labels"], "params": c["params"], "view": c["view_name"]}
        cats.append(co)
        if c["group_id"] in by:
            by[c["group_id"]]["cats"].append(c["id"])
    return groups, cats


@r.get("/api/bootstrap")
def bootstrap(u=Depends(current_user)):
    groups, cats = cats_out()
    parts = [svc.part_out(p) for p in db.all_("SELECT * FROM parts ORDER BY id")]
    users = [auth.user_out(x) for x in db.all_("SELECT * FROM users ORDER BY full_name")]
    return {"me": auth.user_out(u), "users": users, "groups": groups, "categories": cats, "parts": parts,
            "notifications": notifs_for(u["id"]),
            "settings": {"mouser": bool(config.MOUSER_API_KEY), "share": config.SHARE_UNC, "publicUrl": config.PUBLIC_URL}}


@r.get("/api/notifications")
def notifications(u=Depends(current_user)):
    return notifs_for(u["id"])


@r.post("/api/notifications/read")
def notifications_read(body: dict = Body(...), u=Depends(current_user)):
    with db.tx() as c:
        if body.get("all"):
            c.execute("UPDATE notifications SET read=true WHERE to_user=%s", (u["id"],))
        else:
            ids = [int(i) for i in body.get("ids", [])]
            c.execute("UPDATE notifications SET read=true WHERE to_user=%s AND id = ANY(%s)", (u["id"], ids))
    return {"ok": True}


# ================================================================== utilisateurs

@r.post("/api/users")
def user_create(body: dict = Body(...), admin=Depends(require_admin)):
    full, email = str(body.get("full", "")).strip(), str(body.get("email", "")).strip().lower()
    role, pw = body.get("role", "designer"), str(body.get("password", ""))
    if not full or "@" not in email:
        err("required", 422)
    if role not in ("admin", "librarian", "designer"):
        err("bad_role", 422)
    if len(pw) < 8:
        err("password_short", 422)
    titles = [t for t in body.get("titles", []) if t in ("author", "validator", "quality", "purchasing")]
    with db.tx() as c:
        if c.execute("SELECT 1 FROM users WHERE lower(email)=%s", (email,)).fetchone():
            err("email_taken", 422)
        uid = auth.new_user_id(c, email)
        n = c.execute("SELECT count(*) AS n FROM users").fetchone()["n"]
        c.execute("INSERT INTO users(id, full_name, short_name, email, role, titles, color, password_hash) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                  (uid, full, auth.short_name(full), email, role, titles, auth.PALETTE[n % len(auth.PALETTE)], auth.hash_password(pw)))
        return auth.user_out(c.execute("SELECT * FROM users WHERE id=%s", (uid,)).fetchone())


@r.put("/api/users/{uid}")
def user_update(uid: str, body: dict = Body(...), admin=Depends(require_admin)):
    with db.tx() as c:
        u = c.execute("SELECT * FROM users WHERE id=%s", (uid,)).fetchone()
        if not u:
            err("not_found", 404)
        full = str(body.get("full", u["full_name"])).strip() or u["full_name"]
        email = str(body.get("email", u["email"])).strip().lower()
        role = body.get("role", u["role"])
        if role not in ("admin", "librarian", "designer"):
            err("bad_role", 422)
        if uid == admin["id"] and role != "admin":
            err("self_demote", 422)
        active = bool(body.get("active", u["active"]))
        if uid == admin["id"] and not active:
            err("self_disable", 422)
        titles = [t for t in body.get("titles", u["titles"]) if t in ("author", "validator", "quality", "purchasing")]
        if c.execute("SELECT 1 FROM users WHERE lower(email)=%s AND id<>%s", (email, uid)).fetchone():
            err("email_taken", 422)
        c.execute("UPDATE users SET full_name=%s, short_name=%s, email=%s, role=%s, titles=%s, active=%s WHERE id=%s",
                  (full, auth.short_name(full), email, role, titles, active, uid))
        pw = str(body.get("password") or "")
        if pw:
            if len(pw) < 8:
                err("password_short", 422)
            c.execute("UPDATE users SET password_hash=%s WHERE id=%s", (auth.hash_password(pw), uid))
        return auth.user_out(c.execute("SELECT * FROM users WHERE id=%s", (uid,)).fetchone())


# ================================================================== catégories

@r.post("/api/categories")
def category_create(body: dict = Body(...), u=Depends(require_librarian)):
    name = str(body.get("name", "")).strip()
    if not name:
        err("required", 422)
    cid = re.sub(r"[^a-z0-9]+", "_", views._ascii(name).lower()).strip("_")
    if not cid:
        err("bad_name", 422)
    params, used = [], set()
    for p in body.get("params", []):
        lab = str(p.get("l", "")).strip()
        if not lab:
            continue
        k = re.sub(r"[^a-z0-9]+", "_", views._ascii(lab).lower()).strip("_") or "p"
        while k in used:
            k += "_"
        used.add(k)
        d = {"k": k, "labels": {"fr": lab, "en": lab}}
        if p.get("type") == "num":
            d["u"], d["si"] = str(p.get("u") or ""), 1
        elif p.get("type") == "bin":
            d["u"], d["si"] = "B", 2
        params.append(d)
    with db.tx() as c:
        for row in c.execute("SELECT id, labels FROM categories").fetchall():
            if any(views._ascii(v).lower() == views._ascii(name).lower() for v in row["labels"].values()):
                err("exists", 422)
        while c.execute("SELECT 1 FROM categories WHERE id=%s", (cid,)).fetchone():
            cid += "_"
        gid = body.get("group")
        if gid == "__new":
            gname = str(body.get("newGroup", "")).strip()
            if not gname:
                err("group_required", 422)
            gid = "g_" + (re.sub(r"[^a-z0-9]+", "_", views._ascii(gname).lower()).strip("_") or "x")
            if not c.execute("SELECT 1 FROM groups WHERE id=%s", (gid,)).fetchone():
                n = c.execute("SELECT count(*) AS n FROM groups").fetchone()["n"]
                c.execute("INSERT INTO groups(id, labels, sort) VALUES (%s,%s,%s)", (gid, db.J({"fr": gname, "en": gname}), n))
        elif not c.execute("SELECT 1 FROM groups WHERE id=%s", (gid,)).fetchone():
            err("group_required", 422)
        used_views = {x["view_name"] for x in c.execute("SELECT view_name FROM categories").fetchall()}
        vn = views.view_name_for({"fr": name, "en": name}, used_views)
        sort = c.execute("SELECT coalesce(max(sort),0)+1 AS s FROM categories").fetchone()["s"]
        c.execute("INSERT INTO categories(id, group_id, labels, params, view_name, sort, created_by) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                  (cid, gid, db.J({"fr": name, "en": name}), db.J(params), vn, sort, u["id"]))
        views.regenerate(c)
    return {"id": cid, "view": vn}


# ================================================================== composants

@r.get("/api/parts/{pid}")
def part_get(pid: str, u=Depends(current_user)):
    with db.tx() as c:
        p = svc.get_part(c, pid)
        hist = c.execute("SELECT * FROM history WHERE part_id=%s ORDER BY at, id", (pid,)).fetchall()
        return svc.part_out(p, hist)


@r.get("/api/parts/{pid}/{kind}.svg")
def part_svg(pid: str, kind: str, u=Depends(current_user)):
    if kind not in ("symbol", "footprint"):
        err("not_found", 404)
    f = ao.SVG / pid / f"{kind}.svg"
    if not f.exists():
        p = db.one("SELECT symbol_file, footprint_file FROM parts WHERE id=%s", (pid,))
        if not p:
            err("not_found", 404)
        ao.render_part_svgs(pid, config.LIB_DIR / p["symbol_file"] if p["symbol_file"] else None,
                            config.LIB_DIR / p["footprint_file"] if p["footprint_file"] else None)
    if not f.exists():
        err("not_found", 404)
    return FileResponse(f, media_type="image/svg+xml", headers={"Cache-Control": "no-cache"})


def _datasheet(pid: str):
    p = db.one("SELECT datasheet_sha, datasheet_name, datasheet_url FROM parts WHERE id=%s", (pid,))
    if not p:
        err("not_found", 404)
    if p["datasheet_sha"]:
        return FileResponse(ao.pdf_path(p["datasheet_sha"]), media_type="application/pdf",
                            headers={"Content-Disposition": f'inline; filename="{p["datasheet_name"] or "datasheet.pdf"}"'})
    if p["datasheet_url"]:
        return RedirectResponse(p["datasheet_url"])
    err("not_found", 404)


@r.get("/api/parts/{pid}/datasheet")
def part_datasheet(pid: str, u=Depends(current_user)):
    return _datasheet(pid)


@r.get("/ds/{pid}")
def public_datasheet(pid: str, request: Request):
    if not config.DATASHEETS_PUBLIC and not auth.user_from_request(request):
        return RedirectResponse("/")
    return _datasheet(pid)


# ------------------------------------------------------------------ import

def manifest_out(m: dict) -> dict:
    return {k: m[k] for k in ("sid", "files", "symbols", "footprints", "steps", "pdfs", "warnings", "candidates")}


@r.post("/api/imports")
async def import_upload(files: list[UploadFile] = File(...), u=Depends(current_user)):
    uploads, total = [], 0
    for f in files:
        data = await f.read()
        total += len(data)
        if total > config.MAX_UPLOAD_MB * 1024 * 1024:
            err("too_large", 413)
        uploads.append((f.filename or "fichier", data))
    try:
        man = ao.new_session(uploads)
    except ao.ImportError_ as e:
        err(str(e), 422)
    return manifest_out(man)


@r.get("/api/imports/{sid}/svg/{kind}/{idx}")
def import_svg(sid: str, kind: str, idx: int, u=Depends(current_user)):
    try:
        d = ao.session_dir(sid)
    except ao.ImportError_ as e:
        err(str(e), 404)
    f = d / "svg" / f"{'sym' if kind == 'sym' else 'fp'}_{int(idx)}.svg"
    if not f.exists():
        err("not_found", 404)
    return FileResponse(f, media_type="image/svg+xml")


def _store_session_pdf(c, sid: str, idx, uid: str):
    if idx is None:
        return None
    man = ao.load_manifest(sid)
    pdf = man["pdfs"][int(idx)]
    sha, size = ao.store_pdf(ao.session_dir(sid) / pdf["path"])
    c.execute("INSERT INTO datasheets(sha, filename, size, uploaded_by) VALUES (%s,%s,%s,%s) ON CONFLICT (sha) DO NOTHING",
              (sha, pdf["name"], size, uid))
    return {"sha": sha, "name": pdf["name"]}


@r.post("/api/imports/{sid}/commit")
def import_commit(sid: str, body: dict = Body(...), u=Depends(current_user)):
    cand = body.get("cand") or {}
    if cand.get("sym") is None or cand.get("fp") is None:
        err("symbol_footprint_required", 422)
    try:
        ao.session_dir(sid)
    except ao.ImportError_ as e:
        err(str(e), 422)
    dest = None
    try:
        with db.tx() as c:
            data = svc.parse_form(c, body.get("form") or {})
            ask = body.get("ask")
            if ask:
                svc.check_validator(c, ask)
            pid = "LIB-%06d" % c.execute("SELECT nextval('part_seq') AS n").fetchone()["n"]
            dest = LIBROOT / data["cat"] / pid
            files = ao.write_part_files(pid, sid, int(cand["sym"]), int(cand["fp"]),
                                        None if cand.get("step") is None else int(cand["step"]), dest)
            ds = _store_session_pdf(c, sid, cand.get("pdf"), u["id"])
            c.execute("""INSERT INTO parts(id, cat, mpn, mfr, description, comment, package, mount, tmin, tmax, lifecycle,
                         params, params_display, suppliers, alternates, status, symbol_ref, symbol_file, footprint_ref, footprint_file,
                         pins, pads, has_3d, datasheet_sha, datasheet_name, datasheet_url, created_by)
                         VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'draft',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                      (pid, data["cat"], data["mpn"], data["mfr"], data["desc"], data["comment"], data["pkg"], data["mount"],
                       data["t"][0], data["t"][1], data["lc"], db.J(data["p"]), db.J(data["disp"]), db.J(data["sup"]), db.J(data["alt"]),
                       files["symbol_ref"], rel(dest / files["symbol_name"]), files["footprint_ref"], rel(dest / files["footprint_name"]),
                       files["pins"], files["pads"], files["has_3d"], ds and ds["sha"], ds and ds["name"], data["dsUrl"] or None, u["id"]))
            if ask:
                svc.add_history(c, pid, "ask", u["id"], to=[ask])
                svc.notify(c, u["id"], ask, pid, data["mpn"], "validate")
    except HTTPException:
        if dest and dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        raise
    except Exception as e:
        if dest and dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        print("import:", repr(e))
        err("import_failed", 500, detail=str(e)[:300])
    ao.render_part_svgs(pid, dest / files["symbol_name"], dest / files["footprint_name"])
    gitrepo.commit(f"{pid} ajouté (brouillon) : {data['mpn']}", u)
    return part_get(pid, u)


# ------------------------------------------------------------------ modification

def _changes(r: dict, d: dict) -> int:
    n = sum(1 for a, b in (("cat", "cat"), ("mpn", "mpn"), ("mfr", "mfr"), ("description", "desc"), ("comment", "comment"),
                           ("package", "pkg"), ("mount", "mount"), ("lifecycle", "lc")) if (r[a] or "") != (d[b] or ""))
    n += (r["tmin"] != d["t"][0]) + (r["tmax"] != d["t"][1])
    old = r["params"] or {}
    n += sum(1 for k in set(old) | set(d["p"]) if old.get(k) != d["p"].get(k))
    n += (r["suppliers"] or []) != d["sup"]
    n += (r["alternates"] or []) != d["alt"]
    n += bool(d["dsUrl"]) and d["dsUrl"] != (r["datasheet_url"] or "")
    return n


def _move_dir(c, pid: str, r: dict, new_cat: str) -> None:
    """Déplace les fichiers d'un composant quand sa catégorie change."""
    if r["cat"] == new_cat:
        return
    src, dst = LIBROOT / r["cat"] / pid, LIBROOT / new_cat / pid
    if src.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
    c.execute("UPDATE parts SET symbol_file=replace(symbol_file, %s, %s), footprint_file=replace(footprint_file, %s, %s) WHERE id=%s",
              (f"lib/{r['cat']}/{pid}/", f"lib/{new_cat}/{pid}/", f"lib/{r['cat']}/{pid}/", f"lib/{new_cat}/{pid}/", pid))


def _install_files(c, pid: str, cat: str, files: dict, src_dir: Path | None) -> None:
    """Remplace symbole et/ou empreinte dans le dossier du composant."""
    dest = LIBROOT / cat / pid
    dest.mkdir(parents=True, exist_ok=True)
    cur = c.execute("SELECT symbol_file, footprint_file FROM parts WHERE id=%s", (pid,)).fetchone()
    if files.get("symbol_name"):
        if src_dir:
            shutil.copy2(src_dir / files["symbol_name"], dest / files["symbol_name"])
        c.execute("UPDATE parts SET symbol_ref=%s, symbol_file=%s, pins=%s WHERE id=%s",
                  (files["symbol_ref"], rel(dest / files["symbol_name"]), files["pins"], pid))
    if files.get("footprint_name"):
        old = cur["footprint_file"]
        if src_dir:
            shutil.copy2(src_dir / files["footprint_name"], dest / files["footprint_name"])
        if old and Path(old).name != files["footprint_name"]:
            (config.LIB_DIR / old).unlink(missing_ok=True)
        c.execute("UPDATE parts SET footprint_ref=%s, footprint_file=%s, pads=%s, has_3d=%s WHERE id=%s",
                  (files["footprint_ref"], rel(dest / files["footprint_name"]), files["pads"], files["has_3d"], pid))


@r.put("/api/parts/{pid}")
def part_update(pid: str, body: dict = Body(...), u=Depends(current_user)):
    rep = body.get("replace") or None
    tmp = None
    try:
        with db.tx() as c:
            r0 = svc.get_part(c, pid, lock=True)
            if not (u["id"] == r0["created_by"] or is_librarian(u)):
                err("forbidden", 403)
            if r0["status"] == "archived":
                err("archived")
            if r0["pending"]:
                err("pending_exists")
            data = svc.parse_form(c, body.get("form") or {}, exclude_id=pid)
            ask = body.get("ask")
            if ask:
                svc.check_validator(c, ask)
            n = _changes(r0, data)
            files, ds = {}, None
            if rep and rep.get("sid"):
                ao.session_dir(rep["sid"])
                tmp = PENDING / pid / ("draft" if r0["status"] == "draft" else "proposal")
                shutil.rmtree(tmp, ignore_errors=True)
                files = ao.write_part_files(pid, rep["sid"], rep.get("sym"), rep.get("fp"), rep.get("step"), tmp)
                ds = _store_session_pdf(c, rep["sid"], rep.get("pdf"), u["id"])
                n += bool(files.get("symbol_name")) + bool(files.get("footprint_name")) + bool(ds)
            if n == 0:
                err("no_change", 422)
            at = now()
            if r0["status"] == "draft":
                _move_dir(c, pid, r0, data["cat"])
                svc.apply_data(c, pid, data)
                if files:
                    _install_files(c, pid, data["cat"], files, tmp)
                if ds:
                    c.execute("UPDATE parts SET datasheet_sha=%s, datasheet_name=%s WHERE id=%s", (ds["sha"], ds["name"], pid))
                svc.add_history(c, pid, "edit", u["id"], n=n)
                if ask:
                    svc.add_history(c, pid, "ask", u["id"], to=[ask])
                    svc.notify(c, u["id"], ask, pid, data["mpn"], "validate")
                kind = "edited"
            else:
                pending = {"by": u["id"], "at": at, "data": svc.data_for_client(data),
                           "rep": {"sym": bool(files.get("symbol_name")), "fp": bool(files.get("footprint_name")),
                                   "fpRef": files.get("footprint_ref"), "ds": bool(ds)},
                           "files": files, "ds": ds}
                c.execute("UPDATE parts SET pending=%s, updated_at=now() WHERE id=%s", (db.J(pending), pid))
                svc.add_history(c, pid, "propose", u["id"], n=n)
                if ask:
                    svc.add_history(c, pid, "ask", u["id"], to=[ask])
                    svc.notify(c, u["id"], ask, pid, data["mpn"], "change")
                kind = "proposed"
    except HTTPException:
        raise
    except ao.ImportError_ as e:
        err(str(e), 422)
    if kind == "edited":
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)
        p = db.one("SELECT symbol_file, footprint_file FROM parts WHERE id=%s", (pid,))
        shutil.rmtree(ao.SVG / pid, ignore_errors=True)
        ao.render_part_svgs(pid, config.LIB_DIR / p["symbol_file"], config.LIB_DIR / p["footprint_file"])
        gitrepo.commit(f"{pid} modifié (brouillon)", u)
    return part_get(pid, u)


@r.post("/api/parts/{pid}/pending/{action}")
def pending_decide(pid: str, action: str, u=Depends(require_librarian)):
    if action not in ("accept", "reject"):
        err("not_found", 404)
    with db.tx() as c:
        r0 = svc.get_part(c, pid, lock=True)
        pd = r0["pending"]
        if not pd:
            err("no_pending")
        if action == "accept":
            d = dict(pd["data"])
            _move_dir(c, pid, r0, d["cat"])
            svc.apply_data(c, pid, d)
            if pd.get("files"):
                _install_files(c, pid, d["cat"], pd["files"], PENDING / pid / "proposal")
            if pd.get("ds"):
                c.execute("UPDATE parts SET datasheet_sha=%s, datasheet_name=%s WHERE id=%s", (pd["ds"]["sha"], pd["ds"]["name"], pid))
            svc.add_history(c, pid, "applied", u["id"])
            svc.notify(c, u["id"], pd["by"], pid, d["mpn"], "changeOk")
        else:
            svc.add_history(c, pid, "rejected", u["id"])
            svc.notify(c, u["id"], pd["by"], pid, r0["mpn"], "changeKo")
        c.execute("UPDATE parts SET pending=NULL, updated_at=now() WHERE id=%s", (pid,))
        c.execute("UPDATE notifications SET read=true WHERE part_id=%s AND kind='change'", (pid,))
    shutil.rmtree(PENDING / pid, ignore_errors=True)
    if action == "accept":
        p = db.one("SELECT symbol_file, footprint_file FROM parts WHERE id=%s", (pid,))
        shutil.rmtree(ao.SVG / pid, ignore_errors=True)
        ao.render_part_svgs(pid, config.LIB_DIR / p["symbol_file"], config.LIB_DIR / p["footprint_file"])
        gitrepo.commit(f"{pid} : modification acceptée", u)
    return part_get(pid, u)


@r.get("/api/parts/{pid}/pending/{kind}.svg")
def pending_svg(pid: str, kind: str, u=Depends(current_user)):
    p = db.one("SELECT pending FROM parts WHERE id=%s", (pid,))
    if not p or not p["pending"] or kind not in ("symbol", "footprint"):
        err("not_found", 404)
    files, d = p["pending"].get("files") or {}, PENDING / pid / "proposal"
    out = ao.SVG / pid / "pending"
    f = out / f"{kind}.svg"
    if not f.exists():
        ao.render_part_svgs(pid + "/pending", d / files["symbol_name"] if files.get("symbol_name") else None,
                            d / files["footprint_name"] if files.get("footprint_name") else None)
    if not f.exists():
        err("not_found", 404)
    return FileResponse(f, media_type="image/svg+xml", headers={"Cache-Control": "no-cache"})


# ------------------------------------------------------------------ statut

@r.post("/api/parts/{pid}/validate")
def part_validate(pid: str, u=Depends(require_librarian)):
    with db.tx() as c:
        r0 = svc.get_part(c, pid, lock=True)
        if r0["status"] != "draft":
            err("not_draft")
        c.execute("UPDATE parts SET status='valid', validated_by=%s, validated_at=now(), updated_at=now() WHERE id=%s", (u["id"], pid))
        reqs = c.execute("SELECT DISTINCT from_user FROM notifications WHERE part_id=%s AND kind='validate'", (pid,)).fetchall()
        c.execute("UPDATE notifications SET read=true WHERE part_id=%s AND kind='validate'", (pid,))
        tell = {x["from_user"] for x in reqs} | {r0["created_by"]}
        tell.discard(u["id"])
        for t in tell:
            svc.notify(c, u["id"], t, pid, r0["mpn"], "validated")
    return {"part": part_get(pid, u), "told": sorted(tell)}


@r.post("/api/parts/{pid}/archive")
def part_archive(pid: str, body: dict = Body(default={}), u=Depends(require_librarian)):
    reason = str(body.get("reason", "")).strip()[:1000]
    with db.tx() as c:
        r0 = svc.get_part(c, pid, lock=True)
        if r0["status"] != "valid":
            err("not_valid")
        c.execute("UPDATE parts SET status='archived', archived_by=%s, archived_at=now(), archive_reason=%s, pending=NULL, updated_at=now() WHERE id=%s",
                  (u["id"], reason, pid))
        c.execute("UPDATE notifications SET read=true WHERE part_id=%s AND kind IN ('validate','change')", (pid,))
        svc.add_history(c, pid, "archived", u["id"], reason=reason)
        svc.notify(c, u["id"], r0["created_by"], pid, r0["mpn"], "archived", reason)
    shutil.rmtree(PENDING / pid, ignore_errors=True)
    return part_get(pid, u)


@r.post("/api/parts/{pid}/restore")
def part_restore(pid: str, u=Depends(require_librarian)):
    with db.tx() as c:
        r0 = svc.get_part(c, pid, lock=True)
        if r0["status"] != "archived":
            err("not_archived")
        c.execute("UPDATE parts SET status='valid', archived_by=NULL, archived_at=NULL, archive_reason=NULL, updated_at=now() WHERE id=%s", (pid,))
        svc.add_history(c, pid, "restored", u["id"])
    return part_get(pid, u)


@r.delete("/api/parts/{pid}")
def part_delete(pid: str, u=Depends(current_user)):
    with db.tx() as c:
        r0 = svc.get_part(c, pid, lock=True)
        if r0["status"] != "draft":
            err("not_draft")
        if not (u["id"] == r0["created_by"] or is_librarian(u)):
            err("forbidden", 403)
        c.execute("UPDATE notifications SET read=true WHERE part_id=%s", (pid,))
        svc.notify(c, u["id"], r0["created_by"], pid, r0["mpn"], "deleted")
        c.execute("DELETE FROM history WHERE part_id=%s", (pid,))
        c.execute("DELETE FROM parts WHERE id=%s", (pid,))
    shutil.rmtree(LIBROOT / r0["cat"] / pid, ignore_errors=True)
    shutil.rmtree(ao.SVG / pid, ignore_errors=True)
    shutil.rmtree(PENDING / pid, ignore_errors=True)
    gitrepo.commit(f"{pid} supprimé (brouillon) : {r0['mpn']}", u)
    return {"ok": True}


@r.post("/api/parts/{pid}/notify")
def part_notify(pid: str, body: dict = Body(...), u=Depends(current_user)):
    kind = body.get("kind")
    to = [t for t in body.get("to", []) if isinstance(t, str) and t != u["id"]]
    msg = str(body.get("message", "")).strip()
    if kind not in ("validate", "info") or not to:
        err("bad_request", 422)
    with db.tx() as c:
        r0 = svc.get_part(c, pid)
        if kind == "validate":
            if r0["status"] != "draft":
                err("not_draft")
            for t in to:
                svc.check_validator(c, t)
        for t in to:
            if not c.execute("SELECT 1 FROM users WHERE id=%s AND active", (t,)).fetchone():
                err("unknown_user", 422)
            svc.notify(c, u["id"], t, pid, r0["mpn"], kind, msg)
        svc.add_history(c, pid, "ask" if kind == "validate" else "info", u["id"], to=to)
    return part_get(pid, u)


# ================================================================== enrichissement et configuration

def _temp(v: str):
    m = re.search(r"([-+−]?)\s*(\d+(?:[.,]\d+)?)", v or "")
    if not m:
        return None
    x = float(m.group(2).replace(",", "."))
    return -x if m.group(1) in ("-", "−") else x


@r.get("/api/enrich")
def enrich(mpn: str, u=Depends(current_user)):
    if not config.MOUSER_API_KEY:
        err("enrich_disabled", 404)
    try:
        res = httpx.post("https://api.mouser.com/api/v1/search/partnumber", params={"apiKey": config.MOUSER_API_KEY},
                         json={"SearchByPartRequest": {"mouserPartNumber": mpn, "partSearchOptions": "Exact"}}, timeout=15)
        parts = (res.json().get("SearchResults") or {}).get("Parts") or []
    except Exception as e:
        err("enrich_failed", 502, detail=str(e)[:200])
    part = next((p for p in parts if (p.get("ManufacturerPartNumber") or "").lower() == mpn.lower()), parts[0] if parts else None)
    if not part:
        return {"found": False}
    attrs = {a.get("AttributeName"): a.get("AttributeValue") for a in part.get("ProductAttributes") or []}
    lcs = (part.get("LifecycleStatus") or "").lower()
    return {
        "found": True, "mfr": part.get("Manufacturer") or "", "desc": part.get("Description") or "",
        "dsUrl": part.get("DataSheetUrl") or "", "pkg": attrs.get("Package / Case") or attrs.get("Package/Case") or "",
        "tmin": _temp(attrs.get("Minimum Operating Temperature")), "tmax": _temp(attrs.get("Maximum Operating Temperature")),
        "lc": "obsolete" if "obsolete" in lcs else "nrnd" if "not recommended" in lcs else "active",
        "sup": [["Mouser", part.get("MouserPartNumber")]] if part.get("MouserPartNumber") else [],
        "attrs": attrs,
    }


@r.get("/api/altium")
def altium_info(u=Depends(require_librarian)):
    vs = [{"view": c["view_name"], "cat": c["id"], "labels": c["labels"]} for c in db.all_("SELECT * FROM categories ORDER BY sort, id")]
    cs = (f"Driver={{PostgreSQL Unicode(x64)}};Server={config.ODBC_HOST};Port={config.ODBC_PORT};"
          f"Database={config.DB_NAME};Uid={config.ALTIUM_RO_USER};Pwd={config.ALTIUM_RO_PASSWORD or '…'};")
    dbl = sorted(p.name for p in config.LIB_DIR.glob("*.DbLib"))
    return {"connection": cs, "share": config.SHARE_UNC, "views": vs, "roUser": config.ALTIUM_RO_USER,
            "roConfigured": bool(config.ALTIUM_RO_PASSWORD), "dblibs": dbl}


@r.post("/api/altium/dblib")
async def dblib_upload(file: UploadFile = File(...), u=Depends(require_librarian)):
    """Dépose le fichier .DbLib à la racine du partage (qui reste en lecture seule pour les postes)."""
    name = Path(file.filename or "").name
    if not name.lower().endswith(".dblib"):
        err("bad_dblib", 422)
    data = await file.read()
    if len(data) > 2 * 1024 * 1024:
        err("too_large", 413)
    target = config.LIB_DIR / ao.safe_name(name)
    if not target.name.lower().endswith(".dblib"):
        target = target.with_name(target.stem + ".DbLib")
    target.write_bytes(data)
    gitrepo.commit(f"{target.name} mis à jour", u)
    return {"name": target.name}
