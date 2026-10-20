"""Lecture et mise en forme des valeurs (4k7, 100n, 2,2u, 25MHz...), identiques à celles de l'interface."""
import math
import re

MULT = {"p": 1e-12, "n": 1e-9, "u": 1e-6, "µ": 1e-6, "m": 1e-3, "": 1, "k": 1e3, "K": 1e3, "M": 1e6, "G": 1e9, "R": 1}
PREF = [(1e9, "G"), (1e6, "M"), (1e3, "k"), (1, ""), (1e-3, "m"), (1e-6, "µ"), (1e-9, "n"), (1e-12, "p")]
_SI_RE = re.compile(r"^(-?\d*\.?\d+)([pnuµmkKMGR]?)(\d*)$")
_BIN_RE = re.compile(r"^(\d*\.?\d+)\s*(k|ko|kb|m|mo|mb)?$", re.I)


class BadValue(ValueError):
    pass


def parse_si(raw, unit: str | None):
    if raw is None:
        return None
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return float(raw)
    s = re.sub(r"\s+", "", str(raw)).replace(",", ".", 1)
    if not s:
        return None
    if unit == "Ω":
        s = re.sub(r"(ohms?|Ω)$", "", s, flags=re.I)
    elif unit and s.endswith(unit) and len(s) > len(unit):
        s = s[: -len(unit)]
    if unit == "Hz":
        s = re.sub(r"hz$", "", s, flags=re.I)
    m = _SI_RE.match(s)
    if not m:
        raise BadValue(raw)
    num, pre, tail = m.groups()
    if pre == "R" and unit != "Ω":
        raise BadValue(raw)
    if tail and ("." in num or not pre):
        raise BadValue(raw)
    return float(f"{float(num + ('.' + tail if tail else '')) * MULT[pre]:.12g}")


def parse_bin(raw):
    if raw is None or raw == "":
        return None
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return int(raw)
    m = _BIN_RE.match(str(raw).strip().replace(",", ".", 1))
    if not m:
        raise BadValue(raw)
    u = (m.group(2) or "").lower()
    return int(round(float(m.group(1)) * (1024 if u.startswith("k") else 1048576 if u.startswith("m") else 1)))


def parse_param(defn: dict, raw):
    si = defn.get("si")
    if si == 1:
        return parse_si(raw, defn.get("u"))
    if si == 2:
        return parse_bin(raw)
    if raw is None or str(raw).strip() == "":
        return None
    return str(raw).strip()


def _num(v: float) -> str:
    s = f"{v:.3g}"
    if "e" in s:
        s = f"{v:.6f}".rstrip("0").rstrip(".")
    return s


def fmt_si(v, unit: str | None) -> str:
    if v is None:
        return ""
    unit = unit or ""
    a = abs(v)
    if a == 0:
        return f"0 {unit}".strip()
    for f, p in PREF:
        if a >= f * 0.9999:
            return f"{_num(v / f)} {p}{unit}".strip()
    return f"{_num(v)} {unit}".strip()


def fmt_bin(v) -> str:
    if v is None:
        return ""
    if v >= 1048576:
        return f"{_num(v / 1048576)} MB"
    if v >= 1024:
        return f"{_num(v / 1024)} KB"
    return f"{v} B"


def fmt_param(defn: dict, v) -> str:
    if v is None or v == "":
        return ""
    si = defn.get("si")
    if si == 1:
        return fmt_si(float(v), defn.get("u"))
    if si == 2:
        return fmt_bin(int(v))
    return str(v)


def fmt_temp(tmin, tmax) -> str:
    if tmin is None or tmax is None:
        return ""
    def s(x):
        x = int(x) if float(x).is_integer() else x
        return f"+{x}" if x > 0 else str(x)
    return f"{s(tmin)}°C ~ {s(tmax)}°C"


def finite(v):
    return v if isinstance(v, (int, float)) and math.isfinite(v) else None
