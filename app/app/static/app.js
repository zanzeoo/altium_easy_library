"use strict";
/* Bibliothèque Altium — interface web (vanilla JS, aucune dépendance) */

/* ===================== i18n ===================== */
const LANG_FILES = {};
let LANG = (() => { try { const s = localStorage.getItem("lib-lang"); if (s === "fr" || s === "en") return s } catch (e) { } return (navigator.language || "fr").toLowerCase().startsWith("fr") ? "fr" : "en" })();
const LOCALE = () => LANG === "fr" ? "fr-FR" : "en-GB";
function t(key, vars, fb) {
  let s = (LANG_FILES[LANG] || {})[key]; if (s == null) s = (LANG_FILES.fr || {})[key]; if (s == null) s = fb != null ? fb : key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => vars[k] != null ? vars[k] : m); return s
}
const PLURAL = {};
function tn(key, n, vars) { const pr = PLURAL[LANG] || (PLURAL[LANG] = new Intl.PluralRules(LOCALE())); return t(key + "_" + pr.select(n), { n, ...vars }) }
function applyStatic() {
  document.documentElement.lang = LANG; document.title = t("app.name");
  document.querySelectorAll("[data-i18n]").forEach(el => el.textContent = t(el.dataset.i18n));
  document.querySelectorAll("[data-i18n-html]").forEach(el => el.innerHTML = t(el.dataset.i18nHtml));
  document.querySelectorAll("[data-i18n-ph]").forEach(el => el.placeholder = t(el.dataset.i18nPh));
  document.querySelectorAll("[data-i18n-aria]").forEach(el => el.setAttribute("aria-label", t(el.dataset.i18nAria)));
  document.querySelectorAll("[data-i18n-title]").forEach(el => el.title = t(el.dataset.i18nTitle));
  document.querySelectorAll("[data-langseg]").forEach(seg => [...seg.children].forEach(b => { b.classList.toggle("on", b.dataset.l === LANG); b.setAttribute("aria-pressed", b.dataset.l === LANG) }));
}

/* ===================== API ===================== */
class ApiError extends Error { constructor(status, body) { super("api " + status); this.status = status; this.body = body } }
async function api(method, url, body, isForm) {
  let r;
  try {
    r = await fetch(url, { method, credentials: "same-origin", headers: body && !isForm ? { "Content-Type": "application/json" } : {}, body: body ? (isForm ? body : JSON.stringify(body)) : undefined });
  } catch (e) { throw new ApiError(0, { detail: { errors: [{ code: "network" }] } }) }
  let j = null; try { j = await r.json() } catch (e) { }
  if (r.status === 401 && !url.startsWith("/api/login")) { showLogin(); throw new ApiError(401, j) }
  if (!r.ok) throw new ApiError(r.status, j);
  return j;
}
function errCodes(e) { const d = e && e.body && e.body.detail; if (d && Array.isArray(d.errors)) return d.errors; if (typeof d === "string") return [{ code: d }]; return [{ code: "generic" }] }
function errText(e) { const x = errCodes(e)[0] || {}; return t("err." + x.code, { id: x.id || "", detail: x.detail || "" }, t("err.generic")) }
function showErr(e) { console.error(e); toast(errText(e)) }

/* ===================== État ===================== */
const $ = id => document.getElementById(id);
let ME = null, USERS = {}, GROUPS = [], CATS = {}, P = [], NOTIFS = [], SETTINGS = {};
const DETAIL = {};
const st = { cat: "all", q: "", status: "all", mount: "", pkg: "", by: "", sort: { k: "comment", dir: 1 }, sel: null, confirm: null };

async function loadAll() {
  const b = await api("GET", "/api/bootstrap");
  ME = b.me.id; SETTINGS = b.settings;
  USERS = {}; b.users.forEach(u => USERS[u.id] = u);
  GROUPS = b.groups; CATS = {}; b.categories.forEach(c => CATS[c.id] = c);
  P = b.parts; NOTIFS = b.notifications;
  Object.keys(DETAIL).forEach(k => delete DETAIL[k]);
  if (st.cat !== "all" && !CATS[st.cat]) st.cat = "all";
  if (st.sel && !P.some(p => p.id === st.sel)) st.sel = null;
}
async function refresh(sel) { await loadAll(); if (sel !== undefined) st.sel = sel; renderUser(); renderBell(); render() }

/* ===================== Libellés ===================== */
const lab = o => (o && o.labels) ? (o.labels[LANG] || o.labels.fr || o.labels.en || o.id || o.k) : "—";
const gName = g => lab(g), cName = c => c ? lab(c) : "—", pLabel = d => lab(d);
const groupOf = c => GROUPS.find(g => g.id === c.group);
const user = u => USERS[u] || { id: u, name: u || "?", full: u || "?", role: "designer", titles: [], email: "", color: "#888" };
const canValidate = u => ["librarian", "admin"].includes(user(u).role);
const initials = u => user(u).full.split(/\s+/).map(w => w[0] || "").join("").slice(0, 2).toUpperCase();
const av = u => `<span class="av" style="background:${user(u).color}" aria-hidden="true">${esc(initials(u))}</span>`;
const who = u => `<span class="who">${av(u)}${esc(user(u).name)}${u === ME ? ` <span style="color:var(--faint)">${t("me")}</span>` : ""}</span>`;
const roleName = u => t("role." + user(u).role);
const titleChips = u => `<span class="titles">${user(u).titles.map(x => `<span class="ttl">${t("title." + x)}</span>`).join("")}</span>`;
const titleText = u => user(u).titles.map(x => t("title." + x)).join(", ") || roleName(u);
const names = list => list.map(u => user(u).full).join(", ");
const validatorsFor = ex => Object.keys(USERS).filter(u => u !== ex && USERS[u].active && canValidate(u)).sort((a, b) => (USERS[b].titles.includes("validator") ? 1 : 0) - (USERS[a].titles.includes("validator") ? 1 : 0));

/* ===================== Formatage ===================== */
const PREF = [[1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"]];
function num(v) { const s = String(+(+v).toPrecision(3)); return LANG === "fr" ? s.replace(".", ",") : s }
function si(v, u) { if (v == null || v === "") return "—"; const a = Math.abs(v); if (a === 0) return "0 " + u; for (const [f, s] of PREF) { if (a >= f * 0.9999) return num(v / f) + " " + s + u } return num(v) + " " + u }
function bin(v) { if (v == null) return "—"; const k = 1024; if (v >= k * k) return num(v / k / k) + " " + t("unit.M"); if (v >= k) return num(v / k) + " " + t("unit.k"); return v + " " + t("unit.b") }
function fmtParam(d, v) { if (v == null || v === "") return "—"; if (d.si === 1) return si(+v, d.u || ""); if (d.si === 2) return bin(+v); return String(v) }
function temp(tt) { if (!tt || tt[0] == null || tt[1] == null) return "—"; const s = x => (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x); return s(tt[0]) + " … " + s(tt[1]) + " °C" }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])) }
const statusChip = p => p.st === "archived" ? `<span class="chip bad">${t("status.archived")}</span>` : (p.st === "valid" ? `<span class="chip ok">${t("status.valid")}</span>` : `<span class="chip draft">${t("status.draft")}</span>`) + (p.pending ? ` <span class="chip pend">${t("status.pending")}</span>` : "");
const lcChip = l => l === "active" ? `<span class="chip ok">${t("lc.active")}</span>` : l === "nrnd" ? `<span class="chip draft">${t("lc.nrnd")}</span>` : `<span class="chip bad">${t("lc.obsolete")}</span>`;
const fdate = d => d ? new Date(d).toLocaleDateString(LOCALE(), { day: "numeric", month: "long", year: "numeric" }) : "—";
function rel(at) {
  const s = (new Date(at) - Date.now()) / 1000, a = Math.abs(s), rtf = new Intl.RelativeTimeFormat(LOCALE(), { numeric: "auto" });
  if (a < 60) return rtf.format(Math.round(s), "second"); if (a < 3600) return rtf.format(Math.round(s / 60), "minute"); if (a < 86400) return rtf.format(Math.round(s / 3600), "hour"); return rtf.format(Math.round(s / 86400), "day")
}
const kb = b => b > 1048576 ? num(b / 1048576) + " " + t("unit.M") : Math.max(1, Math.round(b / 1024)) + " " + t("unit.k");
const DISTRIS = ["Mouser", "DigiKey", "Farnell", "LCSC", "RS", "other"];
const distriName = d => d === "other" ? t("distri.other") : d;

/* ===================== Aperçus (SVG rendus par le serveur) ===================== */
function pv(kind, src, caption) {
  const ph = `<div class="ph">${t(kind === "sym" ? "pv.symPh" : "pv.fpPh")}</div>`;
  const inner = src ? `<img src="${esc(src)}" alt="${esc(t(kind === "sym" ? "pv.symAria" : "pv.fpAria"))}" loading="lazy" onerror="this.parentNode.innerHTML='&lt;div class=&quot;ph&quot;&gt;—&lt;/div&gt;'">` : ph;
  return `<figure class="pv ${kind}"><div class="pv-img">${inner}</div><figcaption><b>${t(kind === "sym" ? "pv.sym" : "pv.fp")}</b><span title="${esc(caption || "")}">${esc(caption || "—")}</span></figcaption></figure>`
}
const partSvg = (p, kind) => `/api/parts/${encodeURIComponent(p.id)}/${kind}.svg?v=${encodeURIComponent(p.rev || "")}`;

/* ===================== Exploration ===================== */
const catParts = c => c === "all" ? P : P.filter(p => p.cat === c);
const visible = c => catParts(c).filter(p => st.status === "archived" ? p.st === "archived" : p.st !== "archived");

function renderTree() {
  let h = `<div class="tree-h">${t("tree.title")}</div><button class="cat all ${st.cat === "all" ? "on" : ""}" data-c="all" type="button"><span>${t("tree.all")}</span><span class="n">${P.filter(p => p.st !== "archived").length}</span></button>`;
  GROUPS.forEach(g => {
    if (!g.cats.length) return;
    h += `<div class="group"><div class="group-name">${esc(gName(g))}</div>`;
    g.cats.forEach(cid => {
      const c = CATS[cid]; if (!c) return;
      const ps = catParts(cid).filter(p => p.st !== "archived"), dr = ps.some(p => p.st === "draft" || p.pending);
      h += `<button class="cat ${st.cat === cid ? "on" : ""}" data-c="${esc(cid)}" type="button"><span>${esc(cName(c))}${dr ? `<span class="draft-dot" title="${t("tree.drafts")}"></span>` : ""}</span><span class="n">${ps.length}</span></button>`
    });
    h += `</div>`
  });
  if (canValidate(ME)) h += `<button class="new-cat" type="button" id="newCatBtn">${t("tree.newCat")}</button>`;
  $("tree").innerHTML = h;
}
function columns() {
  const base = [{ k: "id", l: t("col.ref"), cls: "ref" }, { k: "mpn", l: t("col.mpn"), cls: "mpn" }, { k: "mfr", l: t("col.mfr") }];
  const tail = [{ k: "pkg", l: t("col.pkg") }, { k: "temp", l: t("col.temp"), num: 1 }, { k: "by", l: t("col.by") }, { k: "st", l: t("col.st") }];
  if (st.cat === "all") return [...base, { k: "desc", l: t("col.desc"), cls: "desc" }, ...tail];
  const c = CATS[st.cat];
  return [...base, ...c.params.map(d => ({ k: "p." + d.k, l: pLabel(d), u: d.u && d.si === 1 ? d.u : null, num: d.si ? 1 : 0, def: d })), ...tail];
}
function sortVal(p, k) {
  if (k === "temp") return p.t[1] ?? -1e9;
  if (k === "by") return user(p.by).full;
  if (k === "comment") { const c = CATS[p.cat]; const d = c && c.params.find(x => x.si); return d && p.p[d.k] != null ? +p.p[d.k] : p.comment }
  if (k.startsWith("p.")) { const v = p.p[k.slice(2)]; return v == null ? "" : v }
  return p[k] ?? "";
}
function filtered() {
  const q = st.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const r = visible(st.cat).filter(p => {
    if (st.status === "valid" && p.st !== "valid") return false;
    if (st.status === "draft" && !(p.st === "draft" || p.pending)) return false;
    if (st.mount && p.mount !== st.mount) return false;
    if (st.pkg && p.pkg !== st.pkg) return false;
    if (st.by && p.by !== st.by) return false;
    if (!q.length) return true;
    const c = CATS[p.cat] || { params: [] };
    const hay = [p.id, p.mpn, p.mfr, p.desc, p.comment, p.pkg, cName(c), user(p.by).full, ...c.params.map(d => fmtParam(d, p.p[d.k]))].join(" ").toLowerCase().replace(/,/g, ".");
    return q.every(w => hay.includes(w.replace(/,/g, ".")));
  });
  const { k, dir } = st.sort;
  r.sort((a, b) => { const x = sortVal(a, k), y = sortVal(b, k); if (typeof x === "number" && typeof y === "number") return (x - y) * dir; return String(x).localeCompare(String(y), LOCALE(), { numeric: true }) * dir });
  return r;
}
function renderFilterOptions() {
  $("mountSel").innerHTML = `<option value="">${t("filter.mountAll")}</option>` + ["smd", "tht"].map(m => `<option value="${m}" ${st.mount === m ? "selected" : ""}>${t("mount." + m)}</option>`).join("");
  const pk = [...new Set(visible(st.cat).map(p => p.pkg))].sort((a, b) => a.localeCompare(b, LOCALE(), { numeric: true }));
  if (st.pkg && !pk.includes(st.pkg)) st.pkg = "";
  $("pkgSel").innerHTML = `<option value="">${t("filter.pkgAll")}</option>` + pk.map(x => `<option ${x === st.pkg ? "selected" : ""}>${esc(x)}</option>`).join("");
  const ids = Object.keys(USERS).sort((a, b) => a === ME ? -1 : b === ME ? 1 : USERS[a].full.localeCompare(USERS[b].full));
  $("bySel").innerHTML = `<option value="">${t("filter.byAll")}</option>` + ids.map(u => `<option value="${esc(u)}" ${st.by === u ? "selected" : ""}>${u === ME ? esc(t("filter.me", { name: USERS[u].full })) : esc(USERS[u].full)}</option>`).join("");
  [...$("statusSeg").children].forEach(x => x.classList.toggle("on", x.dataset.v === st.status));
}
function renderTable() {
  const cols = columns(), rows = filtered();
  const c = st.cat === "all" ? null : CATS[st.cat];
  $("crumbs").textContent = (c ? gName(groupOf(c) || {}) : t("crumb.root")) + " ›";
  $("catTitle").textContent = c ? cName(c) : t("title.all");
  const total = visible(st.cat).length;
  $("count").textContent = rows.length === total ? tn("count", total) : t("count.filtered", { n: rows.length, total });
  $("resetBtn").hidden = !(st.q || st.status !== "all" || st.mount || st.pkg || st.by);
  $("thead").innerHTML = "<tr>" + cols.map(col => {
    const on = st.sort.k === col.k;
    return `<th class="${col.num ? "num" : ""} ${on ? "sorted" : ""}" data-k="${col.k}" tabindex="0" aria-sort="${on ? (st.sort.dir > 0 ? "ascending" : "descending") : "none"}">${esc(col.l)}${col.u ? ` <span class="u">(${esc(col.u)})</span>` : ""}<span class="arr">${on ? (st.sort.dir > 0 ? "▲" : "▼") : ""}</span></th>`
  }).join("") + "</tr>";
  $("tbody").innerHTML = rows.map(p => `<tr data-id="${esc(p.id)}" tabindex="0" class="${st.sel === p.id ? "sel" : ""}">` + cols.map(col => {
    let v;
    if (col.k === "st") v = statusChip(p);
    else if (col.k === "by") v = who(p.by);
    else if (col.k === "temp") v = `<span class="tnum">${temp(p.t)}</span>`;
    else if (col.k.startsWith("p.")) v = `<span class="tnum ${col === cols[3] ? "val" : ""}">${esc(fmtParam(col.def, p.p[col.def.k]))}</span>`;
    else v = esc(p[col.k]);
    return `<td class="${col.cls || ""} ${col.num ? "num" : ""}">${v}</td>`
  }).join("") + "</tr>").join("");
  $("empty").hidden = rows.length > 0;
  $("empty").textContent = total === 0 ? t("empty.cat") : t("empty.filter");
}

/* ----- fiche ----- */
function histItems(p) {
  const r = u => `<span style="color:var(--faint)">· ${esc(titleText(u))}</span>`;
  const ev = [{ a: "created", u: p.by, at: p.date }, ...((DETAIL[p.id] || {}).hist || [])];
  if (p.val) ev.push({ a: "validated", u: p.val, at: p.vdate || p.date });
  ev.sort((x, y) => String(x.at).localeCompare(String(y.at)));
  const txt = e => {
    const v = { names: esc(names(e.to || [])), date: fdate(e.at) };
    switch (e.a) {
      case "created": return t("h.added", v); case "validated": return t("h.validated", v) + (e.u === p.by ? t("h.self") : "");
      case "ask": return t("h.asked", v); case "info": return t("h.informed", v); case "edit": return tn("h.edit", e.n || 1, v); case "propose": return tn("h.propose", e.n || 1, v);
      case "applied": return t("h.applied", v); case "rejected": return t("h.rejected", v); case "archived": return t("h.archived", v); case "restored": return t("h.restored", v)
    } return ""
  };
  let h = ev.map(e => `<li>${av(e.u)}<span><b>${esc(user(e.u).full)}</b> ${r(e.u)}<small>${txt(e)}</small></span></li>`).join("");
  if (!p.val && p.st !== "archived") {
    const asked = [...new Set(((DETAIL[p.id] || {}).hist || []).filter(e => e.a === "ask").flatMap(e => e.to || []))];
    h += `<li class="pending"><span class="av">?</span><span><b>${t("h.pending")}</b><small>${asked.length ? t("h.pendingBy", { names: esc(names(asked)) }) : t("h.pendingTxt")}</small></span></li>`
  }
  return h;
}
const canDelete = p => p.st === "draft" && (ME === p.by || canValidate(ME));
const canArchive = p => p.st === "valid" && canValidate(ME);
function dangerBtn(p) {
  if (st.confirm && st.sel === p.id) return "";
  if (canDelete(p)) return `<button class="btn small danger" type="button" id="dangerBtn">${t("d.delete")}</button>`;
  if (canArchive(p)) return `<button class="btn small danger" type="button" id="dangerBtn">${t("d.archive")}</button>`;
  return "";
}
function dangerBox(p) {
  if (!st.confirm || st.sel !== p.id) return "";
  const del = st.confirm === "delete";
  return `<div class="confirm-box" role="alertdialog" aria-labelledby="dzT"><b id="dzT">${t(del ? "del.title" : "arc.title")}</b><p>${t(del ? "del.txt" : "arc.txt")}</p>
  ${del ? "" : `<label for="arcReason" style="font-size:12px;color:var(--muted);font-weight:500">${t("arc.reason")}</label><textarea id="arcReason" placeholder="${esc(t("arc.reasonPh"))}"></textarea>`}
  <div class="d-actions"><button class="btn small danger-fill" type="button" id="dangerOk">${t(del ? "del.confirm" : "arc.confirm")}</button><button class="btn small" type="button" id="dangerCancel">${t("cm.cancel")}</button></div></div>`;
}
async function ensureDetail(id) {
  if (DETAIL[id]) return;
  try { const d = await api("GET", "/api/parts/" + encodeURIComponent(id)); DETAIL[id] = d; const i = P.findIndex(p => p.id === id); if (i >= 0) { const h = d.hist; delete d.hist; P[i] = d; DETAIL[id] = { hist: h } } if (st.sel === id) renderDetail() } catch (e) { }
}
function renderDetail() {
  const d = $("detail"), p = P.find(x => x.id === st.sel);
  if (!p) { d.innerHTML = `<div class="empty">${t("empty.detail")}</div>`; return }
  if (!DETAIL[p.id]) ensureDetail(p.id);
  const c = CATS[p.cat] || { params: [], labels: {} };
  const params = c.params.map(x => `<dt>${esc(pLabel(x))}</dt><dd class="tnum">${esc(fmtParam(x, p.p[x.k]))}</dd>`).join("");
  const share = (SETTINGS.share || "").replace(/[\\/]+$/, "");
  const winPath = f => f ? share + "\\" + f.replace(/\//g, "\\") : "—";
  const pd = p.pending;
  d.innerHTML = `
  <div class="d-head">
    <div class="d-top"><span class="d-ref">${esc(p.id)} · ${esc(cName(c))}</span><span style="display:flex;gap:6px;align-items:center">${statusChip(p)}<button class="close" type="button" id="closeD" aria-label="${t("d.close")}"><svg width="18" height="18" viewBox="0 0 18 18"><path d="M4 4l10 10M14 4L4 14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></span></div>
    <h2 class="d-mpn">${esc(p.mpn)}</h2>
    <div class="d-mfr">${esc(p.mfr)}</div>
    <p class="d-desc">${esc(p.desc)}</p>
    <div class="d-actions">${p.st === "draft" && canValidate(ME) ? `<button class="btn small primary" type="button" id="validBtn">${t("d.validate")}</button>` : ""}${(ME === p.by || canValidate(ME)) && !pd && p.st !== "archived" ? `<button class="btn small" type="button" id="editBtn">${t("d.edit")}</button>` : ""}<button class="btn small" type="button" id="notifyBtn">${t("d.notify")}</button>${p.ds ? `<a class="btn small" href="/api/parts/${encodeURIComponent(p.id)}/datasheet" target="_blank" rel="noopener">${t("d.openDs")}</a>` : ""}<button class="btn small" type="button" id="copyMpn">${t("d.copyMpn")}</button><button class="btn small" type="button" id="copyRef">${t("d.copyRef")}</button>${dangerBtn(p)}</div>
    ${dangerBox(p)}
  </div>
  ${p.st === "archived" && p.arc ? `<div class="section arc-sec"><h3>${t("status.archived")}</h3><p class="note" style="margin:0">${t("arc.banner", { name: esc(user(p.arc.by).full), date: fdate(p.arc.at) })}</p>${p.arc.reason ? `<p class="note" style="margin:6px 0 0;padding-left:8px;border-left:2px solid var(--bad)">${esc(p.arc.reason)}</p>` : ""}<p class="note" style="margin:6px 0 0">${t("arc.bannerTxt")}</p>${canValidate(ME) ? `<div class="d-actions" style="margin-top:10px"><button class="btn small" type="button" id="restoreBtn">${t("d.restore")}</button></div>` : ""}</div>` : ""}
  ${pd ? `<div class="section pend-sec"><h3>${t("pend.title")}</h3><p class="note" style="margin:0 0 8px">${t("pend.by", { name: esc(user(pd.by).full), date: fdate(pd.at) })}</p>${diffTable(diffParts(p, pd.data, pd.rep))}${pd.rep && (pd.rep.sym || pd.rep.fp) ? `<div class="previews" style="margin-top:10px">${pd.rep.sym ? pv("sym", `/api/parts/${encodeURIComponent(p.id)}/pending/symbol.svg`, p.id) : ""}${pd.rep.fp ? pv("fp", `/api/parts/${encodeURIComponent(p.id)}/pending/footprint.svg`, pd.rep.fpRef) : ""}</div>` : ""}${canValidate(ME) ? `<div class="d-actions" style="margin-top:10px"><button class="btn small primary" type="button" id="pendOk">${t("pend.accept")}</button><button class="btn small" type="button" id="pendKo">${t("pend.reject")}</button></div>` : ""}<p class="note" style="margin-top:8px">${t("pend.altium")}</p></div>` : ""}
  <div class="section"><h3>${t("d.symFp")}</h3><div class="previews">${pv("sym", partSvg(p, "symbol"), p.sym.ref)}${pv("fp", partSvg(p, "footprint"), p.fp.ref)}</div></div>
  <div class="section"><h3>${t("d.params")}</h3>
    <dl class="kv">${params}
      <dt>${t("d.comment")}</dt><dd class="mono">${esc(p.comment)}</dd>
      <dt>${t("d.pkg")}</dt><dd>${esc(p.pkg)}</dd>
      <dt>${t("d.mount")}</dt><dd>${t("mount." + p.mount)}</dd>
      <dt>${t("d.temp")}</dt><dd class="tnum">${temp(p.t)}</dd>
      <dt>${t("d.lc")}</dt><dd>${lcChip(p.lc)}</dd>
      <dt>${t("d.pins")}</dt><dd class="tnum">${p.sym.pins ?? "—"} / ${p.fp.pads ?? "—"}${p.fp.has3d ? " · 3D" : ""}</dd>
    </dl>
  </div>
  <div class="section"><h3>${t("d.mfrs")}</h3>
    <div class="sup"><div class="sup-row"><span>${esc(p.mfr)} <span style="color:var(--faint);font-size:12px">· ${t("d.primary")}</span></span><span class="mono">${esc(p.mpn)}</span></div>
    ${(p.alt || []).map(a => `<div class="sup-row"><span>${esc(a[0])} <span style="color:var(--faint);font-size:12px">· ${t("d.second")}</span></span><span class="mono">${esc(a[1])}</span></div>`).join("")}</div>
  </div>
  <div class="section"><h3>${t("d.distris")}</h3>
    ${p.sup.length ? `<div class="sup">${p.sup.map((s, i) => `<div class="sup-row"><span>${esc(distriName(s[0]))} <span style="color:var(--faint);font-size:12px">· Supplier ${i + 1}</span></span><span class="mono">${esc(s[1])}</span></div>`).join("")}</div>` : `<p style="margin:0;color:var(--muted)">${t("d.noDistri")}</p>`}
  </div>
  <div class="section"><h3>${t("d.files")}</h3>
    <div class="files"><span>${esc(winPath(p.sym.file))}</span><span>${esc(winPath(p.fp.file))} ${p.fp.has3d ? `<span style="color:var(--faint)">${t("d.stepEmbedded")}</span>` : ""}</span>${p.ds ? `<span>${esc(p.ds.name || p.ds.url || "")}</span>` : ""}</div>
  </div>
  <div class="section" style="border-bottom:0"><h3>${t("d.history")}</h3><ol class="hist">${histItems(p)}</ol></div>`;
  $("copyMpn").onclick = () => copy(p.mpn); $("copyRef").onclick = () => copy(p.id);
  $("notifyBtn").onclick = () => openNotify(p);
  $("closeD").onclick = () => d.classList.add("closed");
  if ($("editBtn")) $("editBtn").onclick = () => openEdit(p);
  if ($("validBtn")) $("validBtn").onclick = () => act(async () => { const r = await api("POST", `/api/parts/${encodeURIComponent(p.id)}/validate`); await refresh(p.id); toast(t("toast.validated", { mpn: p.mpn, name: user(ME).full }) + (r.told.length ? " · " + t("toast.told", { names: names(r.told) }) : "")) });
  if ($("pendOk")) $("pendOk").onclick = () => act(async () => { await api("POST", `/api/parts/${encodeURIComponent(p.id)}/pending/accept`); await refresh(p.id); toast(t("toast.applied", { mpn: p.mpn })) });
  if ($("pendKo")) $("pendKo").onclick = () => act(async () => { await api("POST", `/api/parts/${encodeURIComponent(p.id)}/pending/reject`); await refresh(p.id); toast(t("toast.rejected", { mpn: p.mpn })) });
  if ($("dangerBtn")) $("dangerBtn").onclick = () => { st.confirm = p.st === "draft" ? "delete" : "archive"; renderDetail(); const b = $("dangerOk"); if (b) b.focus() };
  if ($("dangerCancel")) $("dangerCancel").onclick = () => { st.confirm = null; renderDetail() };
  if ($("dangerOk")) $("dangerOk").onclick = () => act(async () => {
    if (st.confirm === "delete") { await api("DELETE", `/api/parts/${encodeURIComponent(p.id)}`); st.confirm = null; await refresh(null); if (narrow()) $("detail").classList.add("closed"); toast(t("toast.deleted", { mpn: p.mpn })) }
    else { await api("POST", `/api/parts/${encodeURIComponent(p.id)}/archive`, { reason: ($("arcReason") || {}).value || "" }); st.confirm = null; await refresh(p.id); toast(t("toast.archived", { mpn: p.mpn })) }
  });
  if ($("restoreBtn")) $("restoreBtn").onclick = () => act(async () => { await api("POST", `/api/parts/${encodeURIComponent(p.id)}/restore`); await refresh(p.id); toast(t("toast.restored", { mpn: p.mpn })) });
}
let busyAct = false;
async function act(fn) { if (busyAct) return; busyAct = true; try { await fn() } catch (e) { if (e.status !== 401) showErr(e) } finally { busyAct = false } }
function copy(x) { const done = () => toast(t("toast.copied", { t: x })); try { navigator.clipboard.writeText(x).then(done, () => toast(x)) } catch (e) { toast(x) } }
let tt; function toast(m) { const el = $("toast"); el.textContent = m; el.hidden = false; clearTimeout(tt); tt = setTimeout(() => el.hidden = true, 3200) }
const narrow = () => window.matchMedia("(max-width:1180px)").matches;
function select(id, open = true) { if (st.sel !== id) st.confirm = null; st.sel = id; renderTable(); renderDetail(); if (open) $("detail").classList.remove("closed") }
function renderUser() { $("userChip").innerHTML = `${av(ME)}<span>${esc(user(ME).full)}<small>${esc(titleText(ME))}</small></span>` }
function render() { renderTree(); renderFilterOptions(); renderTable(); renderDetail() }

/* ----- différences (modification proposée) ----- */
function diffParts(o, n, rep) {
  const D = [], push = (l, a, b) => { a = String(a ?? "—"); b = String(b ?? "—"); if (a !== b) D.push({ l, a, b }) };
  const cn = c => CATS[c] ? cName(CATS[c]) : "—";
  push(t("f.cat"), cn(o.cat), cn(n.cat));
  push("MPN", o.mpn, n.mpn); push(t("f.mfr"), o.mfr, n.mfr); push(t("d.comment"), o.comment, n.comment); push(t("f.desc"), o.desc, n.desc); push(t("f.pkg"), o.pkg, n.pkg);
  push(t("f.mount"), t("mount." + o.mount), t("mount." + n.mount)); push(t("d.temp"), temp(o.t), temp(n.t)); push(t("f.lc"), t("lc." + o.lc), t("lc." + n.lc));
  (CATS[n.cat] ? CATS[n.cat].params : []).forEach(d => push(pLabel(d), o.cat === n.cat ? fmtParam(d, o.p[d.k]) : "—", fmtParam(d, n.p[d.k])));
  const sp = s => (s || []).map(x => distriName(x[0]) + " " + x[1]).join(", ") || "—"; push(t("f.distris"), sp(o.sup), sp(n.sup));
  if (n.dsUrl && n.dsUrl !== ((o.ds && o.ds.url) || "")) push(t("f.dsUrl"), (o.ds && o.ds.url) || "—", n.dsUrl);
  if (rep && rep.sym) D.push({ l: t("pv.sym"), a: o.sym ? o.sym.ref : "—", b: t("diff.newFile") });
  if (rep && rep.fp) D.push({ l: t("pv.fp"), a: o.fp ? o.fp.ref : "—", b: rep.fpRef || t("diff.newFile") });
  if (rep && rep.ds) D.push({ l: "Datasheet", a: o.ds ? (o.ds.name || "—") : "—", b: t("diff.newFile") });
  return D;
}
const diffTable = D => `<div class="diff-wrap"><table class="diff"><thead><tr><th>${t("diff.field")}</th><th>${t("diff.old")}</th><th>${t("diff.new")}</th></tr></thead><tbody>${D.map(x => `<tr><td>${esc(x.l)}</td><td class="old">${esc(x.a)}</td><td class="new">${esc(x.b)}</td></tr>`).join("")}</tbody></table></div>`;

/* ===================== Notifications et menu utilisateur ===================== */
const myNotifs = () => NOTIFS.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
const unread = () => NOTIFS.filter(x => !x.read).length;
function renderBell() { const u = unread(); $("bellBadge").hidden = !u; $("bellBadge").textContent = u; $("bellBtn").setAttribute("aria-label", u ? tn("notif.aria", u) : t("notif.title")) }
function renderNotifPop() {
  const L = myNotifs();
  $("notifPop").innerHTML = `<div class="pop-h"><h3>${t("notif.title")}</h3>${unread() ? `<button class="link-btn" type="button" id="markAll">${t("notif.markAll")}</button>` : ""}</div>` +
    (L.length ? L.map(x => `<button class="notif ${x.read ? "read" : ""}" type="button" data-n="${x.id}">${av(x.from)}<span class="txt"><span class="kind ${esc(x.kind)}">${t("kind." + x.kind)}</span>${t("notif." + x.kind, { from: `<b>${esc(user(x.from).full)}</b>`, part: `<span class="mono">${esc(x.mpn || x.part)}</span>` })}${x.msg ? `<span class="msg">${esc(x.msg)}</span>` : ""}<span class="when">${rel(x.at)}</span></span><span class="dot" aria-hidden="true"></span></button>`).join("")
      : `<div class="pop-empty">${t("notif.empty")}</div>`);
}
function renderUserPop() {
  const u = user(ME);
  $("userPop").innerHTML = `<div class="um-head">${av(ME)}<span><b>${esc(u.full)}</b><span class="mono">${esc(u.email)}</span>${titleChips(ME)}<span style="color:var(--muted);font-size:12px">${t("team.roleIs", { r: roleName(ME) })}</span></span></div>
  <div class="um-sec"><button class="um-item" type="button" id="openTeam">${t("team.open")}</button><button class="um-item" type="button" id="openPw">${t("um.password")}</button>${canValidate(ME) ? `<button class="um-item" type="button" id="openAltium">${t("um.altium")}</button>` : ""}</div>
  <div class="um-sec"><button class="um-item" type="button" id="logoutBtn">${t("um.logout")}</button></div>`;
}
function closePops() { ["notifPop", "userPop"].forEach(id => $(id).hidden = true); $("bellBtn").setAttribute("aria-expanded", "false"); $("userChip").setAttribute("aria-expanded", "false") }
function togglePop(id, btn, fill) { const open = $(id).hidden; closePops(); if (open) { fill(); $(id).hidden = false; btn.setAttribute("aria-expanded", "true") } }
async function loadNotifs() {
  try { const before = unread(); NOTIFS = await api("GET", "/api/notifications"); renderBell(); if (!$("notifPop").hidden) renderNotifPop(); if (unread() > before && $("viewImport").hidden) { await loadAll(); render() } } catch (e) { }
}

/* ===================== Équipe et utilisateurs ===================== */
let editU = null;
const TITLES = ["author", "validator", "quality", "purchasing"];
function userForm(u) {
  const isNew = !u; u = u || { full: "", email: "", role: "designer", titles: [], active: true };
  return `<div class="edit-u" data-form="${isNew ? "__new" : esc(u.id)}"><div class="form">
    <div class="fld"><label for="uf_full">${t("f.full")} <span class="req">*</span></label><input id="uf_full" value="${esc(u.full)}" autocomplete="off"></div>
    <div class="fld"><label for="uf_email">${t("f.email")} <span class="req">*</span></label><input id="uf_email" type="email" value="${esc(u.email)}" autocomplete="off"></div>
    <div class="fld"><label for="uf_role">${t("f.role")}</label><select id="uf_role">${["designer", "librarian", "admin"].map(r => `<option value="${r}" ${u.role === r ? "selected" : ""}>${t("role." + r)}</option>`).join("")}</select></div>
    <div class="fld"><label for="uf_pw">${isNew ? t("f.password") + ' <span class="req">*</span>' : t("f.passwordNew")}</label><input id="uf_pw" type="password" autocomplete="new-password"></div>
    <div class="fld wide"><label>${t("f.titles")}</label><div class="chk-inline">${TITLES.map(x => `<label><input type="checkbox" data-ttl="${x}" ${u.titles.includes(x) ? "checked" : ""}>${t("title." + x)}</label>`).join("")}</div></div>
    ${isNew ? "" : `<div class="fld wide"><div class="chk-inline"><label><input type="checkbox" id="uf_active" ${u.active ? "checked" : ""}>${t("f.active")}</label></div></div>`}
  </div><p class="err-msg" id="uf_err"></p><div class="d-actions"><button class="btn small primary" type="button" id="uf_save">${t("team.save")}</button><button class="btn small" type="button" id="uf_cancel">${t("cm.cancel")}</button></div></div>`;
}
function renderTeam() {
  const admin = user(ME).role === "admin";
  $("tm_add").hidden = !admin || editU === "__new";
  const ids = Object.keys(USERS).sort((a, b) => (USERS[b].active - USERS[a].active) || USERS[a].full.localeCompare(USERS[b].full));
  $("teamList").innerHTML = (editU === "__new" ? `<div class="member">${userForm(null)}</div>` : "") + ids.map(k => {
    const u = USERS[k], added = P.filter(p => p.by === k).length, val = P.filter(p => p.val === k).length;
    return `<div class="member ${u.active ? "" : "inactive"}">${av(k)}<div class="info"><b>${esc(u.full)}${k === ME ? ` <span style="color:var(--faint);font-weight:400">${t("me")}</span>` : ""}${u.active ? "" : ` <span style="color:var(--faint);font-weight:400">· ${t("team.inactive")}</span>`}</b>${titleChips(k)}<span class="meta">${t("team.roleIs", { r: roleName(k) })}</span><span class="mail"><span>${esc(u.email)}</span><button class="copy-mini" type="button" data-mail="${esc(u.email)}">${t("team.copy")}</button></span></div><div class="stats">${t("team.added", { n: `<b>${added}</b>` })}<br>${t("team.validated", { n: `<b>${val}</b>` })}${admin && editU !== k ? `<br><button class="link-btn" type="button" data-edit="${esc(k)}">${t("team.edit")}</button>` : ""}</div>${editU === k ? userForm(u) : ""}</div>`
  }).join("");
}
async function saveUser() {
  const form = document.querySelector("[data-form]"); const id = form.dataset.form;
  const body = { full: $("uf_full").value.trim(), email: $("uf_email").value.trim(), role: $("uf_role").value, titles: [...form.querySelectorAll("[data-ttl]:checked")].map(x => x.dataset.ttl), password: $("uf_pw").value };
  if ($("uf_active")) body.active = $("uf_active").checked;
  try { if (id === "__new") await api("POST", "/api/users", body); else await api("PUT", "/api/users/" + encodeURIComponent(id), body); editU = null; await loadAll(); renderUser(); render(); renderTeam(); toast(t("toast.userSaved")) }
  catch (e) { if (e.status !== 401) $("uf_err").textContent = errText(e) }
}
function openTeam() { editU = null; renderTeam(); $("teamModal").hidden = false; $("tm_close").focus() }

/* ----- configuration Altium ----- */
async function openAltium() {
  $("alBody").innerHTML = `<div class="busy"><span class="spin"></span></div>`; $("altiumModal").hidden = false;
  try {
    const a = await api("GET", "/api/altium");
    $("alBody").innerHTML = `<p>${t("al.intro")}</p>${a.roConfigured ? "" : `<ul class="warn-list"><li>${t("al.noRo")}</li></ul>`}
    <ol class="steps-list"><li>${t("al.s1")}</li><li>${t("al.s2")}</li><li>${t("al.s3")}<div class="code-box" id="alCs" style="margin-top:6px">${esc(a.connection)}</div><button class="btn small" type="button" id="alCopy" style="margin-top:6px">${t("al.copy")}</button></li><li>${t("al.s4")}</li><li>${t("al.s5")}</li><li>${t("al.s6", { share: `<code>${esc(a.share)}</code>` })}</li></ol>
    <div class="fld"><label>${t("al.dblib")}</label><p class="note" style="margin:0">${a.dblibs.length ? t("al.dblibOn", { names: esc(a.dblibs.join(", ")) }) : t("al.dblibNone")}</p>
    <div class="d-actions"><label class="btn small" for="alFile">${t("al.dblibUp")}</label><input type="file" id="alFile" accept=".DbLib,.dblib" hidden></div></div>
    <div class="fld"><label>${t("al.views")}</label><div class="files">${a.views.map(v => `<span><span class="dir">${esc(v.view)}</span> · ${esc(lab({ labels: v.labels }))}</span>`).join("")}</div></div>`;
    $("alCopy").onclick = () => copy(a.connection);
    $("alFile").onchange = async e => { const fl = e.target.files[0]; if (!fl) return; const fd = new FormData(); fd.append("file", fl, fl.name); try { const r = await api("POST", "/api/altium/dblib", fd, true); toast(t("al.dblibDone", { name: r.name })); openAltium() } catch (x) { if (x.status !== 401) showErr(x) } };
  } catch (e) { $("alBody").innerHTML = `<p class="err-msg">${esc(errText(e))}</p>` }
}

/* ===================== Notifier un collègue ===================== */
let nm = { part: null, sel: new Set() };
function openNotify(p) {
  nm = { part: p, sel: new Set() };
  const kinds = p.st === "draft" ? ["validate", "info"] : ["info"];
  $("nm_kind").innerHTML = kinds.map(k => `<option value="${k}">${t("nm.k." + k)}</option>`).join("");
  if (p.st === "draft") { const v = validatorsFor(ME)[0]; if (v) nm.sel.add(v) }
  $("nm_msg").value = ""; $("nm_err").textContent = "";
  renderNotify(); $("notifyModal").hidden = false; $("nm_kind").focus();
}
function renderNotify() {
  const p = nm.part, kind = $("nm_kind").value;
  $("nmIntro").innerHTML = t("nm.intro", { mpn: `<span class="mono">${esc(p.mpn)}</span>` });
  const list = Object.keys(USERS).filter(u => u !== ME && USERS[u].active).sort((a, b) => kind === "validate" ? (canValidate(b) - canValidate(a)) || (USERS[b].titles.includes("validator") - USERS[a].titles.includes("validator")) : 0);
  $("nm_recips").innerHTML = list.map(u => `<label class="recip"><input type="checkbox" data-r="${esc(u)}" ${nm.sel.has(u) ? "checked" : ""}>${av(u)}<span>${esc(USERS[u].full)}<small>${esc(titleText(u))}${kind === "validate" && !canValidate(u) ? " · " + t("nm.cantValidate") : ""} · <span class="mono">${esc(USERS[u].email)}</span></small></span></label>`).join("");
}
async function sendNotify() {
  const kind = $("nm_kind").value, to = [...nm.sel], p = nm.part, msg = $("nm_msg").value.trim();
  if (!to.length) { $("nm_err").textContent = t("nm.err.none"); return }
  if (kind === "validate") { const bad = to.find(u => !canValidate(u)); if (bad) { $("nm_err").textContent = t("nm.err.cant", { name: user(bad).full }); return } }
  try { await api("POST", `/api/parts/${encodeURIComponent(p.id)}/notify`, { kind, to, message: msg }); $("notifyModal").hidden = true; await refresh(p.id); toast(t("toast.notified", { names: names(to) })) }
  catch (e) { if (e.status !== 401) $("nm_err").textContent = errText(e) }
}

/* ===================== Saisie des valeurs ===================== */
const MULT = { p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, m: 1e-3, "": 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, R: 1 };
function parseSI(raw, u) {
  if (raw == null) return null; if (typeof raw === "number") return raw;
  let s = String(raw).trim().replace(/\s+/g, "").replace(",", "."); if (!s) return null;
  if (u === "Ω") s = s.replace(/(ohms?|Ω)$/i, ""); else if (u && s.endsWith(u) && s.length > u.length) s = s.slice(0, -u.length);
  if (u === "Hz") s = s.replace(/hz$/i, "");
  const m = s.match(/^(-?\d*\.?\d+)([pnuµmkKMGR]?)(\d*)$/);
  if (!m) return NaN; if (m[2] === "R" && u !== "Ω") return NaN; if (m[3] && (m[1].includes(".") || !m[2])) return NaN;
  return +(parseFloat(m[1] + (m[3] ? "." + m[3] : "")) * MULT[m[2]]).toPrecision(12);
}
function parseBin(raw) { if (raw == null || raw === "") return null; if (typeof raw === "number") return raw; const m = String(raw).trim().replace(",", ".").match(/^(\d*\.?\d+)\s*(k|ko|kb|m|mo|mb)?$/i); if (!m) return NaN; const u = (m[2] || "").toLowerCase(); return Math.round(parseFloat(m[1]) * (u.startsWith("k") ? 1024 : u.startsWith("m") ? 1048576 : 1)) }
function parseParam(d, raw) { if (d.si === 1) return parseSI(raw, d.u); if (d.si === 2) return parseBin(raw); return raw == null || String(raw).trim() === "" ? null : String(raw).trim() }

/* ===================== Import et modification ===================== */
let impMode = { mode: "new" }, imp, f, askChoice = null, enrichState = { k: "enrich.idle", v: null };
const isEdit = () => impMode.mode === "edit" && imp && imp.orig;
function resetImport() {
  askChoice = null;
  imp = { uploads: [], sid: null, man: null, cand: 0, sel: { sym: null, fp: null, step: null, pdf: null }, busy: false, orig: null };
  f = { cat: "", mpn: "", mfr: "", desc: "", comment: "", pkg: "", mount: "smd", tmin: "", tmax: "", lc: "active", p: {}, sup: [["Mouser", ""]], alt: [], dsUrl: "" };
  enrichState = { k: "enrich.idle", v: null };
}
resetImport();
const EXT_TAG = { sch: ["SchLib", "sch"], pcb: ["PcbLib", "pcb"], "3d": ["STEP", ""], doc: ["PDF", ""], zip: ["ZIP", ""], intlib: ["IntLib", "sch"], bad: [null, "bad"] };

async function handleFiles(list) {
  const arr = [...list]; if (!arr.length) return;
  imp.uploads.push(...arr); await upload();
}
async function upload() {
  if (!imp.uploads.length) { imp.sid = null; imp.man = null; imp.sel = { sym: null, fp: null, step: null, pdf: null }; renderImport(); return }
  imp.busy = true; renderImport();
  const fd = new FormData(); imp.uploads.forEach(fl => fd.append("files", fl, fl.name));
  try {
    const man = await api("POST", "/api/imports", fd, true);
    imp.sid = man.sid; imp.man = man; imp.busy = false;
    if (isEdit()) imp.sel = { sym: man.symbols.length ? 0 : null, fp: man.footprints.length ? 0 : null, step: man.steps.length ? 0 : null, pdf: man.pdfs.length ? 0 : null };
    else pickCandidate(0, true);
  } catch (e) { imp.busy = false; if (e.status !== 401) showErr(e) }
  renderImport();
}
function pickCandidate(i, fill) {
  const m = imp.man; if (!m) return;
  const c = m.candidates[i];
  if (!c) { imp.sel = { sym: null, fp: m.footprints.length ? 0 : null, step: m.steps.length ? 0 : null, pdf: m.pdfs.length ? 0 : null }; return }
  imp.cand = i; imp.sel = { sym: c.sym, fp: c.fp, step: c.step, pdf: c.pdf };
  if (fill) {
    f.mpn = c.mpn || f.mpn; f.mfr = c.mfr || f.mfr; f.desc = c.desc || f.desc; f.comment = c.comment || f.comment || c.mpn;
    if (c.sup && c.sup.length) f.sup = c.sup.map(s => [...s]);
    if (c.dsUrl) f.dsUrl = c.dsUrl;
  }
}
function renderFiles() {
  const m = imp.man;
  const cur = isEdit() ? [[imp.orig.sym.file, "sch", imp.sel.sym != null], [imp.orig.fp.file, "pcb", imp.sel.fp != null]].map(([n2, k, rep]) => `<div class="fitem"><span class="ftag ${EXT_TAG[k][1]}">${EXT_TAG[k][0]}</span><span class="nm">${rep ? `<s>${esc((n2 || "").split("/").pop())}</s>` : esc((n2 || "").split("/").pop())}<small>${rep ? t("chk.replaced") : t("imp.current")}</small></span><span></span></div>`).join("") : "";
  const files = m ? m.files : imp.uploads.map(x => ({ name: x.name, size: x.size, kind: "zip", from: "" }));
  $("fileZone").hidden = !files.length && !isEdit();
  $("flist").innerHTML = cur + files.map(x => {
    const tg = EXT_TAG[x.kind] || EXT_TAG.bad, top = !x.from;
    const i = top ? imp.uploads.findIndex(u => u.name === x.name) : -1;
    return `<div class="fitem ${top ? "" : "sub"}"><span class="ftag ${tg[1]}">${tg[0] || t("tag.ignored")}</span><span class="nm">${esc(x.name)}<small>${kb(x.size)}${x.kind === "bad" ? t("imp.unsupported") : ""}</small></span>${top && i >= 0 ? `<button class="icon-btn" type="button" data-rm="${i}" aria-label="${esc(t("imp.remove", { name: x.name }))}">✕</button>` : "<span></span>"}</div>`
  }).join("");
  $("fnote").textContent = m ? t("imp.noteReal") : "";
  const w = m ? m.warnings : [];
  $("impWarn").hidden = !w.length;
  $("impWarn").innerHTML = w.map(x => `<li>${esc(t("warn." + x.code, { file: x.file || x.name || "" }, t("warn.generic", { file: x.file || x.name || "" })))}</li>`).join("");
}
function renderPick() {
  const m = imp.man, row = $("pickRow");
  if (!m) { row.hidden = true; row.innerHTML = ""; return }
  const keep = isEdit() ? `<option value="">${t("imp.pick.keep")}</option>` : "";
  const none = `<option value="">${t("imp.pick.none")}</option>`;
  const sel = (id, label, opts, val, blank) => `<div class="fld"><label for="${id}">${label}</label><select id="${id}">${blank}${opts.map(([v, l]) => `<option value="${v}" ${String(val) === String(v) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>`;
  let h = "";
  if (!isEdit() && m.candidates.length > 1) h += sel("pk_cand", t("imp.pick.cand"), m.candidates.map((c, i) => [i, `${m.symbols[c.sym].name} · ${c.mpn}`]), imp.cand, "");
  h += sel("pk_sym", t("imp.pick.sym"), m.symbols.map(s => [s.idx, `${s.name} · ${tn("imp.pins", s.pins)}`]), imp.sel.sym ?? "", isEdit() ? keep : `<option value="">${t("f.choose")}</option>`);
  h += sel("pk_fp", t("imp.pick.fp"), m.footprints.map(x => [x.idx, `${x.name} · ${tn("imp.pads", x.pads)}${x.has3d ? " · 3D" : ""}`]), imp.sel.fp ?? "", isEdit() ? keep : `<option value="">${t("f.choose")}</option>`);
  if (m.steps.length) h += sel("pk_step", t("imp.pick.step"), m.steps.map(x => [x.idx, x.name]), imp.sel.step ?? "", none);
  if (m.pdfs.length) h += sel("pk_pdf", t("imp.pick.pdf"), m.pdfs.map(x => [x.idx, x.name]), imp.sel.pdf ?? "", none);
  row.innerHTML = h; row.hidden = false;
}
function renderPreviews() {
  const m = imp.man, s = imp.sel, html = [];
  if (m && s.sym != null) html.push(pv("sym", `/api/imports/${m.sid}/svg/sym/${s.sym}`, m.symbols[s.sym].name));
  else if (isEdit()) html.push(pv("sym", partSvg(imp.orig, "symbol"), imp.orig.sym.ref));
  if (m && s.fp != null) html.push(pv("fp", `/api/imports/${m.sid}/svg/fp/${s.fp}`, m.footprints[s.fp].name));
  else if (isEdit()) html.push(pv("fp", partSvg(imp.orig, "footprint"), imp.orig.fp.ref));
  $("impPreviews").innerHTML = html.join("");
}
function renderImport() {
  const ed = isEdit();
  $("impTitle").textContent = ed ? t("imp.editTitle", { id: imp.orig.id }) : t("imp.title");
  $("c1Title").textContent = ed ? t("imp.c1edit") : t("imp.c1"); $("c1Sub").textContent = ed ? t("imp.c1editSub") : t("imp.c1sub");
  $("busy").hidden = !imp.busy;
  renderFiles(); renderPick(); renderPreviews();
  $("enrichRow").hidden = !SETTINGS.mouser;
  $("enrichMsg").textContent = t(enrichState.k, enrichState.v);
  const vs = validatorsFor(ME);
  $("askSel").innerHTML = vs.map(u => `<option value="${esc(u)}">${esc(USERS[u].full)} · ${esc(titleText(u))}</option>`).join("") + `<option value="">${t("imp.askNone")}</option>`;
  $("askSel").value = askChoice !== null && (askChoice === "" || vs.includes(askChoice)) ? askChoice : (vs[0] || "");
  renderForm(); updateChecks();
}
function catOptions() { return `<option value="">${t("f.choose")}</option>` + GROUPS.map(g => g.cats.length ? `<optgroup label="${esc(gName(g))}">${g.cats.map(cid => CATS[cid] ? `<option value="${esc(cid)}" ${f.cat === cid ? "selected" : ""}>${esc(cName(CATS[cid]))}</option>` : "").join("")}</optgroup>` : "").join("") }
function fld(key, label, o = {}) {
  const req = o.req ? ' <span class="req">*</span>' : ""; const v = f[key] ?? "";
  const ctl = o.select ? `<select id="f_${key}" data-f="${key}">${o.select}</select>` : `<input id="f_${key}" data-f="${key}" ${o.type ? `type="${o.type}"` : ""} class="${o.mono ? "mono" : ""}" value="${esc(v)}" placeholder="${esc(o.ph || "")}" autocomplete="off">`;
  return `<div class="fld ${o.wide ? "wide" : ""}"><label for="f_${key}">${label}${req}</label>${ctl}<span class="hint" id="h_${key}"></span></div>`;
}
function exampleFor(d) { return { Ω: "4k7", F: "100n", V: "50", A: "300m", W: "0.1", Hz: "25M", m: "2.54mm" }[d.u] || "1" }
function renderForm() {
  const c = CATS[f.cat];
  let h = fld("cat", t("f.cat"), { req: 1, select: catOptions() })
    + fld("mpn", t("f.mpn"), { req: 1, mono: 1 })
    + fld("mfr", t("f.mfr"), { req: 1, ph: t("f.mfrPh") })
    + fld("comment", t("f.comment"), { req: 1, mono: 1, ph: t("f.commentPh") })
    + fld("desc", t("f.desc"), { req: 1, wide: 1, ph: t("f.descPh") })
    + fld("pkg", t("f.pkg"), { req: 1, ph: t("f.pkgPh") })
    + fld("mount", t("f.mount"), { select: ["smd", "tht"].map(x => `<option value="${x}" ${f.mount === x ? "selected" : ""}>${t("mount." + x)}</option>`).join("") })
    + fld("tmin", t("f.tmin"), { type: "number", ph: "-40" })
    + fld("tmax", t("f.tmax"), { type: "number", ph: "125" })
    + fld("lc", t("f.lc"), { select: ["active", "nrnd", "obsolete"].map(x => `<option value="${x}" ${f.lc === x ? "selected" : ""}>${t("lc." + x)}</option>`).join("") })
    + fld("dsUrl", t("f.dsUrl"), { wide: 1, ph: "https://…" });
  h += `<div class="subh">${t("f.params")}${c ? " · " + esc(cName(c)) : ""}</div>`;
  if (!c) h += `<p class="note" style="grid-column:1/-1">${t("f.pickCat")}</p>`;
  else c.params.forEach(d => {
    const raw = f.p[d.k] ?? ""; const unit = d.si === 1 ? d.u : d.si === 2 ? t("unit.b") : "";
    const ph = d.si === 1 ? t("f.eg", { v: exampleFor(d) }) : d.si === 2 ? t("f.eg", { v: "128k" }) : "";
    h += `<div class="fld"><label for="p_${esc(d.k)}">${esc(pLabel(d))}${unit ? ` <span style="color:var(--faint);font-weight:400">(${esc(unit)})</span>` : ""}</label><input id="p_${esc(d.k)}" data-p="${esc(d.k)}" class="${d.si ? "mono" : ""}" value="${esc(raw)}" placeholder="${esc(ph)}" autocomplete="off"><span class="hint" id="hp_${esc(d.k)}"></span></div>`
  });
  h += `<div class="subh">${t("f.distris")}</div><div class="suprows">` + f.sup.map((s, i) => `<div class="suprow"><select data-sn="${i}" aria-label="${esc(t("f.distri", { n: i + 1 }))}">${DISTRIS.map(x => `<option value="${x}" ${s[0] === x ? "selected" : ""}>${esc(distriName(x))}</option>`).join("")}</select><input data-ss="${i}" value="${esc(s[1])}" placeholder="${esc(t("f.sku"))}" aria-label="${esc(t("f.sku"))}"><button class="icon-btn" type="button" data-sd="${i}" aria-label="${esc(t("f.removeDistri"))}">✕</button></div>`).join("") + `<button class="link-btn" type="button" id="supAdd">${t("f.addDistri")}</button></div>`;
  h += `<div class="subh">${t("f.alts")}</div><div class="suprows">` + f.alt.map((s, i) => `<div class="suprow"><input data-an="${i}" value="${esc(s[0])}" placeholder="${esc(t("f.mfr"))}" aria-label="${esc(t("f.mfr"))}" style="font-family:var(--f-body)"><input data-am="${i}" value="${esc(s[1])}" placeholder="MPN" aria-label="MPN"><button class="icon-btn" type="button" data-ad="${i}" aria-label="${esc(t("f.removeAlt"))}">✕</button></div>`).join("") + `<button class="link-btn" type="button" id="altAdd">${t("f.addAlt")}</button></div>`;
  $("form").innerHTML = h;
  if (c) c.params.forEach(d => paramHint(d));
  mpnHint();
}
function paramHint(d) {
  const el = $("hp_" + d.k), inp = $("p_" + d.k); if (!el) return;
  const raw = f.p[d.k]; if (raw == null || String(raw).trim() === "") { el.textContent = ""; el.className = "hint"; inp.classList.remove("err"); return }
  const v = parseParam(d, raw);
  if (d.si && (v == null || Number.isNaN(v))) { el.textContent = t("hint.bad"); el.className = "hint bad"; inp.classList.add("err") }
  else { el.textContent = d.si ? "= " + fmtParam(d, v) : ""; el.className = "hint ok"; inp.classList.remove("err") }
}
const dupOf = m => P.find(p => p.mpn.toLowerCase() === m.toLowerCase() && !(isEdit() && p.id === imp.orig.id));
function mpnHint() {
  const el = $("h_mpn"); if (!el) return; const m = f.mpn.trim(); const ex = m && dupOf(m);
  if (!m) { el.textContent = ""; el.className = "hint" } else if (ex) { el.textContent = t("hint.exists", { id: ex.id }); el.className = "hint bad" } else { el.textContent = t("hint.new"); el.className = "hint ok" }
}
function computeChecks() {
  const c = CATS[f.cat], L = [], m = f.mpn.trim(), man = imp.man, s = imp.sel;
  const symE = man && s.sym != null ? man.symbols[s.sym] : null, fpE = man && s.fp != null ? man.footprints[s.fp] : null;
  if (isEdit()) {
    L.push({ lvl: "ok", t: t("chk.sym.ok"), d: symE ? t("chk.replaced") : t("chk.unchanged") });
    L.push({ lvl: "ok", t: t("chk.fp.ok"), d: fpE ? t("chk.replaced") : t("chk.unchanged") });
  } else {
    L.push(symE ? { lvl: "ok", t: t("chk.sym.ok"), d: `${symE.name} · ${tn("imp.pins", symE.pins)}` } : { lvl: "fail", t: t("chk.sym.fail"), d: t("chk.sym.failD") });
    L.push(fpE ? { lvl: "ok", t: t("chk.fp.ok"), d: `${fpE.name} · ${tn("imp.pads", fpE.pads)}` } : { lvl: "fail", t: t("chk.fp.fail"), d: t("chk.fp.failD") });
  }
  if (symE && fpE) {
    const a = new Set(symE.pin_ids), b = new Set(fpE.pad_ids), po = [...a].filter(x => !b.has(x)), fo = [...b].filter(x => !a.has(x));
    L.push(!po.length && !fo.length ? { lvl: "ok", t: t("chk.pins.ok"), d: t("chk.pins.okN", { a: symE.pins, b: fpE.pads }) } : { lvl: "warn", t: t("chk.pins.mismatch"), d: t("chk.pins.mismatchD", { a: po.join(", ") || "—", b: fo.join(", ") || "—" }) });
  } else if (symE || fpE) L.push({ lvl: "warn", t: t("chk.pins.warn"), d: t("chk.pins.warnEdit") });
  const ex = m && dupOf(m);
  L.push(!m ? { lvl: "fail", t: t("chk.mpn.missing"), d: "", step: 2 } : ex ? { lvl: "fail", t: t("chk.mpn.dup"), d: t("chk.mpn.dupD", { mpn: ex.mpn, id: ex.id }), step: 2 } : { lvl: "ok", t: t("chk.mpn.ok"), d: m });
  const req = { cat: "f.cat", mfr: "f.mfr", comment: "d.comment", desc: "f.desc", pkg: "f.pkg" };
  const miss = Object.keys(req).filter(k => !String(f[k]).trim()).map(k => t(req[k]));
  L.push(miss.length ? { lvl: "fail", t: t("chk.req.fail"), d: miss.join(", "), step: 2 } : { lvl: "ok", t: t("chk.req.ok"), d: "" });
  if (f.tmin !== "" && f.tmax !== "" && +f.tmin >= +f.tmax) L.push({ lvl: "fail", t: t("chk.temp.fail"), d: t("chk.temp.failD"), step: 2 });
  if (c) {
    const bad = c.params.filter(d => { const v = parseParam(d, f.p[d.k]); return d.si && f.p[d.k] && (v == null || Number.isNaN(v)) });
    const filled = c.params.filter(d => String(f.p[d.k] ?? "").trim() !== "").length, cnt = t("chk.param.count", { a: filled, b: c.params.length });
    L.push(bad.length ? { lvl: "fail", t: t("chk.param.bad"), d: bad.map(pLabel).join(", "), step: 2 } : filled < c.params.length ? { lvl: "warn", t: cnt, d: t("chk.param.warnD") } : { lvl: "ok", t: cnt, d: "" })
  }
  const has3d = (fpE && fpE.has3d) || (s.step != null && (fpE || isEdit())) || (!fpE && isEdit() && imp.orig.fp.has3d);
  L.push(has3d ? { lvl: "ok", t: t("chk.3d.ok"), d: fpE && fpE.has3d ? t("chk.3d.inFp") : t("chk.3d.okD") } : { lvl: "warn", t: t("chk.3d.warn"), d: t("chk.3d.warnD") });
  const hasDs = s.pdf != null || f.dsUrl.trim() || (isEdit() && imp.orig.ds);
  L.push(hasDs ? { lvl: "ok", t: t("chk.ds.ok"), d: s.pdf != null && man ? man.pdfs[s.pdf].name : f.dsUrl } : { lvl: "warn", t: t("chk.ds.warn"), d: t("chk.ds.warnD") });
  L.push(f.sup.some(x => x[1].trim()) ? { lvl: "ok", t: t("chk.sup.ok"), d: f.sup.filter(x => x[1].trim()).map(x => distriName(x[0])).join(", ") } : { lvl: "warn", t: t("chk.sup.warn"), d: t("chk.sup.warnD") });
  return L;
}
function buildData() {
  const c = CATS[f.cat], p = {}; if (c) c.params.forEach(d => { const v = parseParam(d, f.p[d.k]); p[d.k] = Number.isNaN(v) ? null : v });
  const n2 = x => x === "" || x == null ? null : +x;
  return { cat: f.cat, mpn: f.mpn.trim(), mfr: f.mfr.trim(), desc: f.desc.trim(), comment: f.comment.trim(), pkg: f.pkg.trim(), mount: f.mount, t: [n2(f.tmin), n2(f.tmax)], lc: f.lc, p, sup: f.sup.filter(s => s[1].trim()).map(s => [s[0], s[1].trim()]), dsUrl: f.dsUrl.trim() };
}
const editRep = () => ({ sym: imp.sel.sym != null && !!imp.man, fp: imp.sel.fp != null && !!imp.man, fpRef: imp.man && imp.sel.fp != null ? imp.man.footprints[imp.sel.fp].name : null, ds: imp.sel.pdf != null && !!imp.man });
const computeDiff = () => diffParts(imp.orig, buildData(), editRep()).concat(JSON.stringify(f.alt.filter(a => a[1].trim())) !== JSON.stringify(imp.orig.alt || []) ? [{ l: t("f.alts"), a: (imp.orig.alt || []).map(a => a.join(" ")).join(", ") || "—", b: f.alt.filter(a => a[1].trim()).map(a => a.join(" ")).join(", ") || "—" }] : []);
function updateChecks() {
  const checks = computeChecks(), ed = isEdit(), open = ed || !!imp.man;
  const s1 = ed || (imp.man && imp.sel.sym != null && imp.sel.fp != null), s2 = s1 && !checks.some(x => x.lvl === "fail" && x.step === 2);
  const cur = !s1 ? 1 : !s2 ? 2 : 3;
  [...$("steps").children].forEach(li => { const k = +li.dataset.s; li.className = k < cur ? "done" : k === cur ? "cur" : ""; li.querySelector("i").textContent = k < cur ? "✓" : k });
  $("card2").classList.toggle("locked", !open); $("card3").classList.toggle("locked", !open);
  const D = ed ? computeDiff() : [];
  $("diffBox").innerHTML = ed ? (D.length ? `<p class="diff-h">${tn("diff.title", D.length)}</p>${diffTable(D)}` : `<p class="note">${t("diff.none")}</p>`) : "";
  const ic = { ok: "✓", warn: "!", fail: "✕" };
  $("checks").innerHTML = checks.map(x => `<div class="chk ${x.lvl}"><span class="ic">${ic[x.lvl]}</span><span>${esc(x.t)}${x.d ? `<small>${esc(x.d)}</small>` : ""}</span></div>`).join("");
  const fails = checks.filter(x => x.lvl === "fail").length, warns = checks.filter(x => x.lvl === "warn").length, w = warns ? tn("submit.warns", warns) : "";
  $("submitBtn").textContent = ed ? (imp.orig.st === "draft" ? t("imp.submitEditDraft") : t("imp.submitEditValid")) : t("imp.submit");
  $("submitBtn").disabled = fails > 0 || !open || imp.busy || (ed && !D.length);
  $("submitMsg").textContent = !open ? t("submit.noFiles") : fails ? tn("submit.fails", fails) : ed ? (!D.length ? t("submit.noChange") : imp.orig.st === "draft" ? t("submit.editDraft", { w }) : t("submit.editValid", { w })) : t("submit.ok", { w });
}
async function enrich() {
  const m = f.mpn.trim();
  if (!m) { enrichState = { k: "enrich.noMpn", v: null }; $("enrichMsg").textContent = t(enrichState.k); return }
  $("enrichMsg").textContent = "…";
  try {
    const e = await api("GET", "/api/enrich?mpn=" + encodeURIComponent(m));
    if (!e.found) enrichState = { k: "enrich.none", v: { mpn: m } };
    else {
      if (e.mfr) f.mfr = e.mfr; if (e.desc && !f.desc) f.desc = e.desc; if (e.pkg && !f.pkg) f.pkg = e.pkg;
      if (e.tmin != null) f.tmin = String(e.tmin); if (e.tmax != null) f.tmax = String(e.tmax); if (e.lc) f.lc = e.lc; if (e.dsUrl && !f.dsUrl) f.dsUrl = e.dsUrl;
      (e.sup || []).forEach(s => { const i = f.sup.findIndex(x => x[0] === s[0]); if (i >= 0) f.sup[i] = s; else f.sup.push(s) });
      f.sup = f.sup.filter(x => x[1].trim() || f.sup.length === 1);
      enrichState = { k: "enrich.ok", v: null }; renderForm();
    }
  } catch (e) { enrichState = { k: "err.enrich_failed", v: null } }
  $("enrichMsg").textContent = t(enrichState.k, enrichState.v); updateChecks();
}
const formPayload = () => ({ ...f, alt: f.alt.filter(a => a[1].trim()) });
async function submitImport() {
  const ask = $("askSel").value || null;
  $("submitBtn").disabled = true;
  try {
    if (isEdit()) {
      const p = imp.orig, rep = imp.man ? { sid: imp.sid, sym: imp.sel.sym, fp: imp.sel.fp, step: imp.sel.step, pdf: imp.sel.pdf } : null;
      const r = await api("PUT", `/api/parts/${encodeURIComponent(p.id)}`, { form: formPayload(), ask, replace: rep });
      const proposed = !!r.pending;
      impMode = { mode: "new" }; resetImport(); showExplore();
      Object.assign(st, { cat: r.cat, q: "", status: "all", mount: "", pkg: "", by: "" }); $("q").value = "";
      await refresh(r.id); $("detail").classList.remove("closed");
      toast(proposed ? (ask ? t("toast.proposedAsk", { mpn: r.mpn, name: user(ask).full }) : t("toast.proposed", { mpn: r.mpn })) : t("toast.edited", { mpn: r.mpn }));
    } else {
      const r = await api("POST", `/api/imports/${imp.sid}/commit`, { cand: { ...imp.sel }, form: formPayload(), ask });
      resetImport(); showExplore();
      Object.assign(st, { cat: r.cat, q: "", status: "all", mount: "", pkg: "", by: "" }); $("q").value = "";
      await refresh(r.id); $("detail").classList.remove("closed");
      toast(ask ? t("toast.addedAsk", { mpn: r.mpn, name: user(ask).full }) : t("toast.added", { mpn: r.mpn }));
    }
  } catch (e) { if (e.status !== 401) showErr(e); updateChecks() }
}
function openEdit(p) {
  resetImport(); impMode = { mode: "edit", id: p.id }; imp.orig = p;
  f = { cat: p.cat, mpn: p.mpn, mfr: p.mfr, desc: p.desc, comment: p.comment, pkg: p.pkg, mount: p.mount, tmin: p.t[0] == null ? "" : String(p.t[0]), tmax: p.t[1] == null ? "" : String(p.t[1]), lc: p.lc, p: {}, sup: p.sup.length ? p.sup.map(s => [...s]) : [["Mouser", ""]], alt: (p.alt || []).map(a => [...a]), dsUrl: (p.ds && p.ds.url) || "" };
  (CATS[p.cat] || { params: [] }).params.forEach(d => { const v = p.p[d.k]; f.p[d.k] = v == null ? "" : d.si ? String(fmtParam(d, v)).replace(/\s+/g, "") : String(v) });
  askChoice = p.st === "draft" ? "" : null;
  showImportView();
}
function openImport() { if (impMode.mode !== "new") { impMode = { mode: "new" }; resetImport() } showImportView() }
function showImportView() { closePops(); $("viewExplore").hidden = true; $("viewImport").hidden = false; $("addBtn").hidden = true; $("q").closest(".search").style.visibility = "hidden"; renderImport(); window.scrollTo(0, 0) }
function showExplore() { if (impMode.mode === "edit") { impMode = { mode: "new" }; resetImport() } $("viewImport").hidden = true; $("viewExplore").hidden = false; $("addBtn").hidden = false; $("q").closest(".search").style.visibility = "" }

/* ===================== Nouvelle catégorie ===================== */
const PTYPES = ["num", "bin", "txt"], UNITS = ["Ω", "F", "H", "V", "A", "W", "Hz", "m", "s", "°C", "dB", "%"];
const slug = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");
let cm = { params: [] };
function renderCmGroups(sel) { $("cm_group").innerHTML = GROUPS.map(g => `<option value="${esc(g.id)}" ${g.id === sel ? "selected" : ""}>${esc(gName(g))}</option>`).join("") + `<option value="__new" ${sel === "__new" ? "selected" : ""}>${t("cm.newGroupOpt")}</option>` }
function openCatModal() {
  cm = { params: [{ l: "", type: "num", u: "V" }] };
  renderCmGroups(st.cat !== "all" && CATS[st.cat] ? CATS[st.cat].group : (GROUPS[0] || {}).id);
  $("cm_name").value = ""; $("cm_newgroup").value = ""; $("cm_newgroupWrap").hidden = true; $("cm_err").textContent = "";
  renderCmParams(); updateCmPreview(); $("catModal").hidden = false; $("cm_name").focus();
}
function renderCmParams() {
  $("cm_params").innerHTML = cm.params.map((p, i) => `<div class="prow">
    <input data-pl="${i}" value="${esc(p.l)}" placeholder="${esc(t("cm.paramPh"))}" aria-label="${esc(t("cm.paramAria", { n: i + 1 }))}" autocomplete="off">
    <select data-pt="${i}" aria-label="${esc(t("cm.type"))}">${PTYPES.map(v => `<option value="${v}" ${p.type === v ? "selected" : ""}>${t("cm.t." + v)}</option>`).join("")}</select>
    <select data-pu="${i}" aria-label="${esc(t("cm.unit"))}" ${p.type !== "num" ? "disabled" : ""}>${p.type === "num" ? UNITS.map(u => `<option ${p.u === u ? "selected" : ""}>${u}</option>`).join("") : `<option>${p.type === "bin" ? t("unit.b") : "—"}</option>`}</select>
    <button class="icon-btn" type="button" data-pd="${i}" aria-label="${esc(t("cm.removeParam"))}">✕</button></div>`).join("") || `<p class="note">${t("cm.noParam")}</p>`;
}
function updateCmPreview() {
  const nm2 = $("cm_name").value.trim(); const cols = cm.params.filter(p => p.l.trim()).map(p => p.l.trim() + (p.type === "num" ? ` (${p.u})` : ""));
  $("cm_preview").innerHTML = nm2 ? t("cm.preview", { id: esc(slug(nm2) || "…") }).replace("v_", "") + (cols.length ? ", <b>" + esc(cols.join(", ")) + "</b>" : "") : "";
}
async function createCat() {
  const name = $("cm_name").value.trim(), err = k => { $("cm_err").textContent = k };
  if (!name) return err(t("cm.err.name"));
  const rows = cm.params.filter(p => p.l.trim()), labels = rows.map(p => p.l.trim().toLowerCase()), dup = labels.find((l, i) => labels.indexOf(l) !== i);
  if (dup) return err(t("cm.err.dup", { name: dup }));
  const group = $("cm_group").value, newGroup = $("cm_newgroup").value.trim();
  if (group === "__new" && !newGroup) return err(t("cm.err.group"));
  try {
    const r = await api("POST", "/api/categories", { name, group, newGroup, params: rows.map(p => ({ l: p.l.trim(), type: p.type, u: p.u })) });
    $("catModal").hidden = true; Object.assign(st, { cat: r.id, sel: null, sort: { k: "comment", dir: 1 }, pkg: "" });
    await refresh(); if (narrow()) $("detail").classList.add("closed");
    toast(t("toast.catCreated", { name, id: r.view }).replace("v_", ""));
  } catch (e) { if (e.status !== 401) err(errText(e)) }
}

/* ===================== Langue ===================== */
async function loadLang(l) { if (!LANG_FILES[l]) LANG_FILES[l] = await (await fetch(`/static/locales/${l}.json`)).json() }
async function setLang(l) {
  if (l === LANG) return; await loadLang(l); LANG = l; try { localStorage.setItem("lib-lang", l) } catch (e) { }
  applyStatic();
  if (!$("viewApp").hidden) {
    renderUser(); renderBell(); render(); if (!$("viewImport").hidden) renderImport();
    if (!$("notifPop").hidden) renderNotifPop(); if (!$("userPop").hidden) renderUserPop(); if (!$("teamModal").hidden) renderTeam();
    if (!$("notifyModal").hidden) { const k = $("nm_kind").value, kinds = [...$("nm_kind").options].map(o => o.value); $("nm_kind").innerHTML = kinds.map(x => `<option value="${x}" ${x === k ? "selected" : ""}>${t("nm.k." + x)}</option>`).join(""); renderNotify() }
    if (!$("catModal").hidden) { renderCmGroups($("cm_group").value); renderCmParams(); updateCmPreview() }
  }
}

/* ===================== Connexion ===================== */
function showLogin() { $("viewApp").hidden = true; $("viewLogin").hidden = false; document.querySelectorAll(".modal-bg").forEach(m => m.hidden = true); setTimeout(() => $("lg_email").focus(), 0) }
async function startApp() {
  await loadAll(); $("viewLogin").hidden = true; $("viewApp").hidden = false;
  applyStatic(); renderUser(); renderBell(); render(); showExplore();
  if (narrow()) $("detail").classList.add("closed"); else $("detail").classList.remove("closed");
}
$("loginForm").addEventListener("submit", async e => {
  e.preventDefault(); $("lg_err").textContent = "";
  try { await api("POST", "/api/login", { email: $("lg_email").value, password: $("lg_pw").value }); $("lg_pw").value = ""; await startApp() }
  catch (err) { $("lg_err").textContent = errText(err) }
});

/* ===================== Évènements ===================== */
document.querySelectorAll("[data-langseg]").forEach(seg => seg.addEventListener("click", e => { const b = e.target.closest("button[data-l]"); if (b) setLang(b.dataset.l) }));
$("tree").addEventListener("click", e => {
  if (e.target.closest("#newCatBtn")) { openCatModal(); return }
  const b = e.target.closest(".cat"); if (!b) return; st.cat = b.dataset.c;
  if (st.sort.k.startsWith("p.")) st.sort = { k: "comment", dir: 1 };
  if (st.cat !== "all") { const ps = filtered(); if (ps.length && !ps.some(p => p.id === st.sel)) st.sel = narrow() ? st.sel : ps[0].id }
  render(); $("treePane").classList.remove("open")
});
$("thead").addEventListener("click", e => { const th = e.target.closest("th"); if (!th) return; const k = th.dataset.k; st.sort = st.sort.k === k ? { k, dir: -st.sort.dir } : { k, dir: 1 }; renderTable() });
$("thead").addEventListener("keydown", e => { if (e.key === "Enter" && e.target.matches("th")) e.target.click() });
$("tbody").addEventListener("click", e => { const tr = e.target.closest("tr"); if (tr) select(tr.dataset.id) });
$("tbody").addEventListener("keydown", e => {
  const tr = e.target.closest("tr"); if (!tr) return;
  if (e.key === "Enter") select(tr.dataset.id);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const nx = e.key === "ArrowDown" ? tr.nextElementSibling : tr.previousElementSibling; if (nx) { select(nx.dataset.id, false); document.querySelector(`tr[data-id="${CSS.escape(nx.dataset.id)}"]`).focus() } }
});
$("q").addEventListener("input", e => { st.q = e.target.value; renderTable() });
document.addEventListener("keydown", e => {
  const a = document.activeElement;
  if (e.key === "/" && !$("viewApp").hidden && !$("viewExplore").hidden && ![...document.querySelectorAll(".modal-bg")].some(m => !m.hidden) && !(a && a.matches("input,select,textarea"))) { e.preventDefault(); $("q").focus() }
  if (e.key === "Escape") { closePops(); ["catModal", "notifyModal", "teamModal", "pwModal", "altiumModal"].forEach(id => $(id).hidden = true) }
});
$("statusSeg").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; st.status = b.dataset.v; renderFilterOptions(); renderTable() });
$("mountSel").addEventListener("change", e => { st.mount = e.target.value; renderTable() });
$("pkgSel").addEventListener("change", e => { st.pkg = e.target.value; renderTable() });
$("bySel").addEventListener("change", e => { st.by = e.target.value; renderTable() });
$("resetBtn").addEventListener("click", () => { Object.assign(st, { q: "", status: "all", mount: "", pkg: "", by: "" }); $("q").value = ""; render() });
$("addBtn").addEventListener("click", () => openImport());
$("toggleTree").addEventListener("click", () => $("treePane").classList.toggle("open"));

$("bellBtn").addEventListener("click", e => { e.stopPropagation(); togglePop("notifPop", $("bellBtn"), renderNotifPop) });
$("userChip").addEventListener("click", e => { e.stopPropagation(); togglePop("userPop", $("userChip"), renderUserPop) });
document.addEventListener("click", e => { if (!e.target.closest(".pop,#bellBtn,#userChip")) closePops() });
$("notifPop").addEventListener("click", async e => {
  if (e.target.closest("#markAll")) { NOTIFS.forEach(x => x.read = true); renderBell(); renderNotifPop(); api("POST", "/api/notifications/read", { all: true }).catch(() => { }); return }
  const b = e.target.closest("[data-n]"); if (!b) return;
  const x = NOTIFS.find(q => q.id === +b.dataset.n); x.read = true; renderBell(); closePops(); api("POST", "/api/notifications/read", { ids: [x.id] }).catch(() => { });
  const p = P.find(q => q.id === x.part); if (!p) return;
  if (!$("viewImport").hidden) showExplore();
  Object.assign(st, { cat: p.cat, q: "", status: p.st === "archived" ? "archived" : "all", mount: "", pkg: "", by: "", sel: p.id }); $("q").value = "";
  delete DETAIL[p.id]; render(); $("detail").classList.remove("closed");
});
$("userPop").addEventListener("click", async e => {
  if (e.target.closest("#openTeam")) { closePops(); openTeam(); return }
  if (e.target.closest("#openPw")) { closePops(); $("pw_old").value = ""; $("pw_new").value = ""; $("pw_err").textContent = ""; $("pwModal").hidden = false; $("pw_old").focus(); return }
  if (e.target.closest("#openAltium")) { closePops(); openAltium(); return }
  if (e.target.closest("#logoutBtn")) { closePops(); try { await api("POST", "/api/logout") } catch (x) { } showLogin() }
});
$("tm_close").addEventListener("click", () => $("teamModal").hidden = true);
$("tm_add").addEventListener("click", () => { editU = "__new"; renderTeam(); $("uf_full").focus() });
$("teamModal").addEventListener("click", e => {
  if (e.target === $("teamModal")) { $("teamModal").hidden = true; return }
  const m = e.target.closest("[data-mail]"); if (m) copy(m.dataset.mail);
  const ed = e.target.closest("[data-edit]"); if (ed) { editU = ed.dataset.edit; renderTeam(); $("uf_full").focus() }
  if (e.target.closest("#uf_cancel")) { editU = null; renderTeam() }
  if (e.target.closest("#uf_save")) saveUser();
});
$("pwForm").addEventListener("submit", async e => {
  e.preventDefault();
  try { await api("POST", "/api/me/password", { old: $("pw_old").value, new: $("pw_new").value }); $("pwModal").hidden = true; toast(t("toast.pwSaved")) }
  catch (err) { if (err.status !== 401) $("pw_err").textContent = errText(err) }
});
$("pw_cancel").addEventListener("click", () => $("pwModal").hidden = true);
$("al_close").addEventListener("click", () => $("altiumModal").hidden = true);
["altiumModal", "pwModal", "catModal", "notifyModal"].forEach(id => $(id).addEventListener("click", e => { if (e.target === $(id)) $(id).hidden = true }));

$("nm_kind").addEventListener("change", () => { $("nm_err").textContent = ""; renderNotify() });
$("nm_recips").addEventListener("change", e => { const c = e.target.closest("[data-r]"); if (!c) return; c.checked ? nm.sel.add(c.dataset.r) : nm.sel.delete(c.dataset.r); $("nm_err").textContent = "" });
$("nm_cancel").addEventListener("click", () => $("notifyModal").hidden = true);
$("nm_send").addEventListener("click", sendNotify);

$("backBtn").addEventListener("click", showExplore);
$("fileIn").addEventListener("change", e => { handleFiles(e.target.files); e.target.value = "" });
const dz = $("dropzone");
["dragenter", "dragover"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add("over") }));
["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, () => dz.classList.remove("over")));
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", e => { e.preventDefault(); if ($("viewApp").hidden || !e.dataTransfer || !e.dataTransfer.files.length) return; if ($("viewImport").hidden) openImport(); handleFiles(e.dataTransfer.files) });
$("flist").addEventListener("click", e => { const b = e.target.closest("[data-rm]"); if (!b) return; imp.uploads.splice(+b.dataset.rm, 1); upload() });
$("pickRow").addEventListener("change", e => {
  const x = e.target, v = x.value === "" ? null : +x.value;
  if (x.id === "pk_cand") pickCandidate(+x.value, true);
  else if (x.id === "pk_sym") imp.sel.sym = v; else if (x.id === "pk_fp") imp.sel.fp = v; else if (x.id === "pk_step") imp.sel.step = v; else if (x.id === "pk_pdf") imp.sel.pdf = v;
  renderImport();
});
$("form").addEventListener("input", e => {
  const x = e.target;
  if (x.dataset.f) { if (x.dataset.f === "cat") return; f[x.dataset.f] = x.value; if (x.dataset.f === "mpn") mpnHint() }
  else if (x.dataset.p) { f.p[x.dataset.p] = x.value; paramHint(CATS[f.cat].params.find(d => d.k === x.dataset.p)) }
  else if (x.dataset.ss != null) f.sup[+x.dataset.ss][1] = x.value;
  else if (x.dataset.an != null) f.alt[+x.dataset.an][0] = x.value;
  else if (x.dataset.am != null) f.alt[+x.dataset.am][1] = x.value;
  updateChecks()
});
$("form").addEventListener("change", e => {
  const x = e.target;
  if (x.dataset.f === "cat") { f.cat = x.value; f.p = {}; renderForm(); updateChecks() }
  else if (x.dataset.f) { f[x.dataset.f] = x.value; updateChecks() }
  else if (x.dataset.sn != null) { f.sup[+x.dataset.sn][0] = x.value; updateChecks() }
});
$("form").addEventListener("click", e => {
  if (e.target.id === "supAdd") { f.sup.push([DISTRIS[f.sup.length % DISTRIS.length], ""]); renderForm(); updateChecks() }
  if (e.target.id === "altAdd") { f.alt.push(["", ""]); renderForm(); updateChecks() }
  const d = e.target.closest("[data-sd]"); if (d) { f.sup.splice(+d.dataset.sd, 1); renderForm(); updateChecks() }
  const a = e.target.closest("[data-ad]"); if (a) { f.alt.splice(+a.dataset.ad, 1); renderForm(); updateChecks() }
});
$("enrichBtn").addEventListener("click", enrich);
$("askSel").addEventListener("change", e => { askChoice = e.target.value });
$("submitBtn").addEventListener("click", () => { if (!$("submitBtn").disabled) submitImport() });

$("cm_name").addEventListener("input", updateCmPreview);
$("cm_group").addEventListener("change", e => { const nw = e.target.value === "__new"; $("cm_newgroupWrap").hidden = !nw; if (nw) $("cm_newgroup").focus() });
$("cm_params").addEventListener("input", e => { const x = e.target; if (x.dataset.pl != null) { cm.params[+x.dataset.pl].l = x.value; updateCmPreview() } });
$("cm_params").addEventListener("change", e => {
  const x = e.target;
  if (x.dataset.pt != null) { cm.params[+x.dataset.pt].type = x.value; renderCmParams(); updateCmPreview() }
  if (x.dataset.pu != null) { cm.params[+x.dataset.pu].u = x.value; updateCmPreview() }
});
$("cm_params").addEventListener("click", e => { const b = e.target.closest("[data-pd]"); if (b) { cm.params.splice(+b.dataset.pd, 1); renderCmParams(); updateCmPreview() } });
$("cm_addParam").addEventListener("click", () => { cm.params.push({ l: "", type: "num", u: "V" }); renderCmParams(); const ins = $("cm_params").querySelectorAll("input"); ins[ins.length - 1].focus() });
$("cm_cancel").addEventListener("click", () => $("catModal").hidden = true);
$("cm_create").addEventListener("click", createCat);

/* ===================== Démarrage ===================== */
(async () => {
  await Promise.all([loadLang("fr"), loadLang(LANG)]);
  applyStatic();
  try { await startApp() } catch (e) { if (e.status !== 401) { showLogin(); $("lg_err").textContent = errText(e) } }
  setInterval(() => { if (!$("viewApp").hidden) loadNotifs() }, 30000);
})();
