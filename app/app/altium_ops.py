"""Tout ce qui touche aux fichiers Altium : analyse des dépôts, découpage, nettoyage, rendu SVG."""
import hashlib
import json
import re
import shutil
import time
import uuid
import zipfile
from pathlib import Path

from altium_monkey import (AltiumIntLib, AltiumPcbLib, AltiumSchLib, PcbBodyProjection, PcbLayer,
                           PcbSvgRenderOptions, SchSvgRenderOptions)

from . import config

IMPORTS = config.WORK_DIR / "imports"
SVG = config.WORK_DIR / "svg"
MAX_FILES = 2000
MAX_EXTRACT = 600 * 1024 * 1024

EXT = {".schlib": "sch", ".pcblib": "pcb", ".intlib": "intlib", ".step": "3d", ".stp": "3d", ".pdf": "doc", ".zip": "zip"}

# Noms de paramètres fournisseurs reconnus (comparaison insensible à la casse)
K_MPN = ["manufacturer part number", "manufacturer_part_number", "mfr part number", "mpn", "mfr_pn", "part number", "partnumber"]
K_MFR = ["manufacturer", "manufacturer_name", "manufacturer name", "mfr"]
K_DS = ["componentlink1url", "datasheet", "datasheet link", "datasheet url", "datasheeturl"]
K_VALUE = ["value"]
DISTRI_PARAMS = {"mouser part number": "Mouser", "mouser_part_number": "Mouser", "digi-key part number": "DigiKey",
                 "digikey part number": "DigiKey", "digi-key_pn": "DigiKey", "lcsc": "LCSC", "lcsc part number": "LCSC",
                 "jlc_pn": "LCSC", "farnell part number": "Farnell", "rs part number": "RS"}
DISTRI_NAMES = {"digi-key": "DigiKey", "digikey": "DigiKey", "mouser": "Mouser", "mouser electronics": "Mouser",
                "farnell": "Farnell", "element14": "Farnell", "lcsc": "LCSC", "rs": "RS", "rs components": "RS"}


class ImportError_(Exception):
    pass


def safe_name(s: str) -> str:
    s = re.sub(r"[^A-Za-z0-9_.\-+]+", "_", s.strip()).strip("._")
    return s[:120] or "item"


# ------------------------------------------------------------------ SVG

def _sym_svg(lib: AltiumSchLib, name: str) -> str:
    return lib.symbol_to_svg(name, options=SchSvgRenderOptions(embed_bundled_fallback_fonts=True))


def _fp_svg(fp) -> str:
    return fp.to_svg(options=PcbSvgRenderOptions(include_metadata=False, show_board_outline=False, drill_hole_mode="overlay",
                                                 drill_hole_overlay_plated_color="#1a1a1a",
                                                 drill_hole_overlay_non_plated_color="#1a1a1a",
                                                 drill_hole_overlay_opacity=0.9))


def render_part_svgs(part_id: str, symbol_path: Path | None, footprint_path: Path | None) -> None:
    d = SVG / part_id
    d.mkdir(parents=True, exist_ok=True)
    try:
        if symbol_path and symbol_path.exists():
            lib = AltiumSchLib(symbol_path)
            (d / "symbol.svg").write_text(_sym_svg(lib, lib.symbols[0].name), encoding="utf-8")
    except Exception as e:  # le rendu ne doit jamais bloquer un enregistrement
        print("rendu symbole", part_id, e)
    try:
        if footprint_path and footprint_path.exists():
            pl = AltiumPcbLib.from_file(footprint_path)
            (d / "footprint.svg").write_text(_fp_svg(pl.footprints[0]), encoding="utf-8")
    except Exception as e:
        print("rendu empreinte", part_id, e)


# ------------------------------------------------------------------ sessions d'import

def cleanup_sessions(max_age_h: int = 24) -> None:
    now = time.time()
    for d in IMPORTS.iterdir():
        try:
            if d.is_dir() and now - d.stat().st_mtime > max_age_h * 3600:
                shutil.rmtree(d, ignore_errors=True)
        except FileNotFoundError:
            pass


def session_dir(sid: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{32}", sid or ""):
        raise ImportError_("bad_session")
    d = IMPORTS / sid
    if not d.exists():
        raise ImportError_("session_expired")
    return d


def load_manifest(sid: str) -> dict:
    return json.loads((session_dir(sid) / "manifest.json").read_text(encoding="utf-8"))


def _safe_extract(zf: zipfile.ZipFile, dest: Path) -> list[Path]:
    total, out = 0, []
    infos = zf.infolist()
    if len(infos) > MAX_FILES:
        raise ImportError_("zip_too_many_files")
    for info in infos:
        if info.is_dir():
            continue
        name = info.filename.replace("\\", "/")
        if name.startswith("/") or ".." in Path(name).parts:
            continue
        total += info.file_size
        if total > MAX_EXTRACT:
            raise ImportError_("zip_too_large")
        target = dest / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with zf.open(info) as src, open(target, "wb") as dst:
            shutil.copyfileobj(src, dst)
        out.append(target)
    return out


def new_session(uploads: list[tuple[str, bytes]]) -> dict:
    """Enregistre les fichiers déposés, dézippe, analyse et renvoie le manifeste."""
    cleanup_sessions()
    sid = uuid.uuid4().hex
    d = IMPORTS / sid
    (d / "x").mkdir(parents=True)
    (d / "svg").mkdir()
    files = []
    found: list[tuple[Path, str]] = []

    def register(path: Path, origin: str):
        k = EXT.get(path.suffix.lower(), "bad")
        files.append({"name": path.name, "size": path.stat().st_size, "kind": k, "from": origin})
        if k == "zip":
            try:
                with zipfile.ZipFile(path) as zf:
                    sub = d / "x" / safe_name(path.stem + "_" + uuid.uuid4().hex[:6])
                    for p in _safe_extract(zf, sub):
                        register(p, path.name)
            except zipfile.BadZipFile:
                files[-1]["kind"] = "bad"
        elif k != "bad":
            found.append((path, k))

    for name, data in uploads:
        p = d / "x" / safe_name(Path(name).name)
        if p.exists():
            p = p.with_name(p.stem + "_" + uuid.uuid4().hex[:4] + p.suffix)
        p.write_bytes(data)
        register(p, "")

    man = {"sid": sid, "files": files, "symbols": [], "footprints": [], "steps": [], "pdfs": [], "warnings": [], "candidates": []}

    # IntLib → sources SchLib / PcbLib
    for path, k in list(found):
        if k != "intlib":
            continue
        try:
            with AltiumIntLib(path) as il:
                if il.component_parse_error:
                    man["warnings"].append({"code": "intlib_meta", "file": path.name})
                res = il.extract_sources(d / "x" / (safe_name(path.stem) + "_intlib"))
                for s in res.sources:
                    if s.output_path is None:
                        continue
                    kk = "sch" if s.kind.lower() == "schlib" else "pcb" if s.kind.lower() == "pcblib" else None
                    if kk:
                        found.append((Path(s.output_path), kk))
                        files.append({"name": Path(s.output_path).name, "size": Path(s.output_path).stat().st_size, "kind": kk, "from": path.name})
        except Exception as e:
            man["warnings"].append({"code": "intlib_error", "file": path.name, "detail": str(e)[:200]})

    for path, k in found:
        rel = str(path.relative_to(d))
        if k == "sch":
            try:
                lib = AltiumSchLib(path)
                inv = list(lib.asset_inventory().by_kind("sch_symbol"))
                for n, item in enumerate(inv):
                    sym = next((s for s in lib.symbols if s.name == item.name), None)
                    if sym is None:
                        continue
                    idx = len(man["symbols"])
                    params = {}
                    for prm in sym.parameters:
                        nm, tx = getattr(prm, "name", None), getattr(prm, "text", None)
                        if nm and tx not in (None, "", "*"):
                            params[str(nm)] = str(tx)
                    impls = sorted(sym.implementations, key=lambda im: not getattr(im, "is_current", False))
                    fps = [im.model_name for im in impls if str(getattr(im, "model_type", "")).upper() == "PCBLIB" and im.model_name]
                    man["symbols"].append({
                        "idx": idx, "lib": rel, "inv": n, "name": sym.name, "desc": sym.description or "",
                        "pins": len(sym.pins), "pin_ids": sorted({str(p.designator) for p in sym.pins if str(p.designator)}),
                        "params": params, "fps": fps, "extractable": bool(item.can_extract)})
                    try:
                        (d / "svg" / f"sym_{idx}.svg").write_text(_sym_svg(lib, sym.name), encoding="utf-8")
                    except Exception as e:
                        man["warnings"].append({"code": "svg_symbol", "name": sym.name, "detail": str(e)[:200]})
            except Exception as e:
                man["warnings"].append({"code": "schlib_error", "file": path.name, "detail": str(e)[:200]})
        elif k == "pcb":
            try:
                pl = AltiumPcbLib.from_file(path)
                inv = list(pl.asset_inventory().by_kind("pcb_footprint"))
                for n, item in enumerate(inv):
                    fp = next((f for f in pl.footprints if f.name == item.name), None)
                    if fp is None:
                        continue
                    idx = len(man["footprints"])
                    pads = [str(p.designator) for p in fp.pads]
                    man["footprints"].append({
                        "idx": idx, "lib": rel, "inv": n, "name": fp.name, "pads": len([p for p in pads if p]),
                        "pad_ids": sorted({p for p in pads if p}), "has3d": len(fp.component_bodies) > 0,
                        "extractable": bool(item.can_extract)})
                    try:
                        (d / "svg" / f"fp_{idx}.svg").write_text(_fp_svg(fp), encoding="utf-8")
                    except Exception as e:
                        man["warnings"].append({"code": "svg_footprint", "name": fp.name, "detail": str(e)[:200]})
            except Exception as e:
                man["warnings"].append({"code": "pcblib_error", "file": path.name, "detail": str(e)[:200]})
        elif k == "3d":
            man["steps"].append({"idx": len(man["steps"]), "path": rel, "name": path.name})
        elif k == "doc":
            man["pdfs"].append({"idx": len(man["pdfs"]), "path": rel, "name": path.name, "size": path.stat().st_size})

    man["candidates"] = [_candidate(s, man) for s in man["symbols"]]
    (d / "manifest.json").write_text(json.dumps(man, ensure_ascii=False), encoding="utf-8")
    return man


def _get(params: dict, keys: list[str]) -> str:
    low = {k.lower(): v for k, v in params.items()}
    for k in keys:
        if low.get(k):
            return low[k]
    return ""


def pin_check(sym: dict | None, fp: dict | None) -> dict | None:
    if not sym or not fp:
        return None
    a, b = set(sym["pin_ids"]), set(fp["pad_ids"])
    return {"ok": a == b, "pins": sym["pins"], "pads": fp["pads"],
            "pinsOnly": sorted(a - b)[:20], "padsOnly": sorted(b - a)[:20]}


def _candidate(s: dict, man: dict) -> dict:
    p = s["params"]
    fps = man["footprints"]
    fp = None
    for name in s["fps"]:
        fp = next((f for f in fps if f["name"] == name), None)
        if fp:
            break
    if fp is None and len(fps) == 1:
        fp = fps[0]
    sup = []
    low = {k.lower(): v for k, v in p.items()}
    for i in range(1, 6):
        n, sku = low.get(f"supplier {i}", ""), low.get(f"supplier part number {i}", "")
        if n and sku:
            sup.append([DISTRI_NAMES.get(n.lower(), n if n in ("Mouser", "DigiKey", "Farnell", "LCSC", "RS") else "other"), sku])
    for k, name in DISTRI_PARAMS.items():
        if low.get(k) and not any(x[0] == name for x in sup):
            sup.append([name, low[k]])
    ds = _get(p, K_DS)
    return {
        "idx": s["idx"], "sym": s["idx"], "fp": fp["idx"] if fp else None,
        "mpn": _get(p, K_MPN) or s["name"], "mfr": _get(p, K_MFR), "desc": s["desc"],
        "comment": _get(p, K_VALUE), "sup": sup[:5],
        "dsUrl": ds if ds.lower().startswith("http") else "",
        "check": pin_check(s, fp),
        "step": man["steps"][0]["idx"] if man["steps"] else None,
        "pdf": man["pdfs"][0]["idx"] if man["pdfs"] else None,
    }


# ------------------------------------------------------------------ écriture des fichiers d'un composant

def write_part_files(part_id: str, sid: str, sym_idx: int | None, fp_idx: int | None, step_idx: int | None,
                     dest: Path) -> dict:
    """Extrait le symbole et l'empreinte choisis vers `dest` (un fichier chacun) et renvoie leurs métadonnées."""
    d = session_dir(sid)
    man = load_manifest(sid)
    dest.mkdir(parents=True, exist_ok=True)
    out: dict = {}
    if sym_idx is not None:
        s = man["symbols"][sym_idx]
        lib = AltiumSchLib(d / s["lib"])
        item = list(lib.asset_inventory().by_kind("sch_symbol"))[s["inv"]]
        one = lib.extract_asset(item.ref).schlib
        sym = one.symbols[0]
        for o in list(sym.parameters):          # les paramètres viennent de la base
            sym.remove_object(o)
        for o in list(sym.implementations):     # l'empreinte aussi (Footprint Ref/Path)
            sym.remove_object(o)
        one.rename_symbol(sym, part_id)
        target = dest / f"{part_id}.SchLib"
        one.save(target)
        out.update(symbol_ref=part_id, symbol_name=target.name, pins=s["pins"], pin_ids=s["pin_ids"])
    if fp_idx is not None:
        f = man["footprints"][fp_idx]
        pl = AltiumPcbLib.from_file(d / f["lib"])
        item = list(pl.asset_inventory().by_kind("pcb_footprint"))[f["inv"]]
        one = pl.extract_asset(item.ref).pcblib
        fp = one.footprints[0]
        has3d = len(fp.component_bodies) > 0
        if not has3d and step_idx is not None:
            st = man["steps"][step_idx]
            model = one.add_embedded_model(name=Path(st["name"]).name, model_data=(d / st["path"]).read_bytes())
            fp.add_embedded_3d_model(model, layer=PcbLayer.MECHANICAL_13, side=PcbBodyProjection.TOP)
            has3d = True
        target = dest / f"{safe_name(fp.name)}.PcbLib"
        one.save(target)
        out.update(footprint_ref=fp.name, footprint_name=target.name, pads=f["pads"], pad_ids=f["pad_ids"], has_3d=has3d)
    return out


def store_pdf(path: Path) -> tuple[str, int]:
    data = path.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    target = config.DS_DIR / sha[:2] / f"{sha}.pdf"
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return sha, len(data)


def pdf_path(sha: str) -> Path:
    return config.DS_DIR / sha[:2] / f"{sha}.pdf"
