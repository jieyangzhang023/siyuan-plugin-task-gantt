"use strict";
const { Plugin, openTab, showMessage, Menu, Dialog, fetchSyncPost, confirm: sConfirm } = require("siyuan");

const TAB = "gantt";
const DAY = 86400000;
const ROW_H = 34;
const LABEL_DEF = 320, LABEL_MIN = 200, LABEL_MAX = 640; // left label column width (user-resizable)
const STATUS_OPTIONS = [["all", "全部状态"], ["late", "只看超期"], ["doing", "只看进行中"], ["week", "只看本周"]];
const ZOOMS = { day: 36, week: 16, month: 6 };
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
// completed-task visibility: key -> look-back window in days (open/all handled separately)
const DONE_RANGES = { r7: 7, r30: 30, r90: 90, r180: 180, r365: 365 };
const DONE_OPTIONS = [["open", "仅未完成"], ["r7", "含近一周完成"], ["r30", "含近 30 天完成"], ["r90", "含近三个月完成"], ["r180", "含近半年完成"], ["r365", "含近一年完成"], ["all", "全部（含所有已完成）"]];
const FAR_AHEAD = 730; // timeline never extends more than ~2 years past today
const FAR_BACK = 1100; // ...or ~3 years before today
const MAX_DAY_CELLS = 900; // above this many days, the header uses weekly labels instead of one node per day
const STATE_COLOR = { open: "#3b82f6", done: "#22a05a", late: "#e5484d", dropped: "#8a8f98" };
const PRIO = { high: "高", medium: "中", low: "低" };
const LOG_FILE = "progress-log.json";
const TASKS_FILE = "tasks.json", PROJECTS_FILE = "projects.json"; // the plugin's own task store
const HIDDEN_FILE = "summary-hidden.json"; // task ids kept out of the 今日 / 未排期 lists (their subtasks too)
const RE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const KANBAN = { doing: "进行中", short_term: "短期", long_term: "长期", abandoned: "已放弃", completed: "已完成" };
const fmtMin = (m) => { m = Number(m) || 0; return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分钟` : `${m} 分钟`; };

/* ---------- date helpers (UTC day numbers, DST-safe) ---------- */
const toNum = (s) => {
  if (typeof s !== "string" || !RE_DATE.test(s)) return null;
  const ms = Date.parse(s + "T00:00:00Z"); // NaN for impossible dates such as 9999-99-99
  return Number.isFinite(ms) ? Math.round(ms / DAY) : null;
};
const fromNum = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const todayNum = () => {
  const d = new Date();
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
};
// epoch day 0 is a Thursday; Monday-based weekday index 0..6
const wday = (n) => (((n + 3) % 7) + 7) % 7;
const alignMonday = (n) => n - wday(n);
const ymd = (n) => {
  const d = new Date(n * DAY);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
};

const lsGet = (k, def) => {
  try { const v = localStorage.getItem(k); return v == null ? def : v; } catch (e) { return def; }
};
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } };

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style") el.style.cssText = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

/* ---------- model ---------- */
function buildModel(reminders, projects, opts) {
  const today = todayNum();
  const projMap = {};
  for (const [id, p] of Object.entries(projects || {})) {
    if (p && typeof p === "object") projMap[id] = p;
  }

  const nodes = new Map();
  for (const t of Object.values(reminders || {})) {
    if (!t || typeof t !== "object" || !t.id) continue;
    if (opts.project && t.projectId !== opts.project) continue;
    const s = toNum(t.date), e = toNum(t.endDate), a = toNum(t.availableStartDate);
    let start = null, end = null, kind = null, noEnd = false;
    if (s != null) { start = s; end = e != null && e >= s ? e : s; kind = "own"; noEnd = !(e != null && e >= s); }
    else if (e != null) { start = end = e; kind = "deadline"; }
    else if (a != null) { start = end = a; kind = "avail"; }
    if (t.completed) {
      if (opts.done === "open") continue;
      const win = DONE_RANGES[opts.done];
      if (win) {
        // judge by completion time; fall back to the task's end date when it has none
        const ct = toNum(String(t.completedTime || "").slice(0, 10));
        const when = ct != null ? ct : end;
        if (when == null || when < today - win) continue;
      }
    }
    // no end date + 进行中: an open-ended task, drawn from its start up to today instead of being treated as overdue
    const ongoing = kind === "own" && noEnd && !t.completed && t.kanbanStatus === "doing";
    nodes.set(t.id, { id: t.id, t, start, end, kind, noEnd, ongoing, vEnd: end == null ? null : ongoing ? Math.max(end, today) : end, children: [], parent: null, depth: 0 });
  }

  // link parents (guard against cycles)
  for (const n of nodes.values()) {
    const pid = n.t.parentId;
    const p = pid && nodes.get(pid);
    if (!p || p === n) continue;
    let cur = p, hops = 0, cyc = false;
    while (cur && hops++ < 64) { if (cur === n) { cyc = true; break; } cur = cur.parent; }
    if (cyc) continue;
    n.parent = p;
    p.children.push(n);
  }

  // span + progress (post-order)
  const calc = (n, depth) => {
    n.depth = depth;
    let lo = n.start, hi = n.vEnd, leaves = 0, doneLeaves = 0;
    for (const c of n.children) {
      calc(c, depth + 1);
      if (c.spanStart != null) { lo = lo == null ? c.spanStart : Math.min(lo, c.spanStart); hi = hi == null ? c.spanEnd : Math.max(hi, c.spanEnd); }
      leaves += c.leaves; doneLeaves += c.doneLeaves;
    }
    if (!n.children.length) { leaves = 1; doneLeaves = n.t.completed ? 1 : 0; }
    n.spanStart = lo; n.spanEnd = hi; n.leaves = leaves; n.doneLeaves = doneLeaves;
    const cp = Number(n.t.customProgress);
    n.progress = n.t.completed ? 1 : n.children.length ? doneLeaves / leaves : Number.isFinite(cp) && cp > 0 ? Math.min(cp, 100) / 100 : 0;
  };
  const roots = [...nodes.values()].filter((n) => !n.parent);
  roots.forEach((r) => calc(r, 0));

  const cmp = (a, b) => {
    const as = a.spanStart, bs = b.spanStart;
    if (as == null && bs == null) return (a.t.sort || 0) - (b.t.sort || 0);
    if (as == null) return 1;
    if (bs == null) return -1;
    return as - bs || (a.t.sort || 0) - (b.t.sort || 0);
  };
  const sortRec = (n) => { n.children.sort(cmp); n.children.forEach(sortRec); };
  roots.sort(cmp); roots.forEach(sortRec);

  // group by project
  const groups = new Map();
  for (const r of roots) {
    const pid = projMap[r.t.projectId] ? r.t.projectId : ""; // unknown/deleted projects share one group
    if (!groups.has(pid)) {
      const p = projMap[pid];
      groups.set(pid, { id: pid, title: p ? p.title || "(未命名项目)" : "未分类", color: (p && p.color) || "#8a8f98", archived: !!(p && p.archived), roots: [] });
    }
    groups.get(pid).roots.push(r);
  }
  const list = [...groups.values()].filter((g) => !g.archived || opts.project === g.id);
  for (const g of list) {
    let lo = null, hi = null, leaves = 0, dn = 0;
    for (const r of g.roots) {
      if (r.spanStart != null) { lo = lo == null ? r.spanStart : Math.min(lo, r.spanStart); hi = hi == null ? r.spanEnd : Math.max(hi, r.spanEnd); }
      leaves += r.leaves; dn += r.doneLeaves;
    }
    g.spanStart = lo; g.spanEnd = hi; g.progress = leaves ? dn / leaves : 0; g.count = leaves; g.done = dn;
  }
  list.sort((a, b) => (a.spanStart == null) - (b.spanStart == null) || (a.spanStart || 0) - (b.spanStart || 0) || a.title.localeCompare(b.title));

  const projectOptions = Object.entries(projMap)
    .filter(([, p]) => !p.archived)
    .map(([id, p]) => ({ id, title: p.title || id }))
    .sort((a, b) => a.title.localeCompare(b.title));
  return { groups: list, projectOptions, today };
}

/* ---------- shared task rules (the chart's summary strip and the project pages must agree) ---------- */
const TAB_P = "projects";
const PROJECT_STATUS = [["active", "进行中"], ["paused", "暂停"], ["completed", "已完成"]];
const PRIO_NAME = { none: "无", low: "低", medium: "中", high: "高" };

// For an open leaf task: "late" (end date passed), "today" (scheduled for today, or open-ended and in progress, or due today),
// "undated" (no date of any kind) or null. Open-ended tasks are never late.
function focusKind(t, today) {
  if (!t || t.completed || t.kanbanStatus === "abandoned") return null;
  const s = toNum(t.date), e = toNum(t.endDate), doing = t.kanbanStatus === "doing";
  if (s != null) {
    const ranged = e != null && e >= s;
    if (ranged && e < today) return "late";
    return (ranged ? s <= today && e >= today : s === today || (doing && s <= today)) ? "today" : null;
  }
  if (e != null) return e < today ? "late" : e === today ? "today" : null;
  if (toNum(t.availableStartDate) != null) return null;
  return "undated";
}

// Per-project numbers for the overview cards. Only leaf tasks are counted; key "" = tasks without a project.
// `known` (optional Set of project ids): a task pointing at a project that no longer exists counts as unclassified.
// `hidden` = task ids kept out of today / undated (their subtasks too); overdue is never hidden.
function projectStats(reminders, log, hidden, today, known) {
  const all = Object.values(reminders || {}).filter((t) => t && typeof t === "object" && t.id);
  const byId = new Map(all.map((t) => [t.id, t]));
  const hasKid = new Set(all.filter((t) => t.parentId).map((t) => t.parentId));
  const hid = hidden || new Set();
  const isHidden = (id) => { for (let c = byId.get(id), n = 0; c && n++ < 64; c = c.parentId && byId.get(c.parentId)) if (hid.has(c.id)) return true; return false; };
  const pidOf = (t) => (t.projectId && (!known || known.has(t.projectId)) ? t.projectId : "");
  const wk0 = alignMonday(today), out = new Map();
  const get = (pid) => out.get(pid) || out.set(pid, { total: 0, leaves: 0, done: 0, dropped: 0, open: 0, doing: 0, today: 0, late: 0, undated: 0, recent: 0, weekly: new Array(12).fill(0), last: null }).get(pid);
  for (const t of all) {
    const st = get(pidOf(t)); st.total++;
    if (hasKid.has(t.id)) continue;
    st.leaves++;
    if (t.completed) {
      st.done++;
      const ct = toNum(String(t.completedTime || "").slice(0, 10));
      if (ct != null) {
        if (today - ct >= 0 && today - ct < 30) st.recent++;
        const w = 11 - Math.floor((wk0 - alignMonday(ct)) / 7);
        if (w >= 0 && w < 12) st.weekly[w]++;
      }
    } else if (t.kanbanStatus === "abandoned") st.dropped++;
    else {
      st.open++; if (t.kanbanStatus === "doing") st.doing++;
      const k = focusKind(t, today);
      if (k === "late") st.late++;
      else if ((k === "today" || k === "undated") && !(hid.size && isHidden(t.id))) st[k]++;
    }
  }
  for (const [tid, list] of Object.entries(log || {})) {
    const t = byId.get(tid);
    if (!t || !Array.isArray(list)) continue;
    const st = get(pidOf(t));
    for (const e of list) if (e && e.time && (!st.last || e.time > st.last.time)) st.last = { time: e.time, text: e.text, taskId: tid, taskTitle: t.title };
  }
  return out;
}

// every progress record of one project's tasks, newest first
function projectTimeline(reminders, log, pid, limit, known) {
  const out = [];
  for (const [tid, list] of Object.entries(log || {})) {
    const t = (reminders || {})[tid];
    if (!t || (t.projectId && (!known || known.has(t.projectId)) ? t.projectId : "") !== pid || !Array.isArray(list)) continue;
    for (const e of list) if (e && e.time) out.push({ ...e, taskId: tid, taskTitle: t.title || "" });
  }
  out.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  return limit ? out.slice(0, limit) : out;
}

/* ---------- view ---------- */
class GanttView {
  constructor(el, plugin) {
    this.el = el;
    this.plugin = plugin;
    this.zoom = ZOOMS[lsGet("tg-zoom", "day")] ? lsGet("tg-zoom", "day") : "day";
    let done = lsGet("tg-done", "r30");
    if (done === "recent") done = "r30"; // migrate old value
    this.done = done === "open" || done === "all" || DONE_RANGES[done] ? done : "r30";
    this.project = lsGet("tg-project", "");
    this.showUndated = lsGet("tg-undated", "0") === "1";
    this.sort = lsGet("tg-sort", "project") === "time" ? "time" : "project";
    this.dead = new Set(); // task ids whose bound document was deleted
    this.sumOpen = ["today", "late", "undated", "hidden"].includes(lsGet("tg-sumopen", "")) ? lsGet("tg-sumopen", "") : ""; // which list under the summary strip is open
    this.fold = new Set();
    try { JSON.parse(lsGet("tg-fold", "[]")).forEach((x) => this.fold.add(x)); } catch (e) { /* ignore */ }
    this.labelW = Math.min(LABEL_MAX, Math.max(LABEL_MIN, Number(lsGet("tg-labelw", LABEL_DEF)) || LABEL_DEF));
    this.q = ""; // title search / status filter are per-open, not remembered
    this.status = "all";
    this.toast = h("div", { class: "tg-toast", style: "display:none" });
    this.active = false; // last pointer press was inside this view: Ctrl+Z then belongs to us, not to SiYuan's editor
    this.dragging = false;
    this.firstRender = true;
    this._onKey = (e) => this.onKey(e);
    this._onDown = (e) => { this.active = this.el.contains(e.target); };
    window.addEventListener("keydown", this._onKey);
    window.addEventListener("pointerdown", this._onDown, true);
    this._onData = () => { clearTimeout(this._t); this._t = setTimeout(() => { if (!this.dragging) this.reload(); }, 250); };
    window.addEventListener("reminderUpdated", this._onData);
    window.addEventListener("projectUpdated", this._onData);
    this._onProj = (e) => { this.project = (e && e.detail && e.detail.id) || ""; lsSet("tg-project", this.project); this.render(); }; // sent by the project page
    window.addEventListener("tg-project", this._onProj);
    this.el.classList.add("tg");
    this.reload();
  }

  destroy() {
    window.removeEventListener("reminderUpdated", this._onData);
    window.removeEventListener("projectUpdated", this._onData);
    window.removeEventListener("tg-project", this._onProj);
    window.removeEventListener("keydown", this._onKey);
    window.removeEventListener("pointerdown", this._onDown, true);
    clearTimeout(this._t); clearTimeout(this._tt); clearTimeout(this._qt);
  }

  onKey(e) {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || String(e.key).toLowerCase() !== "z") return;
    if (!this.active || !this.el.isConnected) return;
    const tg = e.target;
    if (tg && (tg.tagName === "INPUT" || tg.tagName === "TEXTAREA" || tg.isContentEditable)) return;
    e.preventDefault();
    this.undo();
  }

  async undo() {
    try {
      const label = await this.plugin.undoLast();
      this.say(label ? `已撤销：${label}` : "没有可撤销的操作", false);
    } catch (err) { showMessage("撤销失败：" + err, 5000, "error"); }
  }

  // in-view toast; survives re-renders (re-attached in render())
  say(text, canUndo) {
    clearTimeout(this._tt);
    const kids = [h("span", null, text)];
    if (canUndo) kids.push(h("button", { class: "b3-button b3-button--small", onclick: () => { this.toast.style.display = "none"; this.undo(); } }, "撤销"));
    this.toast.replaceChildren(...kids); // native replaceChildren(null) would render the text "null"
    this.toast.style.display = "flex";
    this._tt = setTimeout(() => { this.toast.style.display = "none"; }, 8000);
  }

  dayAt(line, clientX) {
    const d = this.rs + Math.floor((clientX - line.getBoundingClientRect().left) / this.px);
    return Math.min(this.re, Math.max(this.rs, d));
  }

  get host() { return this.plugin.getHost(); }

  async reload() {
    const host = this.host;
    try {
      this.reminders = await host.loadReminderData(true);
      this.projects = await host.loadProjectData(true);
      await this.plugin.loadLog();
      await this.plugin.loadHidden();
    } catch (e) {
      this.el.replaceChildren(h("div", { class: "tg-empty" }, "读取任务数据失败：" + e));
      return;
    }
    this.render();
    this.refreshDead();
  }

  // runs after the chart is drawn so a slow lookup never delays it; redraws only when the answer changed
  async refreshDead() {
    const my = (this._deadTok = (this._deadTok || 0) + 1);
    let dead;
    try { dead = await this.plugin.findDeadBindings(this.reminders); } catch (e) { return; }
    if (my !== this._deadTok) return;
    const same = dead.size === this.dead.size && [...dead].every((x) => this.dead.has(x));
    this.dead = dead;
    if (!same) this.render();
  }

  saveFold() { lsSet("tg-fold", JSON.stringify([...this.fold])); }

  render() {
    const ai0 = this.el.querySelector && this.el.querySelector(".tg-addinput"); // keep a half-typed inline title across re-renders
    if (ai0) { this._addDraft = ai0.value; if (document.activeElement === ai0) this._refocusAdd = true; }
    const prevScroll = this.scroller ? { l: this.scroller.scrollLeft, t: this.scroller.scrollTop } : null;
    const model = (this.model = buildModel(this.reminders, this.projects, { done: this.done, project: this.project }));
    const px = ZOOMS[this.zoom];

    // filter: title search + status; a node is kept when it or any descendant passes
    const q = this.q.trim().toLowerCase(), today = model.today;
    const wk0 = alignMonday(today), wk1 = wk0 + 6;
    const filtering = !!q || this.status !== "all";
    const pass = (n) => {
      if (q && !String(n.t.title || "").toLowerCase().includes(q)) return false;
      if (this.status === "all") return true;
      if (n.spanStart == null) return false;
      const st = this.stateOf(n);
      if (this.status === "late") return st === "late";
      if (this.status === "doing") return st === "open" && n.spanStart <= today && n.spanEnd >= today;
      return n.spanStart <= wk1 && n.spanEnd >= wk0;
    };
    const memo = new Map();
    const hit = (n) => {
      if (!filtering) return true;
      let v = memo.get(n);
      if (v === undefined) { v = pass(n) || n.children.some(hit); memo.set(n, v); }
      return v;
    };

    // visible rows
    const rows = [];
    let hidden = 0, shown = 0;
    const pushNode = (n) => {
      if (!hit(n)) return;
      if (n.spanStart == null && !this.showUndated) { hidden++; return; }
      rows.push({ type: "task", n });
      shown++;
      if (n.children.length && (filtering || !this.fold.has(n.id))) n.children.forEach(pushNode);
    };
    if (this.sort === "time") {
      // flat list ordered by start date (earliest on top); no project grouping or nesting
      const all = [];
      const collect = (n) => { all.push(n); n.children.forEach(collect); };
      model.groups.forEach((g) => g.roots.forEach(collect));
      const parents = new Set(); // same start date: tasks that have subtasks come first, whether or not the subtasks are currently shown
      for (const t of Object.values(this.reminders || {})) if (t && t.parentId) parents.add(t.parentId);
      const sorted = all.filter((n) => n.start != null && (!filtering || pass(n)))
        .sort((a, b) => a.start - b.start || (parents.has(b.id) ? 1 : 0) - (parents.has(a.id) ? 1 : 0) || a.end - b.end || (a.t.sort || 0) - (b.t.sort || 0) || String(a.t.title).localeCompare(String(b.t.title)));
      // a subtask that starts on the same day as its parent sits directly under the parent (listed in the same order, grandchildren likewise)
      const inList = new Set(sorted), kidsOf = new Map(), dated = [];
      const attached = (n) => n.parent && inList.has(n.parent) && n.parent.start === n.start;
      for (const n of sorted) if (attached(n)) (kidsOf.get(n.parent) || kidsOf.set(n.parent, []).get(n.parent)).push(n);
      const emit = (n) => { dated.push(n); (kidsOf.get(n) || []).forEach(emit); };
      for (const n of sorted) if (!attached(n)) emit(n);
      const undated = all.filter((n) => n.start == null && n.spanStart == null && (!filtering || pass(n)));
      for (const n of dated) { rows.push({ type: "task", n }); shown++; }
      if (this.showUndated) for (const n of undated) { rows.push({ type: "task", n }); shown++; }
      else hidden += undated.length;
    } else {
      for (const g of model.groups) {
        const mark = rows.length;
        rows.push({ type: "group", g });
        if (filtering || !this.fold.has("g:" + g.id)) g.roots.forEach(pushNode);
        if (rows.length === mark + 1 && (filtering || (g.spanStart == null && !this.showUndated))) rows.pop();
        else if (!filtering && !this.fold.has("g:" + g.id)) rows.push({ type: "add", g });
      }
    }

    // range
    let lo = model.today - 7, hi = model.today + 28;
    for (const r of rows) {
      const n = r.type === "task" ? r.n : r.g;
      const s = r.type === "task" ? n.spanStart : n.spanStart, e = r.type === "task" ? n.spanEnd : n.spanEnd;
      // clamp so a task dated far in the past/future (e.g. year 2300) cannot blow up the timeline; such bars are cut at the edge
      if (s != null) { lo = Math.min(lo, Math.max(s, model.today - FAR_BACK) - 3); hi = Math.max(hi, Math.min(e, model.today + FAR_AHEAD) + 14); }
    }
    this.rs = alignMonday(lo);
    const days = alignMonday(hi) + 7 - this.rs;
    this.days = days;
    this.re = this.rs + days - 1;
    this.px = px;
    const lineW = days * px;

    const root = h("div", { class: "tg-root", style: `--day:${px}px;--rowh:${ROW_H}px;--labelw:${this.labelW}px` });
    this.rootEl = root;
    root.append(this.renderBar(shown, hidden));
    root.append(this.renderSummary());

    const scroller = h("div", { class: "tg-scroll" });
    const inner = h("div", { class: "tg-inner", style: `width:${this.labelW + lineW}px` });
    this._inner = inner; this._lineW = lineW;
    inner.append(this.renderHead(days, px, lineW));
    const body = h("div", { class: "tg-body" });
    this._body = body;
    if (!rows.length) body.append(h("div", { class: "tg-empty" }, filtering ? "没有符合筛选条件的任务。" : "没有可显示的任务。可调整「显示」范围，或勾选「显示未排期」。"));
    for (const r of rows) body.append(r.type === "group" ? this.renderGroup(r.g, lineW) : r.type === "add" ? this.renderAddRow(r.g, lineW) : this.renderTask(r.n, lineW));
    const tx = (model.today - this.rs) * px;
    this._todayX = tx + px / 2;
    this._todayEl = h("div", { class: "tg-today", style: `left:${this.labelW + this._todayX}px` });
    body.append(this._todayEl);
    inner.append(body);
    scroller.append(inner);
    root.append(scroller);
    this.tip = h("div", { class: "tg-tip", style: "display:none" });
    this.hover = h("div", { class: "tg-hover", style: "display:none" });
    root.append(this.tip, this.hover, this.toast);
    this.el.replaceChildren(root);
    this.scroller = scroller;
    scroller.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    if (this._refocusAdd) {
      this._refocusAdd = false;
      const ai = this.el.querySelector(".tg-addinput");
      if (ai) ai.focus();
    }
    if (this._refocus) { // the search box was re-created by this render: put the caret back
      this._refocus = false;
      const si = this.el.querySelector(".tg-search");
      if (si) { si.focus(); si.setSelectionRange(si.value.length, si.value.length); }
    }

    if (this.firstRender || !prevScroll) {
      scroller.scrollLeft = Math.max(0, tx - 120);
      this.firstRender = false;
    } else {
      scroller.scrollLeft = prevScroll.l; scroller.scrollTop = prevScroll.t;
    }
  }

  renderBar(shown, hidden) {
    const sel = (opts, cur, on) => {
      const s = h("select", { class: "b3-select" }, opts.map(([v, t]) => h("option", { value: v, selected: v === cur }, t)));
      s.addEventListener("change", () => on(s.value));
      return s;
    };
    const projSel = sel([["", "全部项目"], ...this.model.projectOptions.map((p) => [p.id, p.title])], this.project, (v) => { this.project = v; lsSet("tg-project", v); this.render(); });
    const sortSel = sel([["project", "排序：按项目"], ["time", "排序：按开始时间"]], this.sort, (v) => { this.sort = v; lsSet("tg-sort", v); this.render(); });
    const doneSel = sel(DONE_OPTIONS, this.done, (v) => { this.done = v; lsSet("tg-done", v); this.render(); });
    const zoomBtns = h("div", { class: "tg-seg" }, Object.keys(ZOOMS).map((z) =>
      h("button", { class: "b3-button b3-button--outline" + (z === this.zoom ? " tg-on" : ""), onclick: () => { this.zoom = z; lsSet("tg-zoom", z); this.render(); } }, { day: "日", week: "周", month: "月" }[z])));
    const und = h("label", { class: "tg-chk" }, h("input", { type: "checkbox", class: "b3-switch", checked: this.showUndated, onchange: (e) => { this.showUndated = e.target.checked; lsSet("tg-undated", this.showUndated ? "1" : "0"); this.render(); } }), "显示未排期");
    const today = h("button", { class: "b3-button b3-button--outline", onclick: () => { this.scroller.scrollLeft = Math.max(0, (this.model.today - this.rs) * this.px - 120); } }, "今天");
    const statusSel = sel(STATUS_OPTIONS, this.status, (v) => { this.status = v; this.render(); });
    let comp = false; // do not re-render while a Chinese IME composition is in progress
    const applyQ = () => { this.q = search.value; clearTimeout(this._qt); this._qt = setTimeout(() => { this._refocus = true; this.render(); }, 200); };
    const search = h("input", { class: "b3-text-field tg-search", type: "text", placeholder: "搜索任务标题", value: this.q });
    search.addEventListener("compositionstart", () => { comp = true; });
    search.addEventListener("compositionend", () => { comp = false; applyQ(); });
    search.addEventListener("input", () => { if (!comp) applyQ(); });
    search.addEventListener("keydown", (e) => { if (e.key === "Escape" && search.value) { search.value = ""; applyQ(); } });
    const keys = this.foldKeys(), allFolded = keys.length > 0 && keys.every((k) => this.fold.has(k));
    const foldBtn = h("button", { class: "b3-button b3-button--outline", disabled: this.sort === "time" || !keys.length,
      title: "折叠/展开所有项目与父任务", onclick: () => { if (allFolded) this.fold.clear(); else keys.forEach((k) => this.fold.add(k)); this.saveFold(); this.render(); } }, allFolded ? "展开全部" : "折叠全部");
    const undoBtn = h("button", { class: "b3-button b3-button--outline", disabled: !this.plugin.undoStack.length, title: "撤销上一步改动（Ctrl+Z）", onclick: () => this.undo() }, "撤销");
    const refresh = h("button", { class: "b3-button b3-button--outline", onclick: () => this.reload() }, "刷新");
    const info = h("span", { class: "tg-info" }, `${shown} 条${hidden ? `，另有 ${hidden} 条未排期已隐藏` : ""} · 拖空白处平移 · 项目行或 Shift+拖任务行空白处=新建 · Ctrl+滚轮缩放 · 双击/右键编辑`);
    const legend = h("span", { class: "tg-legend" }, [["open", "未完成"], ["done", "已完成"], ["late", "超期（红色延伸段）"], ["dropped", "已放弃"]].map(([k, t]) =>
      h("span", { class: "tg-lg" }, h("i", { class: k === "late" ? "tg-lgl" : "", style: `background-color:${STATE_COLOR[k]}` }), t)));
    const addBtn = h("button", { class: "b3-button b3-button--text", onclick: () => this.openCreate({}) }, "＋ 新建任务");
    const projBtn = h("button", { class: "b3-button b3-button--outline", title: "打开项目管理页", onclick: () => this.plugin.openProjects() }, "项目…");
    return h("div", { class: "tg-bar" }, addBtn, search, sortSel, projSel, statusSel, doneSel, zoomBtns, und, today, foldBtn, undoBtn, refresh, projBtn, legend, info);
  }

  // Leaf tasks that matter right now. Overdue uses stateOf (an end date in the past); open-ended tasks are never overdue.
  // Today = the task's date range covers today, or it is open-ended and in progress, or it is due today.
  // Undated = no date of any kind (listed separately, never under today).
  focusLists() {
    const today = this.model.today, hasKid = new Set();
    for (const t of Object.values(this.reminders || {})) if (t && t.parentId) hasKid.add(t.parentId);
    const due = [], late = [], undated = [];
    const hid = this.plugin.hidden || new Set(), byId = this.reminders || {};
    const isHidden = (id) => { // the task itself or any ancestor is marked
      for (let cur = byId[id], hops = 0; cur && hops++ < 64; cur = cur.parentId && byId[cur.parentId]) if (hid.has(cur.id)) return true;
      return false;
    };
    const walk = (n) => {
      n.children.forEach(walk);
      const t = n.t;
      if (hasKid.has(n.id) || t.completed || t.kanbanStatus === "abandoned") return;
      const k = focusKind(t, today);
      if (k === "late") { late.push(n); return; }
      if (hid.size && isHidden(n.id)) return; // overdue is never hidden
      if (k === "today") due.push(n); else if (k === "undated") undated.push(n);
    };
    this.model.groups.forEach((g) => g.roots.forEach(walk));
    const pr = { high: 0, medium: 1, low: 2 };
    late.sort((a, b) => a.end - b.end || String(a.t.title).localeCompare(String(b.t.title)));
    due.sort((a, b) => (pr[a.t.priority] ?? 3) - (pr[b.t.priority] ?? 3) || (a.start ?? 1e9) - (b.start ?? 1e9) || String(a.t.title).localeCompare(String(b.t.title)));
    const st = { doing: 0, short_term: 1, long_term: 2 };
    undated.sort((a, b) => (st[a.t.kanbanStatus] ?? 3) - (st[b.t.kanbanStatus] ?? 3) || (pr[a.t.priority] ?? 3) - (pr[b.t.priority] ?? 3) || String(a.t.title).localeCompare(String(b.t.title)));
    const marked = [...hid].map((id) => byId[id]).filter(Boolean).map((t) => this.nodeOf(t.id)).filter(Boolean);
    return { due, late, undated, marked };
  }

  nodeOf(id) {
    let r = null;
    const w = (n) => { if (n.id === id) r = n; else n.children.forEach(w); };
    this.model.groups.forEach((g) => g.roots.forEach(w));
    return r;
  }

  renderSummary() {
    const { due, late, undated, marked } = this.focusLists();
    const today = this.model.today, md = (d) => fromNum(d).slice(5);
    const open = this.sumOpen;
    const chip = (key, label, count, cls) => h("button", { class: `tg-chip ${cls}` + (open === key ? " tg-on" : ""), title: open === key ? "收起" : "展开清单",
      onclick: () => { this.sumOpen = open === key ? "" : key; lsSet("tg-sumopen", this.sumOpen); this.render(); } }, label, h("b", null, String(count)));
    const strip = h("div", { class: "tg-focus" }, chip("today", "今日", due.length, "tg-c-today"), chip("late", "超期", late.length, late.length ? "tg-c-late" : "tg-c-ok"),
      chip("undated", "未排期", undated.length, "tg-c-undated"),
      marked.length ? chip("hidden", "已隐藏", marked.length, "tg-c-undated") : null,
      late.length ? null : h("span", { class: "tg-ok" }, "无超期任务"));
    const wrap = h("div", { class: "tg-focuswrap" }, strip);
    if (!open) return wrap;
    const list = open === "late" ? late : open === "undated" ? undated : open === "hidden" ? marked : due, isLate = open === "late", isUndated = open === "undated", isHiddenList = open === "hidden";
    const item = (n) => {
      const t = n.t, proj = this.projects[t.projectId];
      const when = isHiddenList ? "不计入今日 / 未排期（含子任务）" : isUndated ? (KANBAN[t.kanbanStatus] || "未排期") : isLate ? `超期 ${today - n.end} 天 · 截止 ${md(n.end)}`
        : n.kind === "own" ? (n.noEnd ? "持续中" : n.end > n.start ? `${md(n.start)} ~ ${md(n.end)}` : md(n.start)) : n.kind === "deadline" ? "今日截止" : "进行中（未排期）";
      const bProg = h("button", { class: "b3-button b3-button--outline", onclick: () => this.openProgress(n) }, "记录进度");
      if (isHiddenList) {
        const bShow = h("button", { class: "b3-button b3-button--outline", onclick: async () => { try { await this.plugin.setHidden(t.id, false); this.render(); } catch (e) { showMessage("操作失败：" + e, 4000, "error"); } } }, "恢复显示");
        return h("div", { class: "tg-fitem" }, h("span", { class: "tg-ftitle", title: "在甘特图中定位", onclick: () => this.locate(n) }, t.title || "(无标题)"),
          h("span", { class: "tg-meta" }, proj ? proj.title : "未分类"), h("span", { class: "tg-fwhen" }, when), h("span", { class: "fn__flex-1" }), bShow);
      }
      const bToday = isUndated ? h("button", { class: "b3-button b3-button--outline", title: "把开始日期设为今天（1 天）", onclick: () => this.schedule(n, today, today) }, "排到今天") : null;
      const bDone = h("button", { class: "b3-button b3-button--outline", onclick: () => this.toggleDone(t) }, "完成");
      return h("div", { class: "tg-fitem" },
        h("span", { class: "tg-ftitle", title: "在甘特图中定位", onclick: () => this.locate(n) }, t.title || "(无标题)"),
        h("span", { class: "tg-meta" }, proj ? proj.title : "未分类"),
        h("span", { class: "tg-fwhen" + (isLate ? " tg-latew" : "") }, when),
        h("span", { class: "fn__flex-1" }), bToday, bProg, bDone);
    };
    wrap.append(h("div", { class: "tg-fpanel" }, list.length ? list.map(item) : h("div", { class: "tg-empty" }, isLate ? "没有超期任务。" : isHiddenList ? "没有被隐藏的任务。" : isUndated ? "没有未排期的任务。" : "今天没有安排的任务。")));
    return wrap;
  }

  // scroll the chart to a task: unfold its ancestors and project, clear filters that would hide it, then flash the row
  locate(n) {
    let changed = false;
    for (let p = n.parent; p; p = p.parent) if (this.fold.delete(p.id)) changed = true;
    const find = (x, g) => x.id === n.id || x.children.some((c) => find(c, g));
    for (const g of this.model.groups) if (g.roots.some((r) => find(r, g)) && this.fold.delete("g:" + g.id)) changed = true;
    if (this.q || this.status !== "all") { this.q = ""; this.status = "all"; changed = true; }
    if (n.spanStart == null && !this.showUndated) { this.showUndated = true; lsSet("tg-undated", "1"); changed = true; }
    if (changed) { this.saveFold(); this.render(); }
    const row = this.el.querySelector && this.el.querySelector(`[data-id="${n.id}"]`);
    if (!row || !this.scroller) { showMessage("该任务当前不在图中（可能被「完成范围」或项目筛选排除）", 3000, "info"); return; }
    const sc = this.scroller, r = row.getBoundingClientRect(), s = sc.getBoundingClientRect();
    sc.scrollTop = Math.max(0, sc.scrollTop + (r.top - s.top) - 80);
    if (n.start != null) { const day = Math.min(Math.max(this.model.today, n.start), n.vEnd != null ? n.vEnd : n.start); sc.scrollLeft = Math.max(0, (day - this.rs) * this.px - 160); }
    row.classList.add("tg-flash");
    setTimeout(() => { try { row.classList.remove("tg-flash"); } catch (e) { /* ignore */ } }, 1800);
  }

  // every key that can be folded: "g:<project>" and each task with children
  foldKeys() {
    const keys = [];
    const walk = (n) => { if (n.children.length) keys.push(n.id); n.children.forEach(walk); };
    for (const g of this.model.groups) { keys.push("g:" + g.id); g.roots.forEach(walk); }
    return keys;
  }

  renderHead(days, px, lineW) {
    const scale = h("div", { class: "tg-scale", style: `width:${lineW}px` });
    // month tier
    let i = 0;
    while (i < days) {
      const { y, m } = ymd(this.rs + i);
      let j = i;
      while (j < days && ymd(this.rs + j).m === m) j++;
      scale.append(h("div", { class: "tg-mon", style: `left:${i * px}px;width:${(j - i) * px}px` }, `${y}年${m}月`));
      i = j;
    }
    // day / week tier
    for (let k = 0; k < days; k++) {
      const n = this.rs + k, w = wday(n), d = ymd(n);
      if (px >= 24 && days <= MAX_DAY_CELLS) {
        scale.append(h("div", { class: "tg-d" + (w >= 5 ? " tg-we" : "") + (n === this.model.today ? " tg-now" : ""), style: `left:${k * px}px;width:${px}px` }, h("b", null, d.d), h("i", null, "一二三四五六日"[w])));
      } else if (w === 0) {
        scale.append(h("div", { class: "tg-d tg-wk", style: `left:${k * px}px;width:${7 * px}px` }, px >= 12 ? `${d.m}/${d.d}` : d.d));
      }
    }
    scale.append(h("div", { class: "tg-todaytag", style: `left:${(this.model.today - this.rs) * px + px / 2}px` }, "今天"));
    scale.addEventListener("pointerdown", (e) => this.startPan(e, true));
    const grip = h("i", { class: "tg-grip", title: "拖动调整宽度" });
    grip.addEventListener("pointerdown", (e) => this.startResize(e));
    return h("div", { class: "tg-head" }, h("div", { class: "tg-corner" }, "任务", grip), scale);
  }

  renderGroup(g, lineW) {
    const key = "g:" + g.id, folded = this.fold.has(key);
    const label = h("div", { class: "tg-label tg-glabel", style: `--gc:${g.color}`, onclick: () => { folded ? this.fold.delete(key) : this.fold.add(key); this.saveFold(); this.render(); } },
      h("span", { class: "tg-tog" }, folded ? "▸" : "▾"), h("span", { class: "tg-dot", style: `background:${g.color}` }), h("b", { class: "tg-title" }, g.title),
      h("span", { class: "tg-mini", title: `完成 ${Math.round(g.progress * 100)}%` }, h("i", { style: `width:${Math.round(g.progress * 100)}%` })),
      h("span", { class: "tg-meta" }, `${g.done}/${g.count}`));
    const line = h("div", { class: "tg-line", style: `width:${lineW}px` });
    if (g.spanStart != null) line.append(this.summaryBar(g.spanStart, g.spanEnd, g.color, g.progress, () => this.groupInfo(g)));
    line.classList.add("tg-paint");
    line.addEventListener("pointerdown", (e) => { if (e.target === line) this.startPaint(e, line, (a, b) => this.newTask({ date: a, endDate: b > a ? b : null, projectId: g.id })); });
    const rowEl = h("div", { class: "tg-row tg-grow" }, label, line);
    rowEl.addEventListener("contextmenu", (ev) => this.groupMenu(ev, g));
    return rowEl;
  }

  // last row of a project group: "＋ 添加任务" turns into an inline title box; Enter creates (starting today) and stays open
  renderAddRow(g, lineW) {
    const adding = this._adding === g.id;
    const line = h("div", { class: "tg-line", style: `width:${lineW}px` });
    line.addEventListener("pointerdown", (e) => { if (e.target === line) this.startPan(e); });
    let inner;
    if (adding) {
      let comp = false;
      const input = h("input", { class: "b3-text-field tg-addinput", type: "text", placeholder: "输入标题，回车创建，Esc 取消", value: this._addDraft || "" });
      input.addEventListener("compositionstart", () => { comp = true; });
      input.addEventListener("compositionend", () => { comp = false; });
      input.addEventListener("keydown", async (e) => {
        if (e.isComposing || comp) return;
        if (e.key === "Escape") { this._adding = null; this._addDraft = ""; this.render(); return; }
        if (e.key !== "Enter") return;
        e.preventDefault();
        const title = input.value.trim();
        if (!title) return;
        input.value = ""; this._addDraft = "";
        try {
          await this.plugin.createTask({ title, date: fromNum(this.model.today), projectId: g.id });
          this._refocusAdd = true;
          this.say(`已新建「${title}」（今天）`, true);
        } catch (err) { input.value = title; showMessage("新建失败：" + err, 5000, "error"); }
      });
      input.addEventListener("blur", () => setTimeout(() => {
        if (!input.isConnected || input.value.trim() || this._adding !== g.id) return; // removed by a re-render, or has text
        this._adding = null; this.render();
      }, 0));
      inner = input;
    } else inner = h("span", { class: "tg-addbtn" }, "＋ 添加任务");
    const label = h("div", { class: "tg-label", onclick: adding ? null : () => { this._adding = g.id; this._addDraft = ""; this._refocusAdd = true; this.render(); } }, h("span", { class: "tg-tog" }), inner);
    return h("div", { class: "tg-row tg-addrow" }, label, line);
  }

  // pixel box of [s,e] clipped to the visible timeline; null when entirely outside
  box(s, e) {
    if (e < this.rs || s > this.re) return null;
    const a = Math.max(s, this.rs), b = Math.min(e, this.re);
    return { left: (a - this.rs) * this.px, width: (b - a + 1) * this.px, cutR: e > this.re, cutL: s < this.rs };
  }

  // overdue extension: from the day after the end up to today, in red
  tail(endNum, infoFn, small) {
    const today = this.model.today;
    if (endNum >= today) return null;
    const bx = this.box(endNum + 1, today);
    if (!bx) return null;
    const el = h("div", { class: "tg-tail" + (small ? " tg-tail-s" : ""), style: `left:${bx.left}px;width:${bx.width}px` }, !small && bx.width >= 64 ? `超期 ${today - endNum} 天` : null);
    this.attachHover(el, infoFn);
    return { el, w: bx.width };
  }

  summaryBar(s, e, color, progress, infoFn) {
    const bx = this.box(s, e);
    if (!bx) return h("i", { style: "display:none" });
    const bar = h("div", { class: "tg-sum", style: `left:${bx.left}px;width:${bx.width}px;--c:${color}` });
    bar.append(h("div", { class: "tg-fill", style: `width:${Math.round(progress * 100)}%` }));
    this.attachHover(bar, infoFn);
    return bar;
  }

  /* ----- hover info card ----- */
  attachHover(el, infoFn) {
    const place = (ev) => {
      const tip = this.hover, box = this.el.getBoundingClientRect();
      let x = ev.clientX - box.left + 14, y = ev.clientY - box.top + 16;
      if (x + tip.offsetWidth > box.width - 8) x = Math.max(8, ev.clientX - box.left - tip.offsetWidth - 14);
      if (y + tip.offsetHeight > box.height - 8) y = Math.max(8, ev.clientY - box.top - tip.offsetHeight - 12);
      tip.style.left = x + "px"; tip.style.top = y + "px";
    };
    el.addEventListener("mouseenter", (ev) => {
      if (this.dragging || !this.hover) return;
      this.hover.replaceChildren(infoFn());
      this.hover.style.display = "block";
      place(ev);
    });
    el.addEventListener("mousemove", (ev) => { if (!this.dragging && this.hover && this.hover.style.display === "block") place(ev); });
    el.addEventListener("mouseleave", () => { if (this.hover) this.hover.style.display = "none"; });
  }

  logInfo(id) {
    const list = this.plugin.progressOf(id);
    if (!list.length) return null;
    const cut = (s) => { s = s.replace(/\s+/g, " "); return s.length > 60 ? s.slice(0, 60) + "…" : s; };
    return h("div", { class: "tg-il" },
      h("div", { class: "tg-ik" }, `成果记录 · 共 ${list.length} 条`),
      list.slice(-3).reverse().map((e) => h("div", { class: "tg-ie" }, h("b", null, e.time.slice(5)), (e.progress != null ? ` ${e.progress}%　` : "　") + cut(e.text))));
  }

  nodeInfo(n) {
    const t = n.t, today = this.model.today;
    const proj = this.projects[t.projectId];
    const row = (k, v, cls) => v == null || v === "" ? null : h("div", { class: "tg-ir" + (cls ? " " + cls : "") }, h("span", { class: "tg-ik" }, k), h("span", { class: "tg-iv" }, v));
    const dateTxt = n.start == null ? null
      : (n.kind === "own" ? "" : n.kind === "avail" ? "可开始 " : "截止 ") + fromNum(n.start) + (t.time ? " " + t.time : "") +
        (n.end > n.start ? " ~ " + fromNum(n.end) + (t.endTime ? " " + t.endTime : "") + `（${n.end - n.start + 1} 天）` : t.endTime ? " ~ " + t.endTime : "");
    const openEnded = n.kind === "own" && n.noEnd && !t.completed;
    const dateShown = openEnded ? fromNum(n.start) + (t.time ? " " + t.time : "") + " 起（未设结束日期）" : dateTxt;
    const parent = t.parentTitle || (n.parent && n.parent.t.title) || "";
    let status;
    if (t.completed) status = "已完成" + (t.completedTime ? " · " + t.completedTime : "");
    else status = KANBAN[t.kanbanStatus] || t.kanbanStatus || "未完成";
    const lateEnd = n.spanEnd != null ? n.spanEnd : n.end;
    const overdue = this.stateOf(n) === "late" ? `已逾期 ${today - lateEnd} 天` : null;
    const note = (t.note || "").trim();
    return h("div", null,
      h("div", { class: "tg-it" }, (t.completed ? "✓ " : "") + (t.title || "(无标题)")),
      row("项目", proj ? proj.title : "未分类"),
      row("父任务", parent),
      row("日期", dateShown || "未排期"),
      row("持续", n.ongoing ? `已持续 ${Math.max(0, today - n.start) + 1} 天` : null),
      row("逾期", overdue, "tg-warn"),
      row("状态", status),
      row("优先级", PRIO[t.priority]),
      row("进度", n.children.length ? `${n.doneLeaves}/${n.leaves} 个子任务 · ${Math.round(n.progress * 100)}%` : t.completed ? "100%" : n.progress ? Math.round(n.progress * 100) + "%" : null),
      row("番茄钟", t.pomodoroCount ? `${t.pomodoroCount} 个 · 专注 ${fmtMin(t.focusTime)}` : null),
      row("文档", this.dead.has(t.id) ? `${t.docTitle || "已绑定"}（文档已被删除）` : t.docTitle, this.dead.has(t.id) ? "tg-warn" : ""),
      this.logInfo(t.id),
      note ? h("div", { class: "tg-in" }, note.length > 160 ? note.slice(0, 160) + "…" : note) : null,
      n.kind === "own" ? h("div", { class: "tg-ih" }, "拖动平移 · 拖边缘调工期 · 双击或右键编辑") : null);
  }

  groupInfo(g) {
    const row = (k, v) => h("div", { class: "tg-ir" }, h("span", { class: "tg-ik" }, k), h("span", { class: "tg-iv" }, v));
    return h("div", null, h("div", { class: "tg-it" }, g.title),
      g.spanStart != null ? row("跨度", `${fromNum(g.spanStart)} ~ ${fromNum(g.spanEnd)}（${g.spanEnd - g.spanStart + 1} 天）`) : null,
      row("任务", `${g.count} 个 · 完成 ${Math.round(g.progress * 100)}%`));
  }

  renderTask(n, lineW) {
    const t = n.t, px = this.px;
    const state = this.stateOf(n), color = STATE_COLOR[state];
    const flat = this.sort === "time";
    const hasKids = !flat && n.children.length > 0, folded = this.fold.has(n.id);
    const projName = this.projects[t.projectId] && this.projects[t.projectId].title;
    const depth = flat ? 0 : n.depth;
    const barColor = state === "late" ? STATE_COLOR.open : color; // overdue is shown by the red tail, not by recoloring the whole bar
    const doing = state === "open" && n.spanStart != null && n.spanStart <= this.model.today && n.spanEnd >= this.model.today;
    const label = h("div", { class: "tg-label" },
      depth ? h("i", { class: "tg-indent", style: `width:${depth * 16}px` }) : null,
      hasKids ? h("span", { class: "tg-tog", onclick: (e) => { e.stopPropagation(); folded ? this.fold.delete(n.id) : this.fold.add(n.id); this.saveFold(); this.render(); } }, folded ? "▸" : "▾") : h("span", { class: "tg-tog" }),
      h("span", { class: "tg-title" + (t.completed ? " tg-done" : state === "late" ? " tg-latet" : doing ? " tg-doing" : "") }, (t.completed ? "✓ " : state === "late" ? "! " : "") + (t.title || "(无标题)")),
      n.ongoing ? h("span", { class: "tg-meta" }, "进行中") : null,
      n.kind === "own" || hasKids ? null : h("span", { class: "tg-meta" }, n.kind === "avail" ? "可开始" : n.kind === "deadline" ? "截止" : "未排期"),
      flat ? h("span", { class: "tg-meta tg-proj", title: projName || "未分类" }, projName || "未分类") : null);
    const paint = n.kind !== "own" && !hasKids && !t.completed; // unscheduled: drag on the empty row to set its dates
    const line = h("div", { class: "tg-line" + (paint ? " tg-paint" : ""), style: `width:${lineW}px` });
    const info = () => this.nodeInfo(n);
    this.attachHover(label, info);
    line.addEventListener("pointerdown", (e) => {
      if (e.target !== line) return;
      if (e.shiftKey) this.startPaint(e, line, (a, b) => this.newTask({ date: a, endDate: b > a ? b : null, parentId: n.id })); // Shift+drag: new subtask
      else if (paint) this.startPaint(e, line, (a, b) => this.schedule(n, a, b));
      else this.startPan(e);
    });
    const tl = state === "late" && n.kind === "own" ? this.tail(n.end, info) : null;

    if (n.kind === "own") {
      line.append(this.taskBar(n, barColor, state, doing, tl ? tl.w : 0));
      if (tl) line.append(tl.el);
    } else if (n.kind && !hasKids) {
      const bx = this.box(n.start, n.start);
      if (bx) {
        const bar = h("div", { class: "tg-task tg-ro", style: `left:${bx.left}px;width:${bx.width}px;--c:${color}` });
        this.attachHover(bar, info);
        line.append(bar);
      }
    }
    if (hasKids && n.spanStart != null && n.kind !== "own") {
      line.append(this.summaryBar(n.spanStart, n.spanEnd, barColor, n.progress, info));
      const st = state === "late" ? this.tail(n.spanEnd, info, true) : null;
      if (st) line.append(st.el);
    } else if (hasKids && n.kind === "own" && (n.spanStart < n.start || n.spanEnd > n.end)) {
      // own range plus wider children range: show faint children span underneath
      line.append(this.summaryBar(n.spanStart, n.spanEnd, barColor, n.progress, info));
    }
    const marks = new Map(); // one diamond per day that has a logged result
    for (const e of this.plugin.progressOf(t.id)) { const d = toNum(e.time.slice(0, 10)); if (d != null) marks.set(d, (marks.get(d) || 0) + 1); }
    for (const [d, c] of marks) {
      const bx = this.box(d, d);
      if (bx) line.append(h("i", { class: "tg-mk", style: `left:${bx.left + bx.width / 2}px`, title: `${fromNum(d)} 有 ${c} 条成果记录` }));
    }
    const rowEl = h("div", { class: "tg-row", "data-id": n.id }, label, line);
    rowEl.addEventListener("contextmenu", (ev) => { ev.preventDefault(); this.taskMenu(ev, n); });
    return rowEl;
  }

  // done = green, overdue (not done and past its end date) = red, otherwise open = blue
  stateOf(n) {
    const done = n.t.completed || (n.children.length > 0 && n.doneLeaves === n.leaves);
    if (done) return "done";
    // a dated task with no end date has no deadline to miss
    if (n.noEnd && !n.children.length) return n.t.kanbanStatus === "abandoned" ? "dropped" : "open";
    const end = n.spanEnd != null ? n.spanEnd : n.end;
    return end != null && end < this.model.today ? "late" : "open";
  }

  taskMenu(ev, n) {
    if (this.hover) this.hover.style.display = "none";
    const t = n.t;
    const menu = new Menu("task-gantt-ctx");
    menu.addItem({ icon: "iconEdit", label: "编辑任务", click: () => this.editTask(t) });
    menu.addItem({ icon: t.completed ? "iconUndo" : "iconCheck", label: t.completed ? "取消完成" : "标记完成", click: () => this.toggleDone(t) });
    menu.addItem({ icon: "iconEdit", label: "记录进度…", click: () => this.openProgress(n) });
    const nLog = this.plugin.progressOf(t.id).length;
    const hid = this.plugin.hidden || new Set();
    let inherited = false;
    for (let cur = t.parentId && this.reminders[t.parentId], hops = 0; cur && hops++ < 64; cur = cur.parentId && this.reminders[cur.parentId]) if (hid.has(cur.id)) { inherited = true; break; }
    if (hid.has(t.id)) menu.addItem({ icon: "iconEye", label: "恢复在摘要中显示", click: async () => { try { await this.plugin.setHidden(t.id, false); this.say(`「${t.title}」已恢复在摘要中显示`, false); this.render(); } catch (e) { showMessage("操作失败：" + e, 4000, "error"); } } });
    else if (inherited) menu.addItem({ icon: "iconEye", label: "已随上级任务在摘要中隐藏", disabled: true });
    else menu.addItem({ icon: "iconEyeoff", label: "不在摘要中显示（含子任务）", click: async () => { try { await this.plugin.setHidden(t.id, true); this.say(`「${t.title}」及其子任务不再计入今日 / 未排期（超期仍会显示）`, false); this.render(); } catch (e) { showMessage("操作失败：" + e, 4000, "error"); } } });
    if (nLog) menu.addItem({ icon: "iconList", label: `查看进度记录（${nLog}）`, click: () => this.openProgressList(n) });
    menu.addItem({ icon: "iconTrashcan", label: "删除任务…", click: () => this.deleteTask(t) });
    if ((t.blockId || t.docId) && this.dead.has(t.id)) {
      menu.addItem({ icon: "iconTrashcan", label: "绑定的文档已被删除，解除绑定", click: () => this.unbind(t) });
      if (!t.completed && !(t.repeat && t.repeat.enabled) && !t.isRepeatInstance) menu.addItem({ icon: "iconAdd", label: "重新创建文档并绑定…", click: () => this.openCreateDoc(t) });
    } else if (t.blockId || t.docId) menu.addItem({ icon: "iconFile", label: "打开所在文档/块", click: () => this.openTask(t) });
    else if (!t.completed && !(t.repeat && t.repeat.enabled) && !t.isRepeatInstance) menu.addItem({ icon: "iconAdd", label: "创建文档并绑定…", click: () => this.openCreateDoc(t) });
    // right-click on empty timeline space: create / schedule at that day
    const line = ev.target.closest && ev.target.closest(".tg-line");
    if (line && !ev.target.closest(".tg-task,.tg-sum,.tg-tail")) {
      const day = this.dayAt(line, ev.clientX), md = fromNum(day).slice(5);
      menu.addSeparator();
      menu.addItem({ icon: "iconAdd", label: `在 ${md} 新建任务`, click: () => this.newTask({ date: day, projectId: t.projectId }) });
      menu.addItem({ icon: "iconAdd", label: `在 ${md} 新建子任务`, click: () => this.newTask({ date: day, parentId: t.id }) });
      if (n.kind !== "own" && !n.children.length && !t.completed) menu.addItem({ icon: "iconCalendar", label: `排期到 ${md}（1 天）`, click: () => this.schedule(n, day, day) });
    }
    menu.open({ x: ev.clientX, y: ev.clientY });
  }

  groupMenu(ev, g) {
    const line = ev.target.closest && ev.target.closest(".tg-line");
    if (!line || ev.target.closest(".tg-sum")) return;
    ev.preventDefault();
    if (this.hover) this.hover.style.display = "none";
    const day = this.dayAt(line, ev.clientX);
    const menu = new Menu("task-gantt-ctx");
    menu.addItem({ icon: "iconAdd", label: `在 ${fromNum(day).slice(5)} 新建任务（${g.title}）`, click: () => this.newTask({ date: day, projectId: g.id }) });
    menu.open({ x: ev.clientX, y: ev.clientY });
  }

  // open projects' unfinished tasks as parent choices, indented by depth
  parentChoices(pid, excludeId) {
    const proj = (t) => (t.projectId && this.projects[t.projectId] ? t.projectId : "");
    const banned = new Set(excludeId ? [excludeId, ...this.plugin.descendantsOf(this.reminders, excludeId).map((x) => x.id)] : []);
    const all = Object.values(this.reminders).filter((t) => t && t.id && !t.completed && !banned.has(t.id) && proj(t) === pid);
    const ids = new Set(all.map((t) => t.id)), kids = new Map();
    for (const t of all) { const k = ids.has(t.parentId) ? t.parentId : ""; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(t); }
    const out = [], seen = new Set();
    const walk = (k, d) => {
      for (const t of (kids.get(k) || []).sort((x, y) => (x.sort || 0) - (y.sort || 0))) {
        if (seen.has(t.id)) continue;
        seen.add(t.id); out.push([t.id, "　".repeat(Math.min(d, 4)) + (t.title || "(无标题)")]);
        walk(t.id, d + 1);
      }
    };
    walk("", 0);
    return out;
  }

  // full "new task" dialog; preset = { date, endDate (day numbers), projectId, parentId }
  openCreate(preset = {}, edit = null) {
    if (edit) preset = { date: toNum(edit.date), endDate: toNum(edit.endDate), parentId: edit.parentId, projectId: edit.projectId };
    const today = this.model ? this.model.today : todayNum();
    const projects = this.model ? this.model.projectOptions : [];
    const parentRec = preset.parentId ? this.reminders[preset.parentId] : null;
    let pid = parentRec ? parentRec.projectId || "" : preset.projectId != null ? preset.projectId : this.project || "";
    const projOpts = [...projects]; // editing keeps a task's project even when that project is archived
    if (pid && !projOpts.some((p) => p.id === pid)) { if (edit && this.projects[pid]) projOpts.push({ id: pid, title: this.projects[pid].title || pid }); else pid = ""; }
    const sel = (opts, cur) => h("select", { class: "b3-select fn__block" }, opts.map(([v, t]) => h("option", { value: v, selected: v === cur }, t)));
    const row = (k, c) => h("label", { class: "tg-frow" }, h("span", null, k), c);
    const title = h("input", { class: "b3-text-field fn__block", type: "text", placeholder: "任务标题", value: edit ? edit.title || "" : "" });
    const project = sel([["", "（无项目）"], ...projOpts.map((p) => [p.id, p.title])], pid);
    // parent picker: a keyword box filters the list below it; the current choice always stays listed
    const parentQ = h("input", { class: "b3-text-field fn__block", type: "text", placeholder: "搜索父任务，输入关键字过滤" });
    const parent = h("select", { class: "b3-select fn__block tg-plist", size: "6" });
    const fillParents = (cur) => {
      const keep = cur !== undefined ? cur : parent.value;
      const q = (parentQ.value || "").trim().toLowerCase();
      const opts = [["", "（无，作为顶层任务）"], ...this.parentChoices(project.value, edit && edit.id)].filter(([v, t]) => v === "" || v === keep || !q || t.toLowerCase().includes(q));
      parent.replaceChildren(...opts.map(([v, t]) => h("option", { value: v, selected: v === keep }, t)));
      parent.value = opts.some(([v]) => v === keep) ? keep : "";
    };
    let pComp = false;
    parentQ.addEventListener("compositionstart", () => { pComp = true; });
    parentQ.addEventListener("compositionend", () => { pComp = false; fillParents(); });
    parentQ.addEventListener("input", () => { if (!pComp) fillParents(); });
    parentQ.addEventListener("keydown", (e) => {
      if (e.isComposing || pComp) return;
      if (e.key === "Enter") { // pick the first match
        e.preventDefault();
        const first = [...parent.children].find((o) => o.attrs && o.attrs.value);
        if (first) { parent.value = first.attrs.value; title.focus(); }
      } else if (e.key === "ArrowDown") { e.preventDefault(); parent.focus(); }
    });
    const start = h("input", { class: "b3-text-field fn__block", type: "date", value: edit ? (preset.date != null ? fromNum(preset.date) : "") : fromNum(preset.date != null ? preset.date : today) });
    const end = h("input", { class: "b3-text-field fn__block", type: "date", value: edit ? (preset.endDate != null ? fromNum(preset.endDate) : "") : preset.endDate != null && preset.endDate > (preset.date != null ? preset.date : today) ? fromNum(preset.endDate) : "" });
    const prio = sel([["none", "无"], ["low", "低"], ["medium", "中"], ["high", "高"]], edit ? edit.priority || "none" : "none");
    const statuses = edit ? [["doing", "进行中"], ["short_term", "短期"], ["long_term", "长期"], ["abandoned", "已放弃"]] : [["doing", "进行中"], ["short_term", "短期"], ["long_term", "长期"]];
    const status = sel(statuses, edit ? edit.kanbanStatus || "doing" : parentRec && statuses.some(([v]) => v === parentRec.kanbanStatus) ? parentRec.kanbanStatus : "doing");
    const stime = h("input", { class: "b3-text-field fn__block", type: "time", value: edit ? edit.time || "" : "" });
    const etime = h("input", { class: "b3-text-field fn__block", type: "time", value: edit ? edit.endTime || "" : "" });
    const note = h("textarea", { class: "b3-text-field fn__block", rows: "5", placeholder: "备注" });
    if (edit) note.value = edit.note || "";
    project.addEventListener("change", () => { parentQ.value = ""; fillParents(""); });
    const form = h("div", null, row("标题", title), row("所属项目", project), h("div", { class: "tg-frow" }, h("span", null, "父任务（可选）"), parentQ, parent),
      h("div", { class: "tg-fgrid" }, row("开始日期", start), row("结束日期（可留空＝持续进行）", end)),
      h("div", { class: "tg-fgrid" }, row("优先级", prio), row("状态", status)),
      edit ? h("div", { class: "tg-fgrid" }, row("开始时间（可空）", stime), row("结束时间（可空）", etime)) : null,
      edit ? row("备注", note) : null);
    const bCancel = h("button", { class: "b3-button b3-button--cancel" }, "取消");
    const bOk = h("button", { class: "b3-button b3-button--text" }, edit ? "保存" : "创建");
    const bEdit = h("button", { class: "b3-button b3-button--text", title: "创建后继续编辑：时间、备注等" }, "创建并编辑");
    const dlg = new Dialog({
      title: edit ? `编辑任务：${edit.title}` : parentRec ? `新建子任务（${parentRec.title}）` : "新建任务", width: "480px",
      content: `<div class="b3-dialog__content tg-form"></div><div class="b3-dialog__action"></div>`,
    });
    dlg.element.querySelector(".tg-form").append(form);
    dlg.element.querySelector(".b3-dialog__action").append(bCancel, h("div", { class: "fn__space" }), bOk, ...(edit ? [] : [h("div", { class: "fn__space" }), bEdit]));
    fillParents(preset.parentId || "");
    let busy = false;
    const submit = async (thenEdit) => {
      if (busy) return;
      const name = title.value.trim();
      if (!name) { title.focus(); return; }
      if (edit) { // edit: dates are optional (no dates = unscheduled; only an end date = a deadline)
        if ((start.value && !RE_DATE.test(start.value)) || (end.value && !RE_DATE.test(end.value))) { showMessage("日期格式无效", 3000, "error"); return; }
        if (start.value && end.value && end.value < start.value) { showMessage("结束日期不能早于开始日期", 3000, "error"); return; }
        busy = true;
        try {
          await this.plugin.updateTask(edit.id, { title: name, projectId: project.value, parentId: parent.value, date: start.value, endDate: end.value, time: stime.value, endTime: etime.value, note: note.value, priority: prio.value, kanbanStatus: status.value });
          dlg.destroy();
          this.say(`已保存「${name}」`, true);
        } catch (err) { busy = false; showMessage("保存失败：" + err, 5000, "error"); }
        return;
      }
      if (!RE_DATE.test(start.value)) { showMessage("请填写开始日期", 3000, "error"); return; }
      if (end.value && (!RE_DATE.test(end.value) || end.value < start.value)) { showMessage("结束日期不能早于开始日期", 3000, "error"); return; }
      busy = true;
      try {
        const rec = await this.plugin.createTask({ title: name, date: start.value, endDate: end.value || undefined, projectId: project.value, parentId: parent.value || undefined, priority: prio.value, kanbanStatus: status.value });
        dlg.destroy();
        this.say(`已新建「${name}」（${rec.date}${rec.endDate ? " ~ " + rec.endDate : ""}）`, true);
        if (thenEdit) this.editTask(rec);
      } catch (err) { busy = false; showMessage("新建失败：" + err, 5000, "error"); }
    };
    bCancel.addEventListener("click", () => dlg.destroy());
    bOk.addEventListener("click", () => submit(false));
    bEdit.addEventListener("click", () => submit(true));
    title.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(false); } });
    setTimeout(() => title.focus(), 50);
    return { ctl: { title, project, parent, parentQ, start, end, prio, status, stime, etime, note }, submit };
  }

  newTask(preset) { return this.openCreate(preset); }

  // "create a document for this task and bind it": pick a parent document by searching, then the new doc becomes the task's bound block
  async openCreateDoc(t) {
    let notebooks;
    try { notebooks = await this.plugin.listNotebooks(); } catch (err) { showMessage("读取笔记本失败：" + err, 5000, "error"); return; }
    if (!notebooks.length) { showMessage("没有已打开的笔记本", 4000, "error"); return; }
    const nbName = new Map(notebooks.map((n) => [n.id, n.name]));
    let defNb = "";
    defNb = lsGet("tg-lastnb", ""); // the notebook used last time
    if (!nbName.has(defNb)) defNb = notebooks[0].id;

    // candidates pinned on top: the project's own document, and the parent used last time
    const proj = this.projects[t.projectId];
    const pins = [];
    try {
      const wanted = [[proj && proj.blockId, "项目文档"], [lsGet("tg-lastdoc", ""), "上次使用"]].filter(([id]) => id);
      const rows = wanted.length ? await this.plugin.docsOf(wanted.map(([id]) => id), notebooks) : [];
      for (const [id, tag] of wanted) { const r = rows.find((x) => x.id === id) || rows.find((x) => x.rootOf === id); if (r && !pins.some((x) => x.id === r.id)) pins.push({ ...r, tag }); }
    } catch (e) { console.warn("[task-gantt] pinned docs lookup failed", e); }

    const label = (r) => `${r.tag ? "★" + r.tag + "　" : ""}${nbName.get(r.box) || ""}${r.hpath}`;
    let rows = [], picked = pins.length ? pins[0].id : "", token = 0;
    const byId = () => new Map([...pins, ...rows].map((r) => [r.id, r]));
    const title = h("input", { class: "b3-text-field fn__block", type: "text", value: t.title || "" });
    const q = h("input", { class: "b3-text-field fn__block", type: "text", placeholder: "搜索父文档，输入路径或标题中的关键字" });
    const list = h("select", { class: "b3-select fn__block tg-plist", size: "8" });
    const nb = h("select", { class: "b3-select fn__block" }, notebooks.map((n) => h("option", { value: n.id, selected: n.id === defNb }, n.name)));
    const open = h("input", { type: "checkbox", class: "b3-switch", checked: true });
    const preview = h("div", { class: "tg-preview" });
    const safeTitle = () => title.value.replace(/[\/\\]/g, "-").trim();
    const refreshPreview = () => {
      const p = byId().get(picked);
      const base = p ? (nbName.get(p.box) || "") + (p.hpath === "/" ? "" : p.hpath) : (nbName.get(nb.value) || "");
      preview.textContent = "将创建：" + base + "/" + (safeTitle() || "…");
    };
    const fillList = () => {
      const m = byId();
      const items = [["", "（笔记本根目录，下方选择笔记本）"], ...pins.map((r) => [r.id, label(r)]),
        ...rows.filter((r) => !pins.some((x) => x.id === r.id)).map((r) => [r.id, label(r)])];
      if (picked && !items.some(([v]) => v === picked) && m.has(picked)) items.splice(1, 0, [picked, label(m.get(picked))]); // keep the current choice listed
      list.replaceChildren(...items.map(([v, txt]) => h("option", { value: v, selected: v === picked }, txt)));
      list.value = items.some(([v]) => v === picked) ? picked : "";
      const p = m.get(list.value);
      if (p) { nb.value = p.box; nb.disabled = true; } else nb.disabled = false;
      refreshPreview();
    };
    const search = async () => {
      const my = ++token;
      try {
        const found = await this.plugin.searchDocs(q.value, notebooks);
        if (my !== token) return; // a newer search superseded this one
        rows = found;
      } catch (err) { showMessage("搜索失败：" + err, 4000, "error"); return; }
      fillList();
    };
    let comp = false, timer = null;
    const kick = () => { clearTimeout(timer); timer = setTimeout(search, 200); };
    q.addEventListener("compositionstart", () => { comp = true; });
    q.addEventListener("compositionend", () => { comp = false; kick(); });
    q.addEventListener("input", () => { if (!comp) kick(); });
    q.addEventListener("keydown", (e) => {
      if (e.isComposing || comp) return;
      if (e.key === "Enter") { e.preventDefault(); const first = [...list.children].find((o) => o.attrs && o.attrs.value && o.attrs.value !== picked); if (first) { picked = first.attrs.value; fillList(); } }
      else if (e.key === "ArrowDown") { e.preventDefault(); list.focus(); }
    });
    list.addEventListener("change", () => { picked = list.value; fillList(); });
    nb.addEventListener("change", refreshPreview);
    title.addEventListener("input", refreshPreview);

    const row = (k, c) => h("div", { class: "tg-frow" }, h("span", null, k), c);
    const form = h("div", null, row("文档标题", title), h("div", { class: "tg-frow" }, h("span", null, "父文档（可搜索；★为推荐位置）"), q, list), row("笔记本（仅在建到根目录时可选）", nb),
      h("label", { class: "tg-chk" }, open, "创建后打开文档"), preview);
    const bCancel = h("button", { class: "b3-button b3-button--cancel" }, "取消");
    const bOk = h("button", { class: "b3-button b3-button--text" }, "创建并绑定");
    const dlg = new Dialog({ title: `为「${t.title}」创建文档`, width: "560px", content: `<div class="b3-dialog__content tg-form"></div><div class="b3-dialog__action"></div>` });
    dlg.element.querySelector(".tg-form").append(form);
    dlg.element.querySelector(".b3-dialog__action").append(bCancel, h("div", { class: "fn__space" }), bOk);
    let busy = false;
    const submit = async () => {
      if (busy) return;
      const name = safeTitle();
      if (!name) { title.focus(); return; }
      const p = byId().get(picked);
      busy = true;
      try {
        const docId = await this.plugin.createDocAndBind(t.id, { title: name, box: p ? p.box : nb.value, parentHPath: p ? p.hpath : "/" });
        if (p) lsSet("tg-lastdoc", p.id);
        lsSet("tg-lastnb", p ? p.box : nb.value);
        dlg.destroy();
        this.say(`已创建文档「${name}」并绑定到任务`, false);
        if (open.checked) { try { openTab({ app: this.plugin.app, doc: { id: docId } }); } catch (e) { /* ignore */ } }
      } catch (err) { busy = false; showMessage("创建失败：" + err, 6000, "error"); }
    };
    bCancel.addEventListener("click", () => dlg.destroy());
    bOk.addEventListener("click", submit);
    title.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(); } });
    fillList();
    search(); // recent documents until the user types
    setTimeout(() => title.focus(), 50);
    return { ctl: { title, q, list, nb, open }, submit, get picked() { return picked; } };
  }

  openProgress(n) {
    const t = n.t;
    const canPct = !t.completed && !n.children.length && !(t.repeat && t.repeat.enabled) && !t.isRepeatInstance;
    const cur = Math.max(0, Math.min(100, Math.round(n.progress * 100)));
    const d = new Date(), p = (x) => String(x).padStart(2, "0");
    const text = h("textarea", { class: "b3-text-field fn__block", rows: "5", placeholder: "这次有什么成果？" });
    const when = h("input", { class: "b3-text-field fn__block", type: "text", value: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` });
    const range = h("input", { type: "range", min: "0", max: "100", step: "5", value: String(cur), class: "tg-range" });
    const val = h("span", { class: "tg-rangeval" }, cur + "%");
    const bound = !!(t.docId || t.blockId);
    const toDoc = h("input", { type: "checkbox", class: "b3-switch" });
    const fin = h("input", { type: "checkbox", class: "b3-switch" });
    const finRow = h("label", { class: "tg-chk", style: "display:none" }, fin, "同时标记任务完成");
    range.addEventListener("input", () => { val.textContent = range.value + "%"; finRow.style.display = range.value === "100" ? "" : "none"; if (range.value !== "100") fin.checked = false; });
    const row = (k, c) => h("div", { class: "tg-frow" }, h("span", null, k), c);
    const form = h("div", null, row("成果内容", text),
      canPct ? row("进度（原来 " + cur + "%）", h("div", { class: "tg-rangebox" }, range, val)) : null,
      canPct ? finRow : null,
      row("时间（可改成补记）", when),
      bound ? h("label", { class: "tg-chk" }, toDoc, `同步一条到文档「${t.docTitle || ""}」末尾`) : null,
      !canPct && n.children.length ? h("div", { class: "tg-preview" }, "父任务的进度由子任务完成数算出，这里只记录文字。") : null);
    const bCancel = h("button", { class: "b3-button b3-button--cancel" }, "取消");
    const bOk = h("button", { class: "b3-button b3-button--text" }, "记录");
    const dlg = new Dialog({ title: `记录进度：${t.title}`, width: "520px", content: `<div class="b3-dialog__content tg-form"></div><div class="b3-dialog__action"></div>` });
    dlg.element.querySelector(".tg-form").append(form);
    dlg.element.querySelector(".b3-dialog__action").append(bCancel, h("div", { class: "fn__space" }), bOk);
    let busy = false;
    const submit = async () => {
      if (busy) return;
      if (!text.value.trim()) { text.focus(); return; }
      if (!RE_TIME.test(when.value.trim())) { showMessage("时间格式应为 YYYY-MM-DD HH:mm", 4000, "error"); return; }
      busy = true;
      try {
        const r = await this.plugin.addProgress(t.id, { text: text.value, progress: canPct ? range.value : null, time: when.value.trim(), toDoc: bound && toDoc.checked });
        dlg.destroy();
        if (fin.checked && canPct && range.value === "100") { try { await this.plugin.setCompleted(t.id, true); } catch (e) { showMessage("记录已保存，但标记完成失败：" + e, 5000, "error"); } }
        this.say(`已记录「${t.title}」的进度` + (r.docError ? `（写入文档失败：${r.docError}）` : ""), true);
        this.reload();
      } catch (err) { busy = false; showMessage("记录失败：" + err, 6000, "error"); }
    };
    bCancel.addEventListener("click", () => dlg.destroy());
    bOk.addEventListener("click", submit);
    text.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); submit(); } });
    setTimeout(() => text.focus(), 50);
    return { ctl: { text, when, range, toDoc, fin }, submit };
  }

  openProgressList(n) {
    const t = n.t;
    const body = h("div", { class: "tg-loglist" });
    const dlg = new Dialog({ title: `进度记录：${t.title}`, width: "560px", content: `<div class="b3-dialog__content tg-form"></div><div class="b3-dialog__action"></div>` });
    dlg.element.querySelector(".tg-form").append(body);
    const bClose = h("button", { class: "b3-button b3-button--cancel" }, "关闭");
    bClose.addEventListener("click", () => dlg.destroy());
    dlg.element.querySelector(".b3-dialog__action").append(bClose);
    const draw = () => {
      const list = this.plugin.progressOf(t.id).slice().reverse();
      if (!list.length) { body.replaceChildren(h("div", { class: "tg-empty" }, "还没有记录")); return; }
      body.replaceChildren(...list.map((e) => {
        const txt = h("div", { class: "tg-logtext" }, e.text);
        const edit = h("button", { class: "b3-button b3-button--outline" }, "编辑");
        const del = h("button", { class: "b3-button b3-button--outline" }, "删除");
        edit.addEventListener("click", () => {
          const ta = h("textarea", { class: "b3-text-field fn__block", rows: "4" }); ta.value = e.text;
          const ok = h("button", { class: "b3-button b3-button--text" }, "保存");
          ok.addEventListener("click", async () => {
            try { await this.plugin.editProgress(t.id, e.id, ta.value); draw(); } catch (err) { showMessage("保存失败：" + err, 4000, "error"); }
          });
          txt.replaceChildren(ta, ok);
        });
        del.addEventListener("click", () => sConfirm("删除记录", "删除这条进度记录？（不会改动任务进度和文档）", async () => {
          try { await this.plugin.removeProgress(t.id, e.id); draw(); this.render(); } catch (err) { showMessage("删除失败：" + err, 4000, "error"); }
        }));
        return h("div", { class: "tg-logitem" },
          h("div", { class: "tg-loghead" }, h("b", null, e.time), e.progress != null ? h("span", { class: "tg-meta" }, e.progress + "%") : null, h("span", { class: "fn__flex-1" }), edit, del),
          txt);
      }));
    };
    draw();
    return { draw };
  }

  async schedule(n, a, b) {
    try {
      await this.plugin.commitDates(n.id, a, b);
      this.say(`已排期「${n.t.title}」${fromNum(a)}${b > a ? " ~ " + fromNum(b) : ""}`, true);
    } catch (err) { showMessage("改期失败：" + err, 5000, "error"); }
  }

  async toggleDone(t) {
    const done = !t.completed;
    if ((t.repeat && t.repeat.enabled) || t.isRepeatInstance) {
      showMessage("重复任务的完成逻辑较复杂，甘特图暂不支持标记完成", 5000, "info");
      return;
    }
    try {
      const pending = done ? await this.plugin.countPendingDescendants(t.id) : 0;
      const run = async () => {
        try {
          const n = await this.plugin.setCompleted(t.id, done);
          this.say(done ? `已标记完成「${t.title}」${n > 1 ? `（含 ${n - 1} 个子任务）` : ""}` : `已取消完成「${t.title}」`, true);
        } catch (err) { showMessage("操作失败：" + err, 5000, "error"); }
      };
      if (pending > 0) sConfirm("标记完成", `「${t.title}」还有 ${pending} 个未完成的子任务，将一并标记为已完成。继续？`, run);
      else await run();
    } catch (err) { showMessage("操作失败：" + err, 5000, "error"); }
  }

  deleteTask(t) {
    const n = this.plugin.descendantsOf(this.reminders, t.id).length;
    sConfirm("删除任务", `删除「${t.title}」${n ? `及其 ${n} 个子任务` : ""}？其成果记录一并删除。可用 Ctrl+Z 撤销。`, async () => {
      try { const c = await this.plugin.deleteTask(t.id); this.say(`已删除 ${c} 个任务`, true); } catch (err) { showMessage("删除失败：" + err, 5000, "error"); }
    });
  }

  editTask(t) { this.openCreate({}, t); }

  taskBar(n, color, state, doing, tailW) {
    const t = n.t;
    const bx = this.box(n.start, n.ongoing ? Math.max(n.start, this.model.today) : n.end);
    if (!bx) return h("i", { style: "display:none" });
    const w = bx.width;
    const bar = h("div", { class: "tg-task" + (t.completed ? " tg-fin" : "") + (bx.cutR ? " tg-cutr" : "") + (n.ongoing ? " tg-ongoing" : "") + (doing ? " tg-now" : ""), style: `left:${bx.left}px;width:${w}px;--c:${color}` });
    this.attachHover(bar, () => this.nodeInfo(n));
    bar.append(h("div", { class: "tg-fill", style: `width:${Math.round(n.progress * 100)}%` }));
    const text = h("span", { class: "tg-bt" }, (t.completed ? "✓ " : state === "late" ? "! " : "") + (t.title || ""));
    if (w >= 90) bar.append(text);
    else { text.classList.add("tg-out"); if (tailW) text.style.marginLeft = tailW + "px"; bar.append(text); } // keep the outside title clear of the overdue tail
    // a bar cut off at the right edge has no right handle: its real end is off-screen
    bar.append(h("i", { class: "tg-h tg-hl" }));
    if (!bx.cutR) bar.append(h("i", { class: "tg-h tg-hr" })); // never pass null to native append(): it renders the text "null"
    bar.addEventListener("pointerdown", (e) => this.startDrag(e, n, bar));
    bar.addEventListener("dblclick", () => this.editTask(t));
    return bar;
  }

  async openTask(t) {
    const id = t.blockId || t.docId;
    if (!id) { showMessage("该任务没有绑定思源块/文档", 3000, "info"); return; }
    if ((await this.plugin.blockExists(id)) === false) { this.dead.add(t.id); this.unbind(t); return; }
    try { openTab({ app: this.plugin.app, doc: { id } }); } catch (e) { showMessage("打开失败：" + e, 4000, "error"); }
  }

  unbind(t) {
    sConfirm("解除绑定", `「${t.title}」绑定的文档已被删除。解除绑定后，任务本身不受影响，可重新创建文档并绑定。`, async () => {
      try {
        await this.plugin.unbindDoc(t.id);
        this.dead.delete(t.id);
        this.say(`已解除「${t.title}」的文档绑定`, true);
      } catch (err) { showMessage("解除失败：" + err, 5000, "error"); }
    });
  }

  showTip(ev, ns, ne) {
    this.tip.style.display = "block";
    this.tip.textContent = `${fromNum(ns)}${ne > ns ? " ~ " + fromNum(ne) : ""}（${ne - ns + 1} 天）`;
    const r = this.el.getBoundingClientRect();
    this.tip.style.left = ev.clientX - r.left + 12 + "px";
    this.tip.style.top = ev.clientY - r.top + 14 + "px";
  }

  // two dashed vertical lines marking the day edges the bar will snap to
  makeGuides() {
    const a = h("i", { class: "tg-guide" }), b = h("i", { class: "tg-guide" });
    this._body.append(a, b);
    return {
      set: (ns, ne) => { a.style.left = this.labelW + (ns - this.rs) * this.px + "px"; b.style.left = this.labelW + (ne + 1 - this.rs) * this.px + "px"; },
      clear: () => { a.remove(); b.remove(); },
    };
  }

  // drag on empty row space; commit(a, b) gets the dragged day range (schedule a task / open the new-task dialog)
  startPaint(e, line, commit) {
    if (e.button !== 0) return;
    const x0 = e.clientX, d0 = this.dayAt(line, x0);
    let a = d0, b = d0, moved = false;
    const ghost = h("div", { class: "tg-task tg-ghost", style: "display:none" });
    line.append(ghost);
    const guides = this.makeGuides();
    line.setPointerCapture(e.pointerId);
    this.dragging = true;
    if (this.hover) this.hover.style.display = "none";
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 4) return;
      moved = true;
      const d1 = this.dayAt(line, ev.clientX);
      a = Math.min(d0, d1); b = Math.max(d0, d1);
      const bx = this.box(a, b);
      ghost.style.cssText = `display:block;left:${bx.left}px;width:${bx.width}px;--c:${STATE_COLOR.open}`;
      this.showTip(ev, a, b); guides.set(a, b);
    };
    const up = async (ev) => {
      line.removeEventListener("pointermove", move);
      line.removeEventListener("pointerup", up);
      line.removeEventListener("pointercancel", up);
      try { line.releasePointerCapture(ev.pointerId); } catch (x) { /* ignore */ }
      this.tip.style.display = "none";
      guides.clear(); ghost.remove();
      if (moved && ev.type === "pointerup") await commit(a, b);
      this.dragging = false;
      this.reload();
    };
    line.addEventListener("pointermove", move);
    line.addEventListener("pointerup", up);
    line.addEventListener("pointercancel", up);
    e.preventDefault();
  }

  // grab empty space (or the date header) and drag to scroll
  startPan(e, horizontalOnly) {
    if (e.button !== 0) return;
    const sc = this.scroller, el = e.currentTarget;
    const x0 = e.clientX, y0 = e.clientY, l0 = sc.scrollLeft, t0 = sc.scrollTop;
    el.setPointerCapture(e.pointerId);
    sc.classList.add("tg-panning");
    const move = (ev) => {
      sc.scrollLeft = l0 - (ev.clientX - x0);
      if (!horizontalOnly) sc.scrollTop = t0 - (ev.clientY - y0);
    };
    const up = (ev) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      try { el.releasePointerCapture(ev.pointerId); } catch (x) { /* ignore */ }
      sc.classList.remove("tg-panning");
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    e.preventDefault();
  }

  // drag the right edge of the "任务" header cell to resize the label column
  startResize(e) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const grip = e.currentTarget, x0 = e.clientX, w0 = this.labelW;
    grip.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const w = Math.min(LABEL_MAX, Math.max(LABEL_MIN, w0 + ev.clientX - x0));
      this.labelW = w;
      this.rootEl.style.setProperty("--labelw", w + "px");
      this._inner.style.width = w + this._lineW + "px";
      this._todayEl.style.left = w + this._todayX + "px";
    };
    const up = (ev) => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      try { grip.releasePointerCapture(ev.pointerId); } catch (x) { /* ignore */ }
      lsSet("tg-labelw", String(this.labelW));
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  }

  // Ctrl+wheel steps the zoom level, keeping the day under the cursor in place
  onWheel(e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const now = Date.now();
    if (now - (this._wz || 0) < 180) return;
    const order = ["month", "week", "day"], i = order.indexOf(this.zoom);
    const ni = e.deltaY < 0 ? Math.min(2, i + 1) : Math.max(0, i - 1);
    if (ni === i) return;
    this._wz = now;
    const x = e.clientX - this.scroller.getBoundingClientRect().left;
    const day = this.rs + (this.scroller.scrollLeft + x - this.labelW) / this.px;
    this.zoom = order[ni]; lsSet("tg-zoom", this.zoom);
    this.render();
    this.scroller.scrollLeft = Math.max(0, (day - this.rs) * this.px + this.labelW - x);
  }

  startDrag(e, n, bar) {
    if (e.button !== 0) return;
    const cls = e.target.classList;
    const mode = cls.contains("tg-hl") ? "l" : cls.contains("tg-hr") ? "r" : "m";
    const x0 = e.clientX, s0 = n.start, e0 = n.ongoing ? Math.max(n.end, this.model.today) : n.end, px = this.px;
    let ns = s0, ne = e0, moved = false;
    bar.setPointerCapture(e.pointerId);
    this.dragging = true;
    if (this.hover) this.hover.style.display = "none";
    bar.classList.add("tg-drag");
    const guides = this.makeGuides();
    const show = (ev) => { this.showTip(ev, ns, ne); guides.set(ns, ne); };
    const move = (ev) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < 3) return;
      moved = true;
      const d = Math.round(dx / px);
      if (mode === "m") { ns = s0 + d; ne = e0 + d; }
      else if (mode === "l") { ns = Math.min(s0 + d, e0); ne = e0; }
      else { ns = s0; ne = Math.max(e0 + d, s0); }
      const bx = this.box(ns, ne);
      if (bx) { bar.style.left = bx.left + "px"; bar.style.width = bx.width + "px"; }
      show(ev);
    };
    const up = async (ev) => {
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
      bar.removeEventListener("pointercancel", up);
      try { bar.releasePointerCapture(ev.pointerId); } catch (x) { /* ignore */ }
      this.tip.style.display = "none";
      guides.clear();
      bar.classList.remove("tg-drag");
      // an open-ended task keeps having no end date unless its right edge was dragged
      const changed = n.ongoing && mode !== "r" ? ns !== s0 : ns !== s0 || ne !== e0;
      if (moved && changed && ev.type === "pointerup") await this.schedule(n, ns, n.ongoing && mode !== "r" ? ns : ne);
      this.dragging = false;
      this.reload();
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
    bar.addEventListener("pointercancel", up);
    e.preventDefault();
  }
}

/* ---------- project overview / detail page ---------- */
const WEEKDAY = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const FILTERS = [["open", "全部"], ["active", "进行中"], ["paused", "暂停"], ["completed", "已完成"], ["archived", "已归档"]];
const TASK_STATUS = { doing: "进行中", short_term: "短期", long_term: "长期", abandoned: "已放弃" };

class ProjectsView {
  constructor(el, plugin) {
    this.el = el;
    this.plugin = plugin;
    this.sel = lsGet("tp-sel", ""); // "" = overview, "__none" = tasks without a project, else a project id
    this.filter = FILTERS.some(([k]) => k === lsGet("tp-filter", "open")) ? lsGet("tp-filter", "open") : "open";
    this.q = "";
    this.showDone = lsGet("tp-showdone", "0") === "1";
    this.fold = new Set();
    this.reminders = {}; this.projects = {}; this.stats = new Map();
    this.model = { today: todayNum(), projectOptions: [], groups: [] }; // the shared dialogs read these
    this.project = "";
    this.toast = h("div", { class: "tg-toast", style: "display:none" });
    this.active = false;
    this._onKey = (e) => this.onKey(e);
    this._onDown = (e) => { this.active = this.el.contains(e.target); };
    window.addEventListener("keydown", this._onKey);
    window.addEventListener("pointerdown", this._onDown, true);
    this._onData = () => { clearTimeout(this._t); this._t = setTimeout(() => this.reload(), 250); };
    window.addEventListener("reminderUpdated", this._onData);
    window.addEventListener("projectUpdated", this._onData);
    this.el.classList.add("tp");
    this.reload();
  }

  destroy() {
    window.removeEventListener("reminderUpdated", this._onData);
    window.removeEventListener("projectUpdated", this._onData);
    window.removeEventListener("keydown", this._onKey);
    window.removeEventListener("pointerdown", this._onDown, true);
    clearTimeout(this._t); clearTimeout(this._tt);
  }

  get host() { return this.plugin.getHost(); }

  async reload() {
    try {
      this.reminders = await this.host.loadReminderData(true);
      this.projects = await this.host.loadProjectData(true);
      await this.plugin.loadLog();
      await this.plugin.loadHidden();
    } catch (e) {
      this.el.replaceChildren(h("div", { class: "tg-empty" }, "读取任务数据失败：" + e));
      return;
    }
    this.render();
  }

  // the real projects, in their saved order
  projectList() {
    return Object.entries(this.projects || {}).filter(([k, p]) => !k.startsWith("_") && p && typeof p === "object" && p.id)
      .map(([, p]) => p).sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || String(a.title).localeCompare(String(b.title)));
  }

  statusOf(p) { return p.archived ? "archived" : PROJECT_STATUS.some(([k]) => k === p.status) ? p.status : "active"; }

  render() {
    const today = todayNum();
    this.model = { today, projectOptions: this.projectList().filter((p) => !p.archived).map((p) => ({ id: p.id, title: p.title || p.id })), groups: [] };
    this.stats = projectStats(this.reminders, this.plugin.log, this.plugin.hidden, today, new Set(this.projectList().map((p) => p.id)));
    const prev = this.scroller ? this.scroller.scrollTop : 0;
    const detail = this.sel && (this.sel === "__none" || this.projects[this.sel]);
    if (this.sel && !detail) { this.sel = ""; lsSet("tp-sel", ""); }
    this.project = this.sel === "__none" ? "" : this.sel;
    const body = h("div", { class: "tp-scroll" }, detail ? this.renderDetail() : this.renderOverview());
    this.scroller = body;
    this.el.replaceChildren(this.renderHeader(!!detail), body, this.toast);
    body.scrollTop = prev;
    if (this._refocusAdd) { this._refocusAdd = false; const i = this.el.querySelector && this.el.querySelector(".tp-add"); if (i && i.focus) i.focus(); }
  }

  /* ----- shared bits ----- */
  open(id) { this.sel = id; lsSet("tp-sel", id); this.scroller = null; this.render(); }

  viewInGantt(id) {
    lsSet("tg-project", id || "");
    this.plugin.open();
    setTimeout(() => window.dispatchEvent(Object.assign(new CustomEvent("tg-project"), { detail: { id: id || "" } })), 60);
  }

  pill(text, cls) { return h("span", { class: "tp-pill " + (cls || "") }, text); }

  renderHeader(detail) {
    if (detail) {
      const none = this.sel === "__none", p = none ? null : this.projects[this.sel];
      return h("div", { class: "tp-bar" },
        h("button", { class: "b3-button b3-button--outline", onclick: () => this.open("") }, "← 全部项目"),
        h("span", { class: "tp-dot", style: `background:${none ? "#8a8f98" : p.color || "#3b82f6"}` }),
        h("b", { class: "tp-crumb" }, none ? "未分类" : p.title),
        h("span", { class: "fn__flex-1" }),
        h("button", { class: "b3-button b3-button--outline", onclick: () => this.viewInGantt(none ? "" : this.sel) }, "在甘特图中查看"),
        h("button", { class: "b3-button b3-button--outline", disabled: !this.plugin.undoStack.length, onclick: () => this.undo() }, "撤销"));
    }
    const search = h("input", { class: "b3-text-field tp-search", type: "text", placeholder: "搜索项目", value: this.q });
    let comp = false;
    const apply = () => { this.q = search.value; clearTimeout(this._qt); this._qt = setTimeout(() => { this.render(); const i = this.el.querySelector && this.el.querySelector(".tp-search"); if (i && i.focus) { i.focus(); try { i.setSelectionRange(i.value.length, i.value.length); } catch (e) { /* ignore */ } } }, 200); };
    search.addEventListener("compositionstart", () => { comp = true; });
    search.addEventListener("compositionend", () => { comp = false; apply(); });
    search.addEventListener("input", () => { if (!comp) apply(); });
    const chips = h("div", { class: "tg-seg" }, FILTERS.map(([k, t]) => h("button", { class: "b3-button b3-button--outline" + (k === this.filter ? " tg-on" : ""), onclick: () => { this.filter = k; lsSet("tp-filter", k); this.render(); } }, t)));
    return h("div", { class: "tp-bar" }, h("b", { class: "tp-title" }, "项目"), search, chips, h("span", { class: "fn__flex-1" }),
      h("button", { class: "b3-button b3-button--outline", disabled: !this.plugin.undoStack.length, onclick: () => this.undo() }, "撤销"),
      h("button", { class: "b3-button b3-button--text", onclick: () => this.openNewProject() }, "＋ 新建项目"));
  }

  /* ----- overview: one card per project ----- */
  renderOverview() {
    const q = this.q.trim().toLowerCase();
    const list = this.projectList().filter((p) => {
      const st = this.statusOf(p);
      if (this.filter === "open" ? st === "archived" : st !== this.filter) return false;
      return !q || String(p.title || "").toLowerCase().includes(q);
    });
    const none = this.stats.get("");
    const cards = list.map((p) => this.card(p));
    if (none && none.total && (this.filter === "open") && !q) cards.push(this.card({ id: "__none", title: "未分类", color: "#8a8f98", virtual: true }));
    if (!cards.length) {
      return h("div", { class: "tp-empty" }, h("div", { class: "tp-empty-t" }, this.projectList().length ? "没有符合条件的项目" : "还没有项目"),
        h("div", null, this.projectList().length ? "换个筛选条件，或清空搜索。" : "项目用来把任务分组。先建一个，再到甘特图里添加任务。"),
        this.projectList().length ? null : h("button", { class: "b3-button b3-button--text", onclick: () => this.openNewProject() }, "＋ 新建项目"));
    }
    return h("div", { class: "tp-grid" }, cards);
  }

  spark(weekly, color) {
    const max = Math.max(1, ...weekly);
    return h("div", { class: "tp-spark", title: "近 12 周每周完成的任务数" }, weekly.map((v, i) => h("i", { style: `height:${Math.max(v ? 14 : 5, Math.round((v / max) * 100))}%;background:${color};opacity:${v ? 0.35 + 0.65 * (i / 11) : 0.12}` })));
  }

  card(p) {
    const real = !p.virtual, st = this.stats.get(real ? p.id : "") || { total: 0, leaves: 0, done: 0, dropped: 0, open: 0, today: 0, late: 0, undated: 0, recent: 0, weekly: new Array(12).fill(0), last: null };
    const denom = st.leaves - st.dropped, pct = denom > 0 ? Math.round((st.done / denom) * 100) : 0;
    const color = p.color || "#3b82f6", status = real ? this.statusOf(p) : "";
    const stat = (n, label, cls) => h("div", { class: "tp-stat " + (cls || "") + (n ? "" : " tp-zero") }, h("b", null, String(n)), h("span", null, label));
    const dates = real && (p.startDate || p.endDate) ? `${p.startDate ? p.startDate.slice(5) : "…"} ~ ${p.endDate ? p.endDate.slice(5) : "进行中"}` : "";
    const last = st.last ? h("div", { class: "tp-last", title: st.last.text }, h("span", { class: "tp-lastk" }, `最近成果 ${st.last.time.slice(5, 10)}`), " " + String(st.last.text).replace(/\s+/g, " ").slice(0, 46))
      : h("div", { class: "tp-last tp-dim" }, st.recent ? `近 30 天完成 ${st.recent} 个任务` : "近 30 天没有完成任务");
    const el = h("div", { class: "tp-card" + (status === "archived" ? " tp-arch" : ""), style: `--pc:${color}`, onclick: () => this.open(p.id) },
      h("div", { class: "tp-ch" }, h("span", { class: "tp-ct" }, p.title || "(未命名)"),
        real ? this.pill(PROJECT_STATUS.concat([["archived", "已归档"]]).find(([k]) => k === status)[1], "tp-s-" + status) : null,
        real && p.priority && p.priority !== "none" ? this.pill(PRIO_NAME[p.priority], "tp-p-" + p.priority) : null),
      h("div", { class: "tp-prog" }, h("div", { class: "tp-bar2" }, h("i", { style: `width:${pct}%` })), h("span", { class: "tp-pct" }, `${pct}%`), h("span", { class: "tp-dim" }, `${st.done} / ${denom} 个任务`)),
      h("div", { class: "tp-stats" }, stat(st.today, "今日"), stat(st.late, "超期", st.late ? "tp-red" : ""), stat(st.undated, "未排期"), stat(st.open, "未完成")),
      last,
      h("div", { class: "tp-cf" }, dates ? h("span", { class: "tp-dim" }, dates) : null, h("span", { class: "fn__flex-1" }), this.spark(st.weekly, color),
        h("button", { class: "b3-button b3-button--outline tp-mini", title: "在甘特图中只看这个项目", onclick: (e) => { e.stopPropagation(); this.viewInGantt(real ? p.id : ""); } }, "甘特图")));
    return el;
  }

  /* ----- detail ----- */
  pidOf(t) { const p = t.projectId && this.projects[t.projectId]; return p && typeof p === "object" ? t.projectId : ""; }

  tasksOf(pid) { return Object.values(this.reminders).filter((t) => t && t.id && this.pidOf(t) === pid); }

  renderDetail() {
    const none = this.sel === "__none", pid = none ? "" : this.sel, p = none ? { id: "", title: "未分类", color: "#8a8f98", virtual: true } : this.projects[pid];
    const st = this.stats.get(pid) || { total: 0, leaves: 0, done: 0, dropped: 0, open: 0, today: 0, late: 0, undated: 0, recent: 0, weekly: new Array(12).fill(0), last: null };
    const denom = st.leaves - st.dropped, pct = denom > 0 ? Math.round((st.done / denom) * 100) : 0, color = p.color || "#3b82f6";
    const tile = (n, label, cls) => h("div", { class: "tp-tile " + (cls || "") }, h("b", null, String(n)), h("span", null, label));
    const stats = h("div", { class: "tp-tiles" },
      h("div", { class: "tp-tile tp-big", style: `--pc:${color}` }, h("b", null, `${pct}%`), h("span", null, `完成 ${st.done} / ${denom}`), h("div", { class: "tp-bar2" }, h("i", { style: `width:${pct}%` }))),
      tile(st.today, "今日"), tile(st.late, "超期", st.late ? "tp-red" : ""), tile(st.undated, "未排期"), tile(st.recent, "近 30 天完成"),
      h("div", { class: "tp-tile tp-wide" }, this.spark(st.weekly, color), h("span", null, "近 12 周完成")));
    return h("div", { class: "tp-detail" }, none ? this.noneInfo(st) : this.infoCard(p), stats,
      h("div", { class: "tp-cols" }, this.taskPanel(pid, p), this.timelinePanel(pid)));
  }

  noneInfo(st) {
    return h("div", { class: "tp-info" }, h("div", { class: "tp-dim" }, `有 ${st.total} 个任务还没有归入任何项目。`),
      h("button", { class: "b3-button b3-button--text", disabled: !this.projectList().filter((p) => !p.archived).length, onclick: () => this.openAssign() }, "整理这些任务…"));
  }

  infoCard(p) {
    const save = async (patch) => { try { await this.plugin.updateProject(p.id, patch); await this.reload(); } catch (e) { showMessage("保存失败：" + e, 4000, "error"); this.render(); } };
    const sel = (opts, cur, on) => { const s = h("select", { class: "b3-select" }, opts.map(([v, t]) => h("option", { value: v, selected: v === cur }, t))); s.addEventListener("change", () => on(s.value)); return s; };
    const name = h("input", { class: "b3-text-field tp-name", type: "text", value: p.title || "" });
    name.addEventListener("change", () => save({ title: name.value }));
    const color = h("input", { type: "color", class: "tg-colorin", value: /^#[0-9a-fA-F]{6}$/.test(p.color || "") ? p.color : "#3b82f6", title: "项目颜色" });
    color.addEventListener("change", () => save({ color: color.value }));
    const date = (k) => { const i = h("input", { class: "b3-text-field", type: "date", value: p[k] || "" }); i.addEventListener("change", () => save({ [k]: i.value })); return i; };
    const note = h("textarea", { class: "b3-text-field fn__block tp-note", rows: "3", placeholder: "项目说明、目标、背景…（失去焦点自动保存）" });
    note.value = p.note || "";
    note.addEventListener("change", () => save({ note: note.value }));
    const st = this.statusOf(p);
    const field = (k, c) => h("label", { class: "tp-f" }, h("span", null, k), c);
    const docChip = this.docChip(p);
    const more = h("button", { class: "b3-button b3-button--outline", title: "归档 / 删除", onclick: (e) => this.projectMenu(e, p) }, "⋯");
    return h("div", { class: "tp-info" },
      h("div", { class: "tp-row1" }, color, name, sel(PROJECT_STATUS, st === "archived" ? p.status || "active" : st, (v) => save({ status: v })), sel(Object.entries(PRIO_NAME).map(([k, t]) => [k, k === "none" ? "优先级：无" : "优先级：" + t]), p.priority || "none", (v) => save({ priority: v })), st === "archived" ? this.pill("已归档", "tp-s-archived") : null, more),
      h("div", { class: "tp-row2" }, field("开始", date("startDate")), field("结束", date("endDate")), field("文档", docChip)),
      note);
  }

  docChip(p) {
    const save = async (patch) => { try { await this.plugin.updateProject(p.id, patch); await this.reload(); } catch (e) { showMessage("保存失败：" + e, 4000, "error"); } };
    if (!p.blockId) return h("button", { class: "b3-button b3-button--outline", onclick: () => this.openBindDoc(p) }, "绑定文档…");
    const open = h("button", { class: "b3-button b3-button--outline tp-doc", title: "打开绑定的文档", onclick: async () => {
      if ((await this.plugin.blockExists(p.blockId)) === false) { showMessage("绑定的文档已被删除，请重新绑定或解除", 4000, "info"); return; }
      try { openTab({ app: this.plugin.app, doc: { id: p.blockId } }); } catch (e) { showMessage("打开失败：" + e, 4000, "error"); }
    } }, p.blockTitle || "已绑定文档");
    return h("span", { class: "tp-docs" }, open, h("button", { class: "b3-button b3-button--outline", title: "换一个文档", onclick: () => this.openBindDoc(p) }, "更换"), h("button", { class: "b3-button b3-button--outline", title: "解除绑定", onclick: () => save({ blockId: "" }) }, "×"));
  }

  projectMenu(ev, p) {
    const menu = new Menu("task-gantt-proj");
    const archived = !!p.archived;
    menu.addItem({ icon: "iconArchive", label: archived ? "取消归档" : "归档项目", click: async () => { try { await this.plugin.updateProject(p.id, { archived: !archived }); this.say(archived ? "已取消归档" : "已归档，可在筛选「已归档」里找到", false); await this.reload(); } catch (e) { showMessage("操作失败：" + e, 4000, "error"); } } });
    menu.addSeparator();
    const n = this.tasksOf(p.id).length;
    menu.addItem({ icon: "iconTrashcan", label: "删除项目…", click: () => sConfirm("删除项目", `删除项目「${p.title}」？它的 ${n} 个任务不会被删除，会变成「未分类」。`, async () => {
      try { await this.plugin.deleteProject(p.id); this.sel = ""; lsSet("tp-sel", ""); await this.reload(); this.say("已删除项目", false); } catch (e) { showMessage("删除失败：" + e, 5000, "error"); }
    }) });
    menu.open({ x: ev.clientX, y: ev.clientY });
  }

  /* ----- tasks of the project ----- */
  fmtWhen(t) {
    const s = toNum(t.date), e = toNum(t.endDate), md = (d) => fromNum(d).slice(5);
    if (s != null) return e != null && e > s ? `${md(s)} ~ ${md(e)}` : md(s) + (e == null && t.kanbanStatus === "doing" ? " 起" : "");
    if (e != null) return `截止 ${md(e)}`;
    return "未排期";
  }

  nodeFor(t) {
    const kids = this.tasksOf(this.pidOf(t)).filter((x) => x.parentId === t.id);
    const cp = Number(t.customProgress);
    return { id: t.id, t, children: kids, progress: t.completed ? 1 : Number.isFinite(cp) && cp > 0 ? Math.min(cp, 100) / 100 : 0 };
  }

  taskPanel(pid, p) {
    const today = this.model.today, all = this.tasksOf(pid), ids = new Set(all.map((t) => t.id));
    const kids = new Map();
    for (const t of all) { const k = ids.has(t.parentId) ? t.parentId : ""; (kids.get(k) || kids.set(k, []).get(k)).push(t); }
    for (const l of kids.values()) l.sort((a, b) => (a.completed ? 1 : 0) - (b.completed ? 1 : 0) || (Number(a.sort) || 0) - (Number(b.sort) || 0) || String(a.title).localeCompare(String(b.title)));
    const hid = this.plugin.hidden || new Set();
    const alive = (t) => !t.completed || [...(kids.get(t.id) || [])].some(alive); // a finished parent stays visible while it still has open work
    const visible = (t) => this.showDone || alive(t);
    const rows = []; const seen = new Set();
    const walk = (t, d) => {
      if (seen.has(t.id) || !visible(t)) return;
      seen.add(t.id);
      const sub = (kids.get(t.id) || []).filter(visible), folded = this.fold.has(t.id);
      rows.push(this.taskRow(t, d, sub.length, folded, today, hid));
      if (!folded) sub.forEach((c) => walk(c, d + 1));
    };
    (kids.get("") || []).forEach((t) => walk(t, 0));
    const nDone = all.filter((t) => t.completed).length;
    const add = h("input", { class: "b3-text-field tp-add", type: "text", placeholder: pid || this.sel !== "__none" ? "＋ 添加任务到此项目，回车创建（日期为今天）" : "＋ 添加未分类任务，回车创建（日期为今天）" });
    let comp = false;
    add.addEventListener("compositionstart", () => { comp = true; });
    add.addEventListener("compositionend", () => { comp = false; });
    add.addEventListener("keydown", async (e) => {
      if (e.isComposing || comp || e.key !== "Enter") return;
      e.preventDefault();
      const title = add.value.trim();
      if (!title) return;
      add.value = "";
      try { await this.plugin.createTask({ title, date: fromNum(this.model.today), projectId: pid }); this._refocusAdd = true; this.say(`已新建「${title}」（今天）`, true); await this.reload(); } catch (err) { add.value = title; showMessage("新建失败：" + err, 5000, "error"); }
    });
    const doneSw = h("label", { class: "tg-chk" }, h("input", { type: "checkbox", class: "b3-switch", checked: this.showDone, onchange: (e) => { this.showDone = e.target.checked; lsSet("tp-showdone", this.showDone ? "1" : "0"); this.render(); } }), `显示已完成（${nDone}）`);
    const full = h("button", { class: "b3-button b3-button--outline", onclick: () => this.openCreate({ projectId: pid }) }, "新建…");
    return h("div", { class: "tp-panel" }, h("div", { class: "tp-ph" }, h("b", null, "任务"), h("span", { class: "fn__flex-1" }), doneSw, full), add,
      h("div", { class: "tp-tasks" }, rows.length ? rows : h("div", { class: "tp-dim tp-none" }, all.length ? "没有未完成的任务。" : "这里还没有任务。在上面输入标题回车即可添加。")));
  }

  taskRow(t, depth, nSub, folded, today, hid) {
    const kind = focusKind(t, today);
    const badge = t.completed ? null : kind === "late" ? this.pill(`超期 ${today - toNum(t.endDate)} 天`, "tp-b-late") : kind === "today" ? this.pill("今日", "tp-b-today") : null;
    const tog = nSub ? h("span", { class: "tg-tog", onclick: () => { folded ? this.fold.delete(t.id) : this.fold.add(t.id); this.render(); } }, folded ? "▸" : "▾") : h("span", { class: "tg-tog" });
    const box = h("input", { type: "checkbox", class: "tp-chk", checked: !!t.completed, title: t.completed ? "取消完成" : "标记完成" });
    box.addEventListener("click", (e) => { e.preventDefault(); this.toggleDone(t).then(() => this.reload()); });
    const act = (label, title, fn) => h("button", { class: "tp-act", title, onclick: (e) => { e.stopPropagation(); fn(); } }, label);
    const prog = this.plugin.progressOf(t.id).length;
    return h("div", { class: "tp-row" + (t.completed ? " tp-done" : ""), style: `padding-left:${8 + depth * 18}px`, "data-id": t.id },
      tog, box,
      h("span", { class: "tp-rt", title: "编辑任务", onclick: () => this.editTask(t) }, t.title || "(无标题)"),
      hid.has(t.id) ? this.pill("已隐藏", "tp-dim-pill") : null,
      TASK_STATUS[t.kanbanStatus] && t.kanbanStatus !== "doing" ? this.pill(TASK_STATUS[t.kanbanStatus], "tp-b-st") : null,
      badge, prog ? h("span", { class: "tp-dim", title: "成果记录条数" }, `◆${prog}`) : null,
      h("span", { class: "fn__flex-1" }),
      h("span", { class: "tp-when" + (kind === "late" ? " tp-red" : "") }, this.fmtWhen(t)),
      h("span", { class: "tp-acts" }, act("记录", "记录进度", () => this.openProgress(this.nodeFor(t))), act("＋子", "新建子任务", () => this.openCreate({ parentId: t.id })), act("删除", "删除任务", () => this.deleteTask(t))));
  }

  /* ----- results timeline ----- */
  timelinePanel(pid) {
    const items = projectTimeline(this.reminders, this.plugin.log, pid, 60, new Set(this.projectList().map((p) => p.id)));
    const groups = [];
    for (const e of items) { const d = e.time.slice(0, 10); if (!groups.length || groups[groups.length - 1].d !== d) groups.push({ d, list: [] }); groups[groups.length - 1].list.push(e); }
    const head = (d) => { const n = toNum(d); return n == null ? d : `${d.slice(5)}　${WEEKDAY[wday(n)]}`; };
    return h("div", { class: "tp-panel" }, h("div", { class: "tp-ph" }, h("b", null, "成果时间线"), h("span", { class: "tp-dim" }, items.length ? `最近 ${items.length} 条` : "")),
      h("div", { class: "tp-tl" }, groups.length ? groups.map((g) => h("div", { class: "tp-day" }, h("div", { class: "tp-dayh" }, head(g.d)),
        g.list.map((e) => h("div", { class: "tp-ev" }, h("span", { class: "tp-evt" }, e.time.slice(11)),
          h("div", { class: "tp-evb" }, h("div", null, h("span", { class: "tp-evk", title: "查看这个任务的全部记录", onclick: () => { const t = this.reminders[e.taskId]; if (t) this.openProgressList(this.nodeFor(t)); } }, e.taskTitle), e.progress != null ? this.pill(e.progress + "%", "tp-b-today") : null),
            h("div", { class: "tp-evx" }, e.text)))))) : h("div", { class: "tp-dim tp-none" }, "还没有成果记录。在任务上点「记录」，这里会按时间汇总，写周报时一目了然。")));
  }

  /* ----- dialogs ----- */
  openNewProject() {
    const name = h("input", { class: "b3-text-field fn__block", type: "text", placeholder: "项目名称" });
    const color = h("input", { type: "color", class: "tg-colorin", value: ["#3b82f6", "#22a05a", "#f5a524", "#9b59b6", "#e5484d", "#14b8a6"][this.projectList().length % 6] });
    const note = h("textarea", { class: "b3-text-field fn__block", rows: "3", placeholder: "项目说明（可选）" });
    const row = (k, c) => h("label", { class: "tg-frow" }, h("span", null, k), c);
    const dlg = new Dialog({ title: "新建项目", width: "440px", content: `<div class="b3-dialog__content tg-form"></div><div class="b3-dialog__action"></div>` });
    dlg.element.querySelector(".tg-form").append(row("名称", name), row("颜色", color), row("说明", note));
    const bCancel = h("button", { class: "b3-button b3-button--cancel" }, "取消"), bOk = h("button", { class: "b3-button b3-button--text" }, "创建");
    dlg.element.querySelector(".b3-dialog__action").append(bCancel, h("div", { class: "fn__space" }), bOk);
    let busy = false;
    const submit = async () => {
      if (busy) return;
      if (!name.value.trim()) { name.focus(); return; }
      busy = true;
      try { const id = await this.plugin.saveProject({ title: name.value, color: color.value, note: note.value }); dlg.destroy(); await this.reload(); this.open(id); } catch (e) { busy = false; showMessage("创建失败：" + e, 5000, "error"); }
    };
    bCancel.addEventListener("click", () => dlg.destroy()); bOk.addEventListener("click", submit);
    name.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(); } });
    setTimeout(() => name.focus(), 50);
    return { ctl: { name, color, note }, submit };
  }

  // tasks with no project: tick some, pick the project they go to
  openAssign() {
    const targets = this.projectList().filter((p) => !p.archived);
    const roots = this.tasksOf("").filter((t) => !t.parentId || !this.reminders[t.parentId] || this.pidOf(this.reminders[t.parentId]) !== "").sort((a, b) => (a.completed ? 1 : 0) - (b.completed ? 1 : 0) || String(a.title).localeCompare(String(b.title)));
    const dest = h("select", { class: "b3-select fn__block" }, targets.map((p) => h("option", { value: p.id }, p.title)));
    const boxes = roots.map((t) => ({ t, el: h("input", { type: "checkbox", class: "b3-switch", checked: !t.completed }) }));
    const list = h("div", { class: "tp-assign" }, boxes.map(({ t, el }) => h("label", { class: "tp-arow" }, el, h("span", { class: t.completed ? "tp-dim" : "" }, t.title || "(无标题)"), h("span", { class: "tp-dim" }, this.fmtWhen(t)))));
    const dlg = new Dialog({ title: "整理未分类任务", width: "520px", content: `<div class="b3-dialog__content tg-form"></div><div class="b3-dialog__action"></div>` });
    dlg.element.querySelector(".tg-form").append(h("div", { class: "tg-frow" }, h("span", null, "归入项目（子任务一起移动）"), dest), list);
    const bCancel = h("button", { class: "b3-button b3-button--cancel" }, "取消"), bOk = h("button", { class: "b3-button b3-button--text" }, "归入");
    dlg.element.querySelector(".b3-dialog__action").append(bCancel, h("div", { class: "fn__space" }), bOk);
    let busy = false;
    const submit = async () => {
      if (busy) return;
      const pick = boxes.filter((b) => b.el.checked).map((b) => b.t.id);
      if (!pick.length) { showMessage("请先勾选任务", 3000, "info"); return; }
      busy = true;
      try { const n = await this.plugin.assignProject(pick, dest.value); dlg.destroy(); this.say(`已归类 ${n} 个任务`, true); await this.reload(); } catch (e) { busy = false; showMessage("归类失败：" + e, 5000, "error"); }
    };
    bCancel.addEventListener("click", () => dlg.destroy()); bOk.addEventListener("click", submit);
    return { ctl: { dest, boxes }, submit };
  }

  // pick the document that describes this project (shown on the page, and offered first when creating a task document)
  async openBindDoc(p) {
    let notebooks;
    try { notebooks = await this.plugin.listNotebooks(); } catch (e) { showMessage("读取笔记本失败：" + e, 5000, "error"); return; }
    if (!notebooks.length) { showMessage("没有已打开的笔记本", 4000, "error"); return; }
    const nb = new Map(notebooks.map((n) => [n.id, n.name]));
    const q = h("input", { class: "b3-text-field fn__block", type: "text", placeholder: "搜索文档，输入路径或标题中的关键字" });
    const list = h("select", { class: "b3-select fn__block tg-plist", size: "8" });
    let rows = [], token = 0, timer = null, comp = false;
    const fill = () => list.replaceChildren(...rows.map((r) => h("option", { value: r.id }, `${nb.get(r.box) || ""}${r.hpath}`)));
    const search = async () => { const my = ++token; try { const found = await this.plugin.searchDocs(q.value, notebooks); if (my !== token) return; rows = found; } catch (e) { showMessage("搜索失败：" + e, 4000, "error"); return; } fill(); };
    const kick = () => { clearTimeout(timer); timer = setTimeout(search, 200); };
    q.addEventListener("compositionstart", () => { comp = true; }); q.addEventListener("compositionend", () => { comp = false; kick(); }); q.addEventListener("input", () => { if (!comp) kick(); });
    const dlg = new Dialog({ title: `绑定文档：${p.title}`, width: "560px", content: `<div class="b3-dialog__content tg-form"></div><div class="b3-dialog__action"></div>` });
    dlg.element.querySelector(".tg-form").append(h("div", { class: "tg-frow" }, h("span", null, "选择文档"), q, list));
    const bCancel = h("button", { class: "b3-button b3-button--cancel" }, "取消"), bOk = h("button", { class: "b3-button b3-button--text" }, "绑定");
    dlg.element.querySelector(".b3-dialog__action").append(bCancel, h("div", { class: "fn__space" }), bOk);
    const submit = async () => {
      const r = rows.find((x) => x.id === list.value);
      if (!r) { showMessage("请先选择文档", 3000, "info"); return; }
      try { await this.plugin.updateProject(p.id, { blockId: r.id, blockTitle: r.hpath.split("/").filter(Boolean).pop() || r.hpath }); dlg.destroy(); await this.reload(); } catch (e) { showMessage("绑定失败：" + e, 5000, "error"); }
    };
    bCancel.addEventListener("click", () => dlg.destroy()); bOk.addEventListener("click", submit);
    search();
    return { ctl: { q, list }, submit, get rows() { return rows; } };
  }
}

// the dialogs, undo toast and task actions are the chart's own; the project page borrows them instead of keeping a second copy
for (const m of ["openCreate", "parentChoices", "openProgress", "openProgressList", "deleteTask", "toggleDone", "editTask", "say", "undo", "onKey"]) ProjectsView.prototype[m] = GanttView.prototype[m];

/* ---------- plugin ---------- */
module.exports = class TaskGanttPlugin extends Plugin {
  onload() {
    this.undoStack = []; // [{label, before:{id: record|null}}] — whole-record snapshots taken before each write
    const self = this;
    // same four methods as the host plugin, so every task read/write goes through one interface in either mode
    const read = async (file, ref) => {
      let d = null;
      try { d = await self.loadData(file); } catch (e) { /* first run */ }
      return d && typeof d === "object" && !Array.isArray(d) ? JSON.parse(JSON.stringify(d)) : {}; // a copy: callers mutate before saving
    };
    this.own = {
      _t: null, _p: null,
      async loadReminderData(force) { if (force || !this._t) this._t = await read(TASKS_FILE); return this._t; },
      async saveReminderData(d) { await self.saveData(TASKS_FILE, d); this._t = d; },
      async loadProjectData(force) { if (force || !this._p) this._p = await read(PROJECTS_FILE); return this._p; },
      async saveProjectData(d) { await self.saveData(PROJECTS_FILE, d); this._p = d; },
      reset() { this._t = null; this._p = null; },
    };
    this.addIcons(`<symbol id="iconTaskGantt" viewBox="0 0 32 32"><path d="M4 5h2v22H4zM8 7h12a1.5 1.5 0 0 1 0 3H8zM12 13h14a1.5 1.5 0 0 1 0 3H12zM10 19h8a1.5 1.5 0 0 1 0 3h-8zM16 25h10a1.5 1.5 0 0 1 0 3H16z" fill="currentColor"/></symbol>`);
    this.addIcons(`<symbol id="iconTaskProjects" viewBox="0 0 32 32"><path d="M4 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zm12 0a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2zM4 18a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zm14 0h10v3H18zm0 5h10v3H18z" fill="currentColor"/></symbol>`);
    const plugin = this;
    this.addTab({
      type: TAB,
      // NOTE: SiYuan serializes `this.data` into the saved layout (JSON.stringify) when tabs are
      // opened/closed. Never put the view (DOM / circular refs) there, or closing the tab breaks.
      init() { this.ganttView = new GanttView(this.element, plugin); },
      destroy() {
        try { if (this.ganttView) this.ganttView.destroy(); } catch (e) { console.warn("[task-gantt] destroy failed", e); }
        this.ganttView = null;
      },
    });
    this.addTab({
      type: TAB_P,
      init() { this.projectsView = new ProjectsView(this.element, plugin); },
      destroy() {
        try { if (this.projectsView) this.projectsView.destroy(); } catch (e) { console.warn("[task-gantt] destroy failed", e); }
        this.projectsView = null;
      },
    });
    this.addTopBar({ icon: "iconTaskGantt", title: "任务甘特图", position: "right", callback: () => this.open() });
    this.addTopBar({ icon: "iconTaskProjects", title: "项目", position: "right", callback: () => this.openProjects() });
    this.addCommand({ langKey: "openTaskProjects", langText: "打开项目管理", hotkey: "", callback: () => this.openProjects() });
    this.addCommand({ langKey: "openTaskGantt", langText: "打开任务甘特图", hotkey: "", callback: () => this.open() });
  }

  open() {
    openTab({ app: this.app, custom: { icon: "iconTaskGantt", title: "任务甘特图", data: {}, id: this.name + TAB } });
  }

  openProjects() {
    openTab({ app: this.app, custom: { icon: "iconTaskProjects", title: "项目", data: {}, id: this.name + TAB_P } });
  }

  // every task read/write goes through this object (see onload): the plugin's own store
  getHost() { return this.own; }

  async backupOnce(data) {
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const name = `backup-reminder-${stamp}.json`;
    const exist = await this.loadData(name);
    if (!exist) await this.saveData(name, JSON.parse(JSON.stringify(data)));
  }

  /* ----- documents (kernel API) ----- */
  async sql(stmt) {
    const r = await fetchSyncPost("/api/query/sql", { stmt });
    if (!r || r.code !== 0) throw new Error((r && r.msg) || "查询失败");
    return r.data || [];
  }

  // true / false from the kernel's block tree; null when it cannot tell (never treat "unknown" as deleted)
  async blockExists(id) {
    try {
      const r = await fetchSyncPost("/api/block/checkBlockExist", { id });
      return r && r.code === 0 && typeof r.data === "boolean" ? r.data : null;
    } catch (e) { return null; }
  }

  // task ids whose bound block/document no longer exists. The index lookup is cheap but can lag behind, so anything it misses is re-checked.
  async findDeadBindings(reminders) {
    const byBlock = new Map();
    for (const t of Object.values(reminders || {})) {
      if (!t || typeof t !== "object" || !t.id) continue;
      const b = t.blockId || t.docId;
      if (b) (byBlock.get(b) || byBlock.set(b, []).get(b)).push(t.id);
    }
    const ids = [...byBlock.keys()], found = new Set();
    try {
      for (let i = 0; i < ids.length; i += 100) {
        const rows = await this.sql(`select id from blocks where id in (${ids.slice(i, i + 100).map((x) => "'" + String(x).replace(/'/g, "") + "'").join(",")})`);
        for (const r of rows) found.add(r.id);
      }
    } catch (e) { return new Set(); } // no index answer: report nothing rather than guess
    const dead = new Set();
    for (const id of ids) if (!found.has(id) && (await this.blockExists(id)) === false) byBlock.get(id).forEach((tid) => dead.add(tid));
    return dead;
  }

  // drop a binding whose block is gone (blockId/docId/docTitle); refuses if the block still exists
  async unbindDoc(taskId) {
    const host = this.getHost();
    const data = await host.loadReminderData(true);
    const t = data && data[taskId];
    if (!t) throw new Error("任务已不存在");
    const b = t.blockId || t.docId;
    if (!b) throw new Error("任务没有绑定文档");
    if ((await this.blockExists(b)) !== false) throw new Error("绑定的文档仍然存在，未解除");
    await this.backupOnce(data);
    const before = this.snap(data, [taskId]);
    delete t.blockId; delete t.docId; delete t.docTitle;
    await host.saveReminderData(data);
    this.pushUndo(`解除绑定「${t.title}」`, before);
    window.dispatchEvent(new CustomEvent("reminderUpdated"));
  }

  async listNotebooks() {
    const r = await fetchSyncPost("/api/notebook/lsNotebooks", "");
    if (!r || r.code !== 0) throw new Error((r && r.msg) || "读取笔记本失败");
    return ((r.data && r.data.notebooks) || []).filter((n) => !n.closed).map((n) => ({ id: n.id, name: n.name }));
  }

  // documents whose path contains every keyword (no keyword: most recently updated); [{id, box, hpath}]
  async searchDocs(keyword, notebooks) {
    const esc = (x) => String(x).replace(/'/g, "''");
    const boxes = notebooks.map((n) => `'${esc(n.id)}'`).join(",");
    const kws = String(keyword || "").split(/\s+/).filter(Boolean).slice(0, 5);
    const where = kws.map((k) => ` and hpath like '%${esc(k)}%'`).join("");
    return (await this.sql(`select id, box, hpath from blocks where type='d' and box in (${boxes})${where} order by updated desc limit 50`)).map((r) => ({ id: r.id, box: r.box, hpath: r.hpath }));
  }

  // the documents holding the given block ids (a block id resolves to its root document); rootOf = the id that was asked for
  async docsOf(ids, notebooks) {
    const esc = (x) => String(x).replace(/'/g, "''");
    const boxes = notebooks.map((n) => `'${esc(n.id)}'`).join(",");
    const list = ids.map((x) => `'${esc(x)}'`).join(",");
    const rows = await this.sql(`select b.id as bid, d.id as id, d.box as box, d.hpath as hpath from blocks b join blocks d on d.id = b.root_id where b.id in (${list}) and d.box in (${boxes})`);
    return rows.map((r) => ({ id: r.id, box: r.box, hpath: r.hpath, rootOf: r.bid }));
  }

  // Create a document and make it the task's bound block, the way the host's own bind does:
  // task.blockId/docId/docTitle, plus the block attributes (bookmark, custom-bind-reminders, custom-task-projectId).
  async createDocAndBind(taskId, { title, box, parentHPath }) {
    const host = this.getHost();
    const before = await host.loadReminderData(true);
    const t0 = before && before[taskId];
    if (!t0) throw new Error("任务已不存在");
    if ((t0.blockId || t0.docId) && (await this.blockExists(t0.blockId || t0.docId)) !== false) throw new Error("任务已经绑定了文档");
    if (!title || !box) throw new Error("缺少标题或笔记本");
    await this.backupOnce(before);
    const base = !parentHPath || parentHPath === "/" ? "" : String(parentHPath).replace(/\/+$/, "");
    const r = await fetchSyncPost("/api/filetree/createDocWithMd", { notebook: box, path: base + "/" + title, markdown: "" });
    if (!r || r.code !== 0 || !r.data) throw new Error((r && r.msg) || "创建文档失败");
    const docId = r.data;
    const data = await host.loadReminderData(true); // re-read: the task may have changed while the kernel was busy
    const t = data[taskId];
    if (!t) throw new Error("文档已创建（" + docId + "），但任务已不存在");
    t.blockId = docId; t.docId = docId; t.docTitle = title;
    await host.saveReminderData(data);
    try {
      const a = await fetchSyncPost("/api/attr/setBlockAttrs", { id: docId, attrs: { bookmark: "⏰", "custom-bind-reminders": taskId, "custom-task-projectId": t.projectId || "" } });
      if (!a || a.code !== 0) throw new Error((a && a.msg) || "setBlockAttrs");
    } catch (e) { showMessage("文档已创建并绑定，但写入块属性失败：" + e, 6000, "info"); }
    window.dispatchEvent(new CustomEvent("reminderUpdated"));
    return docId;
  }

  snap(data, ids) {
    const before = {};
    for (const id of ids) before[id] = data[id] ? JSON.parse(JSON.stringify(data[id])) : null;
    return before;
  }

  pushUndo(label, before, logAdd, logRestore) {
    this.undoStack.push({ label, before, logAdd, logRestore });
    if (this.undoStack.length > 30) this.undoStack.shift();
  }

  async undoLast() {
    const e = this.undoStack.pop();
    if (!e) return null;
    try {
      const host = this.getHost();
      const data = await host.loadReminderData(true);
      await this.backupOnce(data);
      for (const [id, rec] of Object.entries(e.before)) { if (rec) data[id] = rec; else delete data[id]; }
      if (Object.keys(e.before).length) await host.saveReminderData(data);
      if (e.logAdd) await this.removeProgress(e.logAdd.taskId, e.logAdd.entryId);
      if (e.logRestore) { if (!this.log) await this.loadLog(); Object.assign(this.log, e.logRestore); await this.saveLog(); }
        window.dispatchEvent(new CustomEvent("reminderUpdated"));
      return e.label;
    } catch (err) { this.undoStack.push(e); throw err; }
  }

  async createTask({ title, date, endDate, projectId, parentId, priority, kanbanStatus }) {
    const host = this.getHost();
    if (!title || !RE_DATE.test(date) || (endDate && !RE_DATE.test(endDate))) throw new Error("标题或日期无效");
    const data = await host.loadReminderData(true);
    const parent = parentId ? data[parentId] : null;
    if (parentId && !parent) throw new Error("父任务已不存在");
    await this.backupOnce(data);
    let id;
    do { id = `reminder_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`; } while (data[id]);
    const pid = parent ? parent.projectId : projectId;
    const sibs = Object.values(data).filter((x) => x && (parentId ? x.parentId === parentId : !x.parentId && (x.projectId || "") === (pid || "")));
    const sort = sibs.reduce((m, x) => Math.max(m, Number(x.sort) || 0), 0) + 1000;
    const rec = { id, title, completed: false, priority: priority || "none", createdAt: new Date().toISOString(), kanbanStatus: kanbanStatus || (parent && parent.kanbanStatus) || "doing", sort, date };
    if (endDate && endDate > date) rec.endDate = endDate;
    if (pid) rec.projectId = pid;
    if (parentId) rec.parentId = parentId;
    data[id] = rec;
    await host.saveReminderData(data);
    this.pushUndo(`新建「${title}」`, { [id]: null });
    window.dispatchEvent(new CustomEvent("reminderUpdated"));
    return rec;
  }

  // Edit a task's own fields. Moving it to another project moves its subtasks too; renaming refreshes the cached parent title on its children.
  async updateTask(id, f) {
    const host = this.getHost();
    const data = await host.loadReminderData(true);
    const t = data && data[id];
    if (!t) throw new Error("任务已不存在");
    const title = String(f.title || "").trim();
    if (!title) throw new Error("标题不能为空");
    const date = f.date || "", endDate = f.endDate || "";
    if ((date && !RE_DATE.test(date)) || (endDate && !RE_DATE.test(endDate))) throw new Error("日期格式无效");
    if (date && endDate && endDate < date) throw new Error("结束日期不能早于开始日期");
    const kids = this.descendantsOf(data, id);
    const parentId = f.parentId || "";
    if (parentId && (parentId === id || kids.some((k) => k.id === parentId))) throw new Error("不能把任务放到自己或自己的子任务下面");
    const parent = parentId ? data[parentId] : null;
    if (parentId && !parent) throw new Error("父任务已不存在");
    await this.backupOnce(data);
    const before = this.snap(data, [id, ...kids.map((k) => k.id)]);
    const set = (o, k, v) => { if (v === "" || v == null) delete o[k]; else o[k] = v; };
    t.title = title;
    set(t, "date", date); set(t, "endDate", endDate && (!date || endDate > date) ? endDate : "");
    set(t, "time", f.time || ""); set(t, "endTime", f.endTime || "");
    set(t, "note", f.note || "");
    if (f.priority && f.priority !== "none") t.priority = f.priority; else delete t.priority;
    if (f.kanbanStatus) t.kanbanStatus = f.kanbanStatus;
    set(t, "parentId", parentId); set(t, "parentTitle", parent ? parent.title : "");
    const pid = parent ? parent.projectId || "" : f.projectId || "";
    const moved = (t.projectId || "") !== pid;
    set(t, "projectId", pid);
    if (moved) for (const k of kids) set(k, "projectId", pid);
    for (const k of Object.values(data)) if (k && k.parentId === id) k.parentTitle = title;
    t.updatedAt = new Date().toISOString();
    await host.saveReminderData(data);
    this.pushUndo(`编辑「${title}」`, before);
    window.dispatchEvent(new CustomEvent("reminderUpdated"));
    return t;
  }

  // Delete a task and all its subtasks (own store only). Its progress records go with it and come back on undo.
  async deleteTask(id) {
    const host = this.getHost();
    const data = await host.loadReminderData(true);
    const t = data && data[id];
    if (!t) throw new Error("任务已不存在");
    await this.backupOnce(data);
    const ids = [id, ...this.descendantsOf(data, id).map((k) => k.id)];
    const before = this.snap(data, ids);
    if (!this.log) await this.loadLog();
    const logRestore = {};
    for (const i of ids) { delete data[i]; if (this.log[i]) { logRestore[i] = this.log[i]; delete this.log[i]; } }
    await host.saveReminderData(data);
    if (Object.keys(logRestore).length) await this.saveLog();
    if (this.hidden) { for (const i of ids) this.hidden.delete(i); await this.saveData(HIDDEN_FILE, { ids: [...this.hidden] }); }
    this.pushUndo(`删除「${t.title}」${ids.length > 1 ? `等 ${ids.length} 个任务` : ""}`, before, null, logRestore);
    window.dispatchEvent(new CustomEvent("reminderUpdated"));
    return ids.length;
  }

  /* ----- projects (own store only) ----- */
  async saveProject({ id, title, color, status, note, priority }) {
    title = String(title || "").trim();
    if (!title) throw new Error("项目名称不能为空");
    if (id) return this.updateProject(id, { title, ...(color ? { color } : {}) });
    const proj = await this.own.loadProjectData(true);
    const now = new Date().toISOString();
    do { id = `quick_${Date.now()}${Math.random().toString(36).slice(2, 5)}`; } while (proj[id]); // two projects created in the same millisecond must not collide
    const sort = Object.values(proj).reduce((m, x) => Math.max(m, x && typeof x === "object" ? Number(x.sort) || 0 : 0), 0) + 1;
    proj[id] = { id, blockId: null, title, note: note || "", status: PROJECT_STATUS.some(([k]) => k === status) ? status : "active", priority: PRIO_NAME[priority] ? priority : "none", categoryId: "", color: color || "#3b82f6", startDate: fromNum(todayNum()), endDate: null, archived: false, createdTime: now, updatedTime: now, sort };
    await this.own.saveProjectData(proj);
    window.dispatchEvent(new CustomEvent("reminderUpdated"));
    return id;
  }

  // Edit a project's own fields (not undoable). Empty strings clear optional fields.
  async updateProject(id, f) {
    const proj = await this.own.loadProjectData(true);
    const p = proj[id];
    if (!p || typeof p !== "object") throw new Error("项目已不存在");
    const has = (k) => Object.prototype.hasOwnProperty.call(f, k);
    if (has("title")) { const t = String(f.title || "").trim(); if (!t) throw new Error("项目名称不能为空"); p.title = t; }
    if (has("color") && /^#[0-9a-fA-F]{6}$/.test(f.color || "")) p.color = f.color;
    if (has("status")) { if (!PROJECT_STATUS.some(([k]) => k === f.status)) throw new Error("项目状态无效"); p.status = f.status; }
    if (has("priority")) { if (!PRIO_NAME[f.priority]) throw new Error("优先级无效"); p.priority = f.priority; }
    for (const k of ["startDate", "endDate"]) if (has(k)) { if (f[k] && !RE_DATE.test(f[k])) throw new Error("日期格式无效"); p[k] = f[k] || null; }
    if (p.startDate && p.endDate && p.endDate < p.startDate) throw new Error("结束日期不能早于开始日期");
    if (has("note")) p.note = String(f.note || "");
    if (has("blockId")) { p.blockId = f.blockId || null; if (f.blockId && has("blockTitle")) p.blockTitle = f.blockTitle; else if (!f.blockId) delete p.blockTitle; }
    if (has("archived")) p.archived = !!f.archived;
    p.updatedTime = new Date().toISOString();
    await this.own.saveProjectData(proj);
    window.dispatchEvent(new CustomEvent("reminderUpdated"));
    return p;
  }

  // Move tasks (and their subtasks) into a project; "" = unclassified. One undo step.
  async assignProject(taskIds, projectId) {
    const data = await this.own.loadReminderData(true), proj = await this.own.loadProjectData(true);
    if (projectId && !(proj[projectId] && typeof proj[projectId] === "object")) throw new Error("项目已不存在");
    const ids = new Set();
    for (const id of taskIds) if (data[id]) { ids.add(id); this.descendantsOf(data, id).forEach((k) => ids.add(k.id)); }
    if (!ids.size) return 0;
    await this.backupOnce(data);
    const before = this.snap(data, [...ids]);
    for (const id of ids) { if (projectId) data[id].projectId = projectId; else delete data[id].projectId; }
    await this.own.saveReminderData(data);
    this.pushUndo(`归类 ${ids.size} 个任务`, before);
    window.dispatchEvent(new CustomEvent("reminderUpdated"));
    return ids.size;
  }

  // Deleting a project keeps its tasks: they become "未分类".
  async deleteProject(id) {
    const proj = await this.own.loadProjectData(true);
    if (!proj[id]) throw new Error("项目已不存在");
    const data = await this.own.loadReminderData(true);
    await this.backupOnce(data);
    let n = 0;
    for (const t of Object.values(data)) if (t && t.projectId === id) { delete t.projectId; n++; }
    if (n) await this.own.saveReminderData(data);
    delete proj[id];
    await this.own.saveProjectData(proj);
    window.dispatchEvent(new CustomEvent("reminderUpdated"));
    return n;
  }

  descendantsOf(data, id) {
    const kids = new Map();
    for (const x of Object.values(data)) {
      if (x && typeof x === "object" && x.parentId) { if (!kids.has(x.parentId)) kids.set(x.parentId, []); kids.get(x.parentId).push(x); }
    }
    const out = [], seen = new Set([id]), stack = [id];
    while (stack.length) {
      for (const k of kids.get(stack.pop()) || []) if (!seen.has(k.id)) { seen.add(k.id); out.push(k); stack.push(k.id); }
    }
    return out;
  }

  async countPendingDescendants(id) {
    const host = this.getHost();
    const data = await host.loadReminderData(true);
    return this.descendantsOf(data, id).filter((x) => !x.completed && !(x.repeat && x.repeat.enabled)).length;
  }

  /* ----- progress log: {taskId: [{id, time:"YYYY-MM-DD HH:mm", text, progress?}]} in this plugin's own storage ----- */
  async loadLog() {
    let d = null;
    try { d = await this.loadData(LOG_FILE); } catch (e) { /* first run */ }
    this.log = d && typeof d === "object" && !Array.isArray(d) ? d : {};
    return this.log;
  }

  async saveLog() { await this.saveData(LOG_FILE, this.log || {}); }

  async loadHidden() {
    let d = null;
    try { d = await this.loadData(HIDDEN_FILE); } catch (e) { /* first run */ }
    this.hidden = new Set(d && Array.isArray(d.ids) ? d.ids.filter((x) => typeof x === "string") : []);
    return this.hidden;
  }

  async setHidden(id, on) {
    if (!this.hidden) await this.loadHidden();
    if (on) this.hidden.add(id); else this.hidden.delete(id);
    await this.saveData(HIDDEN_FILE, { ids: [...this.hidden] });
  }

  progressOf(taskId) { return (this.log && this.log[taskId]) || []; }

  // text is required; progress (0-100) only touches leaf, open, non-repeating tasks; toDoc appends a line to the bound document.
  // Returns {entry, docError}.
  async addProgress(taskId, { text, progress, time, toDoc }) {
    text = String(text || "").trim();
    if (!text) throw new Error("请填写成果内容");
    const host = this.getHost();
    const data = await host.loadReminderData(true);
    const t = data && data[taskId];
    if (!t) throw new Error("任务已不存在");
    if (!this.log) await this.loadLog();
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    const stamp = RE_TIME.test(time || "") ? time : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    const entry = { id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), time: stamp, text };
    const pct = progress == null || progress === "" ? null : Math.max(0, Math.min(100, Math.round(Number(progress))));
    const canPct = pct != null && Number.isFinite(pct) && !t.completed && !(t.repeat && t.repeat.enabled) && !t.isRepeatInstance && !this.descendantsOf(data, taskId).length;
    let before = {};
    if (canPct) {
      entry.progress = pct;
      if (Number(t.customProgress) !== pct) {
        await this.backupOnce(data);
        before = this.snap(data, [taskId]);
        t.customProgress = pct;
        await host.saveReminderData(data);
      }
    }
    (this.log[taskId] = this.log[taskId] || []).push(entry);
    this.log[taskId].sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0);
    await this.saveLog();
    this.pushUndo(`记录进度「${t.title}」`, before, { taskId, entryId: entry.id });
    let docError = null;
    if (toDoc) {
      const docId = t.docId || t.blockId;
      if (!docId) docError = "任务未绑定文档";
      else {
        try {
          const body = `- **${stamp}**${entry.progress != null ? `（进度 ${entry.progress}%）` : ""}　${text.replace(/\r?\n/g, "\n  ")}`;
          const r = await fetchSyncPost("/api/block/appendBlock", { dataType: "markdown", data: body, parentID: t.docId || t.blockId });
          if (!r || r.code !== 0) throw new Error((r && r.msg) || "appendBlock");
        } catch (e) { docError = String(e && e.message || e); }
      }
    }
    window.dispatchEvent(new CustomEvent("reminderUpdated")); // the project page shows these records too
    return { entry, docError };
  }

  async removeProgress(taskId, entryId) {
    if (!this.log) await this.loadLog();
    const list = this.log[taskId];
    if (!list) return false;
    const i = list.findIndex((e) => e.id === entryId);
    if (i < 0) return false;
    list.splice(i, 1);
    if (!list.length) delete this.log[taskId];
    await this.saveLog();
    return true;
  }

  async editProgress(taskId, entryId, text) {
    text = String(text || "").trim();
    if (!text) throw new Error("成果内容不能为空");
    if (!this.log) await this.loadLog();
    const e = (this.log[taskId] || []).find((x) => x.id === entryId);
    if (!e) throw new Error("记录已不存在");
    e.text = text;
    await this.saveLog();
  }

  // Mirrors the host's own toggle: completed + completedTime ("YYYY-MM-DD HH:mm"), completing a task completes its subtasks,
  // pending mobile notifications are cancelled. Block-attribute sync and recurring tasks are NOT handled here.
  async setCompleted(id, done) {
    const host = this.getHost();
    const data = await host.loadReminderData(true);
    const t = data && data[id];
    if (!t) throw new Error("任务已不存在");
    await this.backupOnce(data);
    const before = this.snap(data, [id, ...this.descendantsOf(data, id).map((x) => x.id)]);
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    const changed = [];
    const apply = (x) => {
      if (done) { if (!x.completed) { x.completed = true; x.completedTime = stamp; changed.push(x.id); } }
      else { x.completed = false; delete x.completedTime; changed.push(x.id); }
    };
    apply(t);
    if (done) for (const x of this.descendantsOf(data, id)) if (!(x.repeat && x.repeat.enabled)) apply(x);
    await host.saveReminderData(data);
    this.pushUndo(`${done ? "完成" : "取消完成"}「${t.title}」`, before);
    window.dispatchEvent(new CustomEvent("reminderUpdated"));
    return changed.length;
  }

  async commitDates(id, startNum, endNum) {
    const host = this.getHost();
    const data = await host.loadReminderData(true);
    const t = data && data[id];
    if (!t) throw new Error("任务已不存在");
    await this.backupOnce(data);
    const before = this.snap(data, [id]);
    t.date = fromNum(startNum);
    if (endNum > startNum) t.endDate = fromNum(endNum); else delete t.endDate;
    await host.saveReminderData(data);
    this.pushUndo(`改期「${t.title}」`, before);
    window.dispatchEvent(new CustomEvent("reminderUpdated"));
  }
};
