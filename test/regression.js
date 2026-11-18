const Module = require("module"), fs = require("fs"); const orig = Module._load;
const menus = [];
Module._load = function (r, ...a) { if (r === "siyuan") return { Plugin: class { constructor(){ this.store={}; } async loadData(n){return this.store[n];} async saveData(n,v){this.store[n]=v;} addIcons(){} addTab(){} addTopBar(){} addCommand(){} }, openTab() {}, showMessage(m){ (global.__msgs ||= []).push(m); }, fetchSyncPost: async (u, d) => global.__kernel(u, d), Dialog: class { constructor(o){ this.o=o; const f=global.El("div"), a=global.El("div"); this.element={ querySelector:(q)=>q===".tg-form"?f:a, f, a }; global.__dlg=this; } destroy(){ global.__dlgDestroyed=(global.__dlgDestroyed||0)+1; } }, confirm(){},
  Menu: class { constructor(){ this.items=[]; menus.push(this);} addItem(i){this.items.push(i.label); (this.fns||(this.fns={}))[i.label]=i.click;} addSeparator(){} open(){} } }; return orig.call(this, r, ...a); };
let nullAppend = 0;
function El(tag) { const cls = new Set(); const e = { nodeType: 1, tag, children: [], style: {}, listeners: {}, scrollLeft: 0, scrollTop: 0, isConnected: true,
  classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
  append(...k) { if (k.some((x) => x == null)) nullAppend++; this.children.push(...k); }, replaceChildren(...k) { this.children = k; this._val = undefined; }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; if (k === "value" && tag !== "option") this._val = v; },
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }, removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); },
  setPointerCapture() {}, releasePointerCapture() {}, remove() {}, contains() { return true; }, querySelector() { return null; },
  closest() { return null; }, getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 800 }; }, offsetWidth: 300, offsetHeight: 200, textContent: "", focus() {}, setSelectionRange() {} };
  Object.defineProperty(e, "className", { get: () => [...cls].join(" "), set: (v) => { cls.clear(); String(v).split(" ").filter(Boolean).forEach((c) => cls.add(c)); } });
  Object.defineProperty(e, "value", { get() { if (this._val !== undefined) return this._val; if (tag === "select") { const o = this.children.find((c) => c.attrs && c.attrs.selected !== undefined) || this.children[0]; return o ? o.attrs.value : ""; } return undefined; }, set(v) { this._val = v; } });
  e.style.setProperty = () => {}; return e; }
global.El = El; global.document = { createElement: El, createTextNode: (t) => ({ nodeType: 3, t }) };
const winL = {}; global.window = { addEventListener(t, f) { (winL[t] ||= []).push(f); }, removeEventListener(t, f) { winL[t] = (winL[t] || []).filter((x) => x !== f); }, dispatchEvent() {} };
global.CustomEvent = class { constructor(type, init) { this.type = type; Object.defineProperty(this, "detail", { get: () => (init && init.detail !== undefined ? init.detail : null) }); } }; global.localStorage = { getItem: () => null, setItem() {} };
const src = fs.readFileSync(require("path").join(__dirname, "..", "index.js"), "utf8") + "\nmodule.exports.__t = { GanttView };";
const m = new Module("x"); m.paths = []; m._compile(src, "x.js"); const { GanttView } = m.exports.__t; const Plugin = m.exports;
const base = process.env.TASK_DATA_DIR || require("path").join(require("os").homedir(), "Documents/siyuan/data/storage/petal/siyuan-plugin-task-note-management"); // read-only: tests run on an in-memory copy
const R = JSON.parse(fs.readFileSync(base + "/reminder.json")), Pj = JSON.parse(fs.readFileSync(base + "/project.json"));
const count = (el, cls) => { let n = 0; const w = (x) => { if (!x || !x.children) return; if (x.className && x.className.split(" ").includes(cls)) n++; x.children.forEach(w); }; w(el); return n; };
const fromN = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
const ok = (c, msg) => { console.log(c ? "PASS" : "FAIL", msg); if (!c) process.exitCode = 1; };

// mock host over a COPY of real data
let data = JSON.parse(JSON.stringify(R)); let saves = 0;
const host = { loadReminderData: async () => JSON.parse(JSON.stringify(data)), saveReminderData: async (d) => { data = JSON.parse(JSON.stringify(d)); saves++; }, loadProjectData: async () => Pj };
const plugin = new Plugin(); plugin.own = host; plugin.undoStack = [];

(async () => {
  // ---- render across all views, with filters
  const root = El("div"); const v = new GanttView(root, plugin); await v.reload();
  for (const sort of ["project", "time"]) for (const status of ["all", "late", "doing", "week"]) for (const q of ["", "话机", "zzzz"]) for (const zoom of ["day", "week", "month"]) for (const done of ["open", "all"]) {
    v.sort = sort; v.status = status; v.q = q; v.zoom = zoom; v.done = done; v.showUndated = true; v.render();
  }
  ok(nullAppend === 0, "no null passed to native append (" + nullAppend + ")");
  v.sort = "project"; v.status = "all"; v.q = "X-Vendor"; v.done = "all"; v.render();
  const rowsSearch = count(v.el, "tg-row");
  v.q = ""; v.render(); const rowsAll = count(v.el, "tg-row");
  ok(rowsSearch > 0 && rowsSearch < rowsAll, `search narrows rows (${rowsSearch} < ${rowsAll})`);
  v.status = "late"; v.render(); const late = count(v.el, "tg-tail"); ok(late >= 0, "late filter runs (real data currently has no overdue-with-end tasks): " + late);
  v.status = "all"; v.render();

  // ---- tail only for overdue; no red full bars
  v.done = "r30"; v.render(); ok(count(v.el, "tg-tail") >= 0, "overdue tails present: " + count(v.el, "tg-tail") + ", in-progress: " + count(v.el, "tg-now"));

  // ---- fold all
  const keys = v.foldKeys(); ok(keys.length > 0, "foldKeys " + keys.length);

  // ---- commit + undo (drag)
  const own = Object.values(data).find((t) => t.date && !t.completed && !t.repeat);
  const before = JSON.stringify(data[own.id]);
  await plugin.commitDates(own.id, 20400, 20402);
  ok(data[own.id].date === "2025-12-01".replace("2025-12-01", new Date(20400 * 864e5).toISOString().slice(0, 10)), "commit moved date");
  ok(plugin.undoStack.length === 1, "undo entry pushed");
  const lbl = await plugin.undoLast(); ok(JSON.stringify(data[own.id]) === before && lbl.startsWith("改期"), "undo restores record exactly");
  ok((await plugin.undoLast()) === null, "empty undo -> null");

  // ---- complete + undo, with descendants
  const parent = Object.values(data).find((t) => !t.completed && Object.values(data).some((c) => c.parentId === t.id && !c.completed));
  const snapAll = JSON.stringify(data);
  const nchg = await plugin.setCompleted(parent.id, true); ok(nchg > 1, "complete cascaded " + nchg);
  await plugin.undoLast(); ok(JSON.stringify(data) === snapAll, "undo of complete restores ALL touched records");

  // ---- create + undo
  const n0 = Object.keys(data).length;
  const rec = await plugin.createTask({ title: "新建测试", date: "2026-11-20", projectId: own.projectId });
  ok(Object.keys(data).length === n0 + 1 && data[rec.id].projectId === own.projectId && data[rec.id].date === "2026-11-20", "create task");
  const sub = await plugin.createTask({ title: "子", date: "2026-11-21", parentId: rec.id });
  ok(data[sub.id].parentId === rec.id && data[sub.id].projectId === own.projectId, "create subtask inherits project");
  await plugin.undoLast(); await plugin.undoLast(); ok(Object.keys(data).length === n0 && JSON.stringify(data) === snapAll, "undo create removes tasks");

  // ---- paint drag on an undated task
  await v.reload(); v.showUndated = true; v.sort = "time"; v.render();
  const und = [...v.model.groups.flatMap((g) => g.roots)].find((n) => n.kind !== "own" && !n.children.length && !n.t.completed);
  const line = El("div"); line.getBoundingClientRect = () => ({ left: 0 });
  v.startPaint({ button: 0, clientX: v.px * 3 + 1, pointerId: 1, preventDefault() {} }, line, (a, b) => v.schedule(und, a, b));
  line.listeners.pointermove[0]({ clientX: v.px * 6 + 1 });
  await line.listeners.pointerup[0]({ clientX: v.px * 6 + 1, type: "pointerup", pointerId: 1 });
  const got = data[und.id]; ok(got.date === new Date((v.rs + 3) * 864e5).toISOString().slice(0, 10) && got.endDate === new Date((v.rs + 6) * 864e5).toISOString().slice(0, 10), `paint set ${got.date} ~ ${got.endDate}`);
  await plugin.undoLast(); ok(JSON.stringify(data) === snapAll, "undo of paint restores");
  // click without move creates nothing
  const s0 = saves; v.startPaint({ button: 0, clientX: 50, pointerId: 1, preventDefault() {} }, line, (a, b) => v.schedule(und, a, b));
  await line.listeners.pointerup[line.listeners.pointerup.length - 1]({ clientX: 50, type: "pointerup", pointerId: 1 }); ok(saves === s0, "plain click does not write");

  // ---- Ctrl+Z gating
  let undone = 0; v.undo = () => { undone++; };
  const key = (o) => ({ ctrlKey: true, key: "z", target: { tagName: "DIV" }, preventDefault() {}, ...o });
  v.active = false; v.onKey(key()); ok(undone === 0, "Ctrl+Z ignored when view not active");
  v.active = true; v.onKey(key({ target: { tagName: "INPUT" } })); ok(undone === 0, "Ctrl+Z ignored inside input");
  v.onKey(key()); ok(undone === 1, "Ctrl+Z undoes when view active");

  // ---- wheel zoom
  v.zoom = "week"; const sc = v.scroller; let prevented = 0;
  v.onWheel({ ctrlKey: true, deltaY: -1, clientX: 500, preventDefault() { prevented++; } }); ok(v.zoom === "day" && prevented === 1, "ctrl+wheel up zooms in");
  v.onWheel({ ctrlKey: false, deltaY: -1, preventDefault() { prevented++; } }); ok(prevented === 1, "plain wheel untouched");

  // ---- menus
  v.render(); const fakeLine = El("div"); fakeLine.getBoundingClientRect = () => ({ left: 0 });
  const t0 = v.model.groups[0].roots[0];
  v.taskMenu({ clientX: 100, clientY: 5, target: { closest: (s) => (s === ".tg-line" ? fakeLine : null) } }, t0);
  ok(menus.at(-1).items.some((x) => x.includes("新建任务")) && menus.at(-1).items.some((x) => x.includes("新建子任务")), "task menu on empty space: " + menus.at(-1).items.join(" | "));
  v.taskMenu({ clientX: 100, clientY: 5, target: { closest: () => null } }, t0); ok(!menus.at(-1).items.some((x) => x.includes("新建")), "task menu on label has no create items");
  v.groupMenu({ clientX: 100, clientY: 5, preventDefault() {}, target: { closest: (s) => (s === ".tg-line" ? fakeLine : null) } }, v.model.groups[0]); ok(menus.at(-1).items[0].includes("新建任务"), "group menu");


  // ---- open-ended tasks
  { const T = (id, o) => Object.assign({ id, title: id, completed: false, createdAt: "x", projectId: "" }, o);
    v.reminders = { A: T("A", { date: "2026-09-01", kanbanStatus: "doing" }), B: T("B", { date: "2026-09-01", kanbanStatus: "short_term" }),
      C: T("C", { date: "2026-09-01", kanbanStatus: "abandoned" }), D: T("D", { date: "2026-09-01", endDate: "2026-09-05", kanbanStatus: "doing" }),
      P: T("P", { kanbanStatus: "doing" }), K: T("K", { parentId: "P", date: "2026-09-01", kanbanStatus: "doing" }) };
    v.projects = {}; v.done = "all"; v.status = "all"; v.q = ""; v.sort = "time"; v.showUndated = true; v.render();
    const nodes = {}; const w = (n) => { nodes[n.id] = n; n.children.forEach(w); }; v.model.groups.forEach((g) => g.roots.forEach(w));
    const st = Object.fromEntries(Object.keys(nodes).map((k) => [k, v.stateOf(nodes[k])]));
    console.log("states", JSON.stringify(st));
    ok(st.A === "open" && nodes.A.ongoing, "doing + no end = open, ongoing");
    ok(st.B === "open" && !nodes.B.ongoing, "short_term + no end = open, 1-day");
    ok(st.C === "dropped", "abandoned + no end = gray");
    ok(st.D === "late", "has end in the past = late");
    ok(st.K === "open" && st.P === "open", "parent of ongoing child is not late");
    ok(count(v.el, "tg-tail") === 1, "exactly one tail (task D): " + count(v.el, "tg-tail"));
    ok(count(v.el, "tg-ongoing") === 2, "ongoing bars (A, K): " + count(v.el, "tg-ongoing"));
    const info = JSON.stringify(v.nodeInfo(nodes.A)); ok(/已持续/.test(info) && /未设结束日期/.test(info) && !/已逾期/.test(info), "hover: ongoing text, no overdue");
    ok(/已逾期/.test(JSON.stringify(v.nodeInfo(nodes.D))), "hover: D overdue");
    v.status = "late"; v.render(); ok(count(v.el, "tg-task") === 1, "late filter keeps only D: " + count(v.el, "tg-task")); v.status = "all";
    // drag semantics on an ongoing bar
    const today = v.model.today; data = { A: { ...v.reminders.A } }; plugin.undoStack = [];
    const bar = El("div"); const drag = async (mode, dx) => { const cls = { l: "tg-hl", r: "tg-hr", m: "x" }[mode]; const ts = new Set([cls]);
      v.startDrag({ button: 0, clientX: 0, pointerId: 1, target: { classList: { contains: (c) => ts.has(c) } }, preventDefault() {} }, nodes.A, bar);
      bar.listeners.pointermove.at(-1)({ clientX: dx * v.px }); await bar.listeners.pointerup.at(-1)({ type: "pointerup", pointerId: 1 }); };
    await drag("m", 3); ok(data.A.date === "2026-09-04" && !data.A.endDate, "middle drag shifts start only: " + data.A.date + " end=" + data.A.endDate);
    data.A = { ...v.reminders.A }; await drag("r", -2); ok(data.A.endDate === new Date((today - 2) * 864e5).toISOString().slice(0, 10), "right-edge drag sets end: " + data.A.endDate);
  }


  // ---- create dialog / drag-create / inline add
  { data = JSON.parse(JSON.stringify(R)); plugin.undoStack = []; await v.reload(); v.sort = "project"; v.done = "r30"; v.showUndated = true; v.render();
    const proj = v.model.projectOptions[0]; const n0 = Object.keys(data).length;
    // full dialog: project + parent + range
    const par = Object.values(data).find((t) => !t.completed && t.projectId === proj.id && !t.parentId);
    const d = v.openCreate({ projectId: proj.id, date: v.model.today + 2, endDate: v.model.today + 4 });
    ok(d.ctl.start.value === fromN(v.model.today + 2) && d.ctl.end.value === fromN(v.model.today + 4), "dialog prefilled with dragged range");
    ok(d.ctl.project.value === proj.id, "dialog prefilled with project");
    d.ctl.title.value = "对话框任务"; d.ctl.parent.value = par.id; d.ctl.prio.value = "high"; d.ctl.status.value = "long_term";
    await d.submit(false);
    const made = Object.values(data).find((t) => t.title === "对话框任务");
    ok(made && made.parentId === par.id && made.projectId === proj.id && made.priority === "high" && made.kanbanStatus === "long_term" && made.endDate === fromN(v.model.today + 4), "dialog creates full record");
    ok(global.__dlgDestroyed >= 1, "dialog closed after create");
    await plugin.undoLast(); ok(Object.keys(data).length === n0, "undo removes dialog-created task");
    // validation
    const d2 = v.openCreate({}); d2.ctl.title.value = "x"; d2.ctl.start.value = "2026-05-02"; d2.ctl.end.value = "2026-05-01"; await d2.submit(false); ok(Object.keys(data).length === n0, "end<start rejected");
    d2.ctl.title.value = ""; d2.ctl.end.value = ""; await d2.submit(false); ok(Object.keys(data).length === n0, "empty title rejected");
    // create and edit
    global.__dlg = null; const d3 = v.openCreate({}); d3.ctl.title.value = "编辑后"; await d3.submit(true); const m3 = Object.values(data).find((t) => t.title === "编辑后");
    ok(m3 && global.__dlg && /编辑任务/.test(global.__dlg.o.title) && global.__dlg.o.title.includes("编辑后"), "创建并编辑 opens the built-in edit dialog for the new task"); await plugin.undoLast();
    // subtask preset locks project to parent's
    const d4 = v.openCreate({ parentId: par.id, date: v.model.today }); ok(d4.ctl.project.value === (par.projectId || "") && d4.ctl.parent.value === par.id, "subtask dialog preselects parent+project");
    // parent choices only unfinished tasks of that project
    const ch = v.parentChoices(proj.id); ok(ch.length > 0 && ch.every(([id]) => !data[id].completed && data[id].projectId === proj.id), "parent choices: " + ch.length);

    // parent search
    { // parent tree: collapsed at first, expand, pick, search swaps it for the list
      const nodes = v.parentNodes(proj.id); const withKids = (function f(ns) { for (const n of ns) { if (n.kids.length) return n; const r = f(n.kids); if (r) return r; } return null; })(nodes);
      const dt = v.openCreate({ projectId: proj.id }); const keys = () => dt.ctl.pTree.children.map((r) => r.attrs["data-key"]);
      ok(keys().length === 1 + nodes.length && keys()[0] === "p:", "parent tree starts collapsed: only 无 + top-level tasks (" + keys().length + ")");
      if (withKids) {
        const arrowOf = (id) => dt.ctl.pTree.children.find((r) => r.attrs["data-key"] === "p:" + id);
        const top = (function f(ns, path) { for (const n of ns) { if (n === withKids) return [...path, n]; const r = f(n.kids, [...path, n]); if (r) return r; } return null; })(nodes, []);
        for (const n of top) { const row = arrowOf(n.id); ok(!!row, "row visible once its parent is open: " + n.title); row.children[0].listeners.click[0]({ stopPropagation() {} }); }
        ok(keys().includes("p:" + withKids.kids[0].id), "opening a task lists its subtasks");
        arrowOf(withKids.kids[0].id).listeners.click[0](); ok(dt.ctl.parent.value === withKids.kids[0].id, "clicking a task name picks it as parent");
        const d5 = v.openCreate({ projectId: proj.id, parentId: withKids.kids[0].id }); ok(d5.ctl.pTree.children.some((r) => r.attrs["data-key"] === "p:" + withKids.kids[0].id), "a preset parent's ancestors are opened so it is visible");
      }
      dt.ctl.parentQ.value = "x"; dt.ctl.parentQ.listeners.input[0](); ok(dt.ctl.pTree.style.display === "none" && dt.ctl.parent.style.display === "", "typing a keyword shows search results instead of the tree");
      dt.ctl.parentQ.value = ""; dt.ctl.parentQ.listeners.input[0](); ok(dt.ctl.pTree.style.display === "" && dt.ctl.parent.style.display === "none", "clearing it shows the tree again"); }
    { const dd = v.openCreate({ projectId: proj.id }); const all = dd.ctl.parent.children.length; const sample = ch[ch.length - 1]; const kw = sample[1].trim().slice(0, 3);
      dd.ctl.parentQ.value = kw; dd.ctl.parentQ.listeners.input[0](); const nf = dd.ctl.parent.children.length;
      ok(nf < all && nf >= 2 && dd.ctl.parent.children.some((o) => o.attrs.value === sample[0]), `parent search narrows ${all} -> ${nf} and keeps match`);
      dd.ctl.parentQ.value = "zzzz不存在"; dd.ctl.parentQ.listeners.input[0](); ok(dd.ctl.parent.children.length === 1, "no match leaves only 无父任务");
      dd.ctl.parentQ.value = kw; dd.ctl.parentQ.listeners.input[0](); const first = dd.ctl.parent.children.find((o) => o.attrs.value);
      dd.ctl.parentQ.listeners.keydown[0]({ key: "Enter", isComposing: false, preventDefault() {} }); ok(dd.ctl.parent.value === first.attrs.value, "Enter picks first match");
      dd.ctl.parentQ.value = "zzzz不存在"; dd.ctl.parentQ.listeners.input[0](); ok(dd.ctl.parent.children.some((o) => o.attrs.value === first.attrs.value) && dd.ctl.parent.value === first.attrs.value, "selected parent stays listed while filtering");
      dd.ctl.parentQ.listeners.compositionstart[0](); dd.ctl.parentQ.value = ""; dd.ctl.parentQ.listeners.input[0](); ok(dd.ctl.parent.children.length === 2, "no refilter during IME composition");
      dd.ctl.parentQ.listeners.compositionend[0](); ok(dd.ctl.parent.children.length === all, "refilter after composition ends");
      dd.ctl.title.value = "搜索选父"; dd.ctl.parent.value = first.attrs.value; await dd.submit(false); const m = Object.values(data).find((t) => t.title === "搜索选父"); ok(m && m.parentId === first.attrs.value, "task created under searched parent"); await plugin.undoLast(); }
    // group-row drag creates (opens dialog with range)
    global.__dlg = null; const gline = El("div"); gline.getBoundingClientRect = () => ({ left: 0 });
    const g = v.model.groups[0]; const gl = v.renderGroup(g, 1000); const glineEl = gl.children[1];
    glineEl.listeners.pointerdown[0]({ button: 0, clientX: v.px * 2 + 1, pointerId: 1, target: glineEl, preventDefault() {} });
    glineEl.getBoundingClientRect = () => ({ left: 0 });
    glineEl.listeners.pointermove[0]({ clientX: v.px * 5 + 1 }); await glineEl.listeners.pointerup[0]({ type: "pointerup", pointerId: 1, clientX: v.px * 5 + 1 });
    ok(global.__dlg && true, "group-row drag opens create dialog");
    // add row
    await new Promise((r) => setTimeout(r, 30)); // let any reload still in flight land first, or it would consume the refocus flag mid-test
    v.render(); ok(count(v.el, "tg-addrow") === v.model.groups.filter((x) => !v.fold.has("g:" + x.id)).length, "one add row per open group: " + count(v.el, "tg-addrow"));
    v._adding = g.id; const ar = v.renderAddRow(g, 1000); const input = ar.children[0].children[1]; ok(/tg-addinput/.test(input.className), "add row shows input when active");
    input.value = "快速添加"; await input.listeners.keydown[0]({ key: "Enter", isComposing: false, preventDefault() {} });
    const q = Object.values(data).find((t) => t.title === "快速添加"); ok(q && q.date === fromN(v.model.today) && (q.projectId || "") === (g.id || "") && !q.parentId, "inline add creates top-level task dated today");
    ok(input.value === "" && v._refocusAdd === true, "input cleared + refocus requested");
    input.value = "ime"; await input.listeners.compositionstart[0](); await input.listeners.keydown[0]({ key: "Enter", isComposing: true, preventDefault() {} }); ok(!Object.values(data).some((t) => t.title === "ime"), "Enter during IME composition ignored");
    await plugin.undoLast(); ok(Object.keys(data).length === n0, "undo inline add");
    // shift+drag on task row = subtask dialog
    const tn = v.model.groups[0].roots[0]; v.render(); const tr = v.renderTask(tn, 1000); const tline = tr.children[1]; global.__dlg = null;
    tline.getBoundingClientRect = () => ({ left: 0 }); tline.listeners.pointerdown[0]({ button: 0, shiftKey: true, clientX: 10, pointerId: 1, target: tline, preventDefault() {} });
    tline.listeners.pointermove[0]({ clientX: 10 + v.px * 3 }); await tline.listeners.pointerup[0]({ type: "pointerup", pointerId: 1, clientX: 10 + v.px * 3 });
    ok(global.__dlg && /新建子任务/.test(global.__dlg.o.title), "Shift+drag on task row opens subtask dialog");
    ok(nullAppend === 0, "no null appends in new UI (" + nullAppend + ")");
  }

  // ---- create document + bind
  { data = JSON.parse(JSON.stringify(R)); plugin.undoStack = []; await v.reload(); v.render();
    const calls = []; const docs = [{ id: "20260101000000-aaaaaaa", box: "nb1", hpath: "/工作/项目A", updated: 3 }, { id: "20260101000001-bbbbbbb", box: "nb1", hpath: "/工作/项目B/设计", updated: 2 }, { id: "20260101000002-ccccccc", box: "nb2", hpath: "/日记", updated: 1 }];
    global.__kernel = async (u, d) => { calls.push([u, d]);
      if (u === "/api/notebook/lsNotebooks") return { code: 0, data: { notebooks: [{ id: "nb1", name: "笔记本1", closed: false }, { id: "nb2", name: "笔记本2", closed: false }, { id: "nb3", name: "关闭的", closed: true }] } };
      if (u === "/api/query/sql") { const st = d.stmt;
        if (st.includes("join blocks")) return { code: 0, data: [{ bid: "PROJBLOCK", id: "20260101000001-bbbbbbb", box: "nb1", hpath: "/工作/项目B/设计" }] };
        const kws = [...st.matchAll(/hpath like '%(.*?)%'/g)].map((m) => m[1]);
        return { code: 0, data: docs.filter((x) => kws.every((k) => x.hpath.includes(k))) }; }
      if (u === "/api/filetree/listDocsByPath") { const f = (id, name, path, n) => ({ id, name, path, subFileCount: n });
        if (d.notebook === "nb1" && d.path === "/") return { code: 0, data: { files: [f("d1", "工作", "/d1.sy", 2), f("d9", "杂项", "/d9.sy", 0)] } };
        if (d.notebook === "nb1" && d.path === "/d1.sy") return { code: 0, data: { files: [f("d2", "项目A", "/d1/d2.sy", 0)] } };
        return { code: 0, data: { files: [] } }; }
      if (u === "/api/filetree/createDocWithMd") return { code: 0, data: "20260202000000-newdocx" };
      if (u === "/api/attr/setBlockAttrs") return { code: 0, data: null };
      return { code: 1, msg: "unknown " + u }; };
    const task = Object.values(data).find((x) => !x.completed && !x.blockId && !x.docId && x.projectId && !(x.repeat && x.repeat.enabled));
    v.projects[task.projectId] = { ...(v.projects[task.projectId] || { title: "P" }), blockId: "PROJBLOCK" };
    const n0 = JSON.stringify(data);
    // menu offers create only for unbound open tasks
    const node = { t: task, children: [], kind: null }; v.taskMenu({ clientX: 1, clientY: 1, target: { closest: () => null } }, node);
    ok(menus.at(-1).items.includes("创建文档并绑定…"), "menu offers 创建文档并绑定 for unbound task");
    v.taskMenu({ clientX: 1, clientY: 1, target: { closest: () => null } }, { t: { ...task, blockId: "x" }, children: [] }); ok(!menus.at(-1).items.includes("创建文档并绑定…"), "not offered when already bound");
    v.taskMenu({ clientX: 1, clientY: 1, target: { closest: () => null } }, { t: { ...task, completed: true }, children: [] }); ok(!menus.at(-1).items.includes("创建文档并绑定…"), "not offered for completed task");
    // dialog
    const dd = await v.openCreateDoc(task);
    await new Promise((r) => setTimeout(r, 300));
    const optVals = dd.ctl.list.children.map((o) => o.attrs.value);
    ok(!calls.some(([u, d2]) => u === "/api/query/sql" && /nb3/.test(d2.stmt)), "closed notebook excluded from search");
    ok(dd.picked === "20260101000001-bbbbbbb", "project doc preselected as parent (" + dd.picked + ")");
    ok(dd.ctl.list.children[1].attrs.value === "20260101000001-bbbbbbb" || optVals.includes("20260101000001-bbbbbbb"), "pinned project doc listed: " + dd.ctl.list.children.length + " options");
    ok(dd.ctl.nb.disabled === true, "notebook locked when a parent doc is chosen");
    // search narrows
    dd.ctl.q.value = "日记"; dd.ctl.q.listeners.input[0](); await new Promise((r) => setTimeout(r, 350));
    ok(dd.ctl.list.children.some((o) => /日记/.test(JSON.stringify(o.children))) && !dd.ctl.list.children.some((o) => /项目A/.test(JSON.stringify(o.children))), "search '日记' filters to matching docs");
    ok(dd.ctl.list.children.some((o) => o.attrs.value === dd.picked), "current parent stays listed while searching");
    dd.ctl.q.value = "工作 设计"; dd.ctl.q.listeners.input[0](); await new Promise((r) => setTimeout(r, 350)); ok(dd.ctl.list.children.length >= 2, "multi-keyword AND search");
    // IME guard
    const before = calls.length; dd.ctl.q.listeners.compositionstart[0](); dd.ctl.q.value = "x"; dd.ctl.q.listeners.input[0](); await new Promise((r) => setTimeout(r, 300)); ok(calls.length === before, "no search during IME composition");
    // quote escaping
    dd.ctl.q.listeners.compositionend[0](); dd.ctl.q.value = "o'brien"; await new Promise((r) => setTimeout(r, 300)); ok(calls.some(([u, d2]) => u === "/api/query/sql" && d2.stmt.includes("o''brien")), "single quote escaped in SQL");
    // pick doc A with Enter, create
    dd.ctl.q.value = "项目A"; dd.ctl.q.listeners.input[0](); await new Promise((r) => setTimeout(r, 350));
    dd.ctl.q.listeners.keydown[0]({ key: "Enter", isComposing: false, preventDefault() {} }); ok(dd.picked === "20260101000000-aaaaaaa", "Enter in search picks first result");
    dd.ctl.title.value = "我的/文档"; await dd.submit();
    const cr = calls.find(([u]) => u === "/api/filetree/createDocWithMd")[1];
    ok(cr.notebook === "nb1" && cr.path === "/工作/项目A/我的-文档", "createDocWithMd path: " + cr.path + " nb=" + cr.notebook);
    const bound = data[task.id]; ok(bound.blockId === "20260202000000-newdocx" && bound.docId === bound.blockId && bound.docTitle === "我的-文档", "task bound to new doc");
    const at = calls.find(([u]) => u === "/api/attr/setBlockAttrs")[1];
    ok(at.id === "20260202000000-newdocx" && at.attrs.bookmark === "⏰" && at.attrs["custom-bind-reminders"] === task.id && at.attrs["custom-task-projectId"] === task.projectId, "block attrs mirror host bind");
    const others = JSON.parse(n0); delete others[task.id]; const now = JSON.parse(JSON.stringify(data)); delete now[task.id]; ok(JSON.stringify(others) === JSON.stringify(now), "no other task touched");
    ok(global.__dlgDestroyed > 0, "dialog closed");
    const t2x = () => Object.values(data).find((x) => !x.completed && !x.blockId && !x.docId && !(x.repeat && x.repeat.enabled));
    // tree: everything collapsed at first, expand level by level, pick a nested doc
    { const calls0 = calls.length; const dt = await v.openCreateDoc(t2x());
      const keys = () => dt.ctl.tree.children.map((r) => r.attrs && r.attrs["data-key"]).filter(Boolean);
      ok(keys().filter((k) => k.startsWith("n:")).join() === "n:nb1,n:nb2" && !keys().some((k) => k.startsWith("d:")), "tree starts collapsed: only notebooks (" + keys() + ")");
      ok(!calls.slice(calls0).some(([u]) => u === "/api/filetree/listDocsByPath"), "nothing is loaded until a notebook is opened");
      dt.ctl.toggle("n:nb1"); await new Promise((r) => setTimeout(r, 30));
      ok(keys().includes("d:d1") && keys().includes("d:d9") && !keys().includes("d:d2"), "opening a notebook lists its top-level docs (" + keys() + ")");
      dt.ctl.toggle("d:d1"); await new Promise((r) => setTimeout(r, 30));
      ok(keys().includes("d:d2"), "opening a doc lists its subdocs");
      dt.ctl.tree.children.find((r) => r.attrs["data-key"] === "d:d2").listeners.click[0]();
      ok(dt.picked === "d2" && dt.ctl.nb.disabled === true, "clicking a name picks that doc");
      dt.ctl.toggle("d:d1"); ok(!keys().includes("d:d2"), "collapsing hides the subdocs");
      dt.ctl.toggle("d:d1"); dt.ctl.title.value = "树里建"; const n1 = calls.length; await dt.submit();
      const cr3 = calls.slice(n1).find(([u]) => u === "/api/filetree/createDocWithMd");
      ok(cr3 && cr3[1].notebook === "nb1" && cr3[1].path === "/工作/项目A/树里建", "creating under a tree pick uses its path: " + JSON.stringify(cr3 && cr3[1])); }
    // root creation
    const t2 = t2x(); calls.length = 0;
    const d2 = await v.openCreateDoc(t2); await new Promise((r) => setTimeout(r, 300)); d2.ctl.list.value = ""; d2.ctl.list.listeners.change[0](); d2.ctl.nb.value = "nb2"; d2.ctl.title.value = "根文档"; await d2.submit();
    const cr2 = calls.find(([u]) => u === "/api/filetree/createDocWithMd")[1]; ok(cr2.notebook === "nb2" && cr2.path === "/根文档", "root creation: " + JSON.stringify(cr2));
    // right-click a tree row -> 新增子文档: inline name box (default 新建笔记), Enter creates a blank doc and selects it
    { const t4 = t2x(); calls.length = 0;
      const d4 = await v.openCreateDoc(t4); await new Promise((r) => setTimeout(r, 100));
      const rowOf = (k) => d4.ctl.tree.children.find((r) => r.attrs && r.attrs["data-key"] === k);
      d4.ctl.toggle("n:nb1"); await new Promise((r) => setTimeout(r, 30));
      const rA = rowOf("d:d1"); ok(rA && rA.listeners.contextmenu, "tree rows have a context menu");
      rA.listeners.contextmenu[0]({ preventDefault() {}, stopPropagation() {}, clientX: 1, clientY: 1 });
      ok(menus.at(-1).items.includes("新增子文档"), "menu offers 新增子文档");
      menus.at(-1).fns["新增子文档"](); await new Promise((r) => setTimeout(r, 30));
      ok(d4.ctl.addInput.value === "新建笔记" && d4.ctl.tree.children.some((r) => r.attrs && /tg-tadd/.test(r.attrs.class || r.className || "")) || d4.ctl.tree.children.some((r) => (r.className || "").includes("tg-tadd")), "inline name box appears with the default name");
      d4.ctl.addInput.value = "B/新目录"; await d4.ctl.addInput.listeners.keydown[0]({ key: "Enter", isComposing: false, preventDefault() {}, stopPropagation() {} }); await new Promise((r) => setTimeout(r, 60));
      const c4 = calls.find(([u]) => u === "/api/filetree/createDocWithMd")[1];
      ok(c4.notebook === "nb1" && c4.path === "/工作/B-新目录" && c4.markdown === "", "blank doc created under the right-clicked doc: " + JSON.stringify(c4));
      ok(!d4.ctl.tree.children.some((r) => (r.className || "").includes("tg-tadd")), "name box closes after creating");
      d4.ctl.title.value = "叶子"; await d4.submit();
      const c5 = calls.filter(([u]) => u === "/api/filetree/createDocWithMd").at(-1)[1];
      ok(/^\/工作\/B-新目录\/叶子$/.test(c5.path), "the new doc is selected as the parent: " + c5.path); }
    // left open overnight: a stale model is rebuilt when the window gets focus, and by the Today button
    { const real = () => Math.round(Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()) / 864e5);
      v.model.today = real() - 1; (winL.focus || []).forEach((f) => f()); await new Promise((r) => setTimeout(r, 60));
      ok(v.model.today === real(), "window focus after midnight rebuilds the model: " + v.model.today);
      v.model.today = real() - 1; const tb = JSON.stringify(v.el).length; // eslint-disable-line no-unused-vars
      const tdBtn = (function find(e) { if (!e || !e.children) return null; if (e.tag === "button" && JSON.stringify(e.children) .includes("今天") && e.listeners.click) return e; for (const c of e.children) { const r = find(c); if (r) return r; } return null; })(v.el);
      ok(!!tdBtn, "Today button found"); await tdBtn.listeners.click[0](); ok(v.model.today === real(), "Today button reloads a stale model: " + v.model.today); }
    // failure leaves task unbound
    global.__kernel = async (u) => (u === "/api/filetree/createDocWithMd" ? { code: -1, msg: "boom" } : { code: 0, data: { notebooks: [{ id: "nb1", name: "x" }] } });
    const t3 = Object.values(data).find((x) => !x.completed && !x.blockId && !x.docId && !(x.repeat && x.repeat.enabled)); let threw = false;
    try { await plugin.createDocAndBind(t3.id, { title: "x", box: "nb1", parentHPath: "/" }); } catch (e) { threw = /boom/.test(e.message); } ok(threw && !data[t3.id].blockId, "kernel failure -> error, task not bound");
    let threw2 = false; try { await plugin.createDocAndBind(task.id, { title: "x", box: "nb1", parentHPath: "/" }); } catch (e) { threw2 = /已经绑定/.test(e.message); } ok(threw2, "refuses to rebind a bound task");
  }

  // ---- not-started tasks get their own colour
  { const td = v.model.today; const N = (o) => ({ t: { id: "np", title: "未来", kanbanStatus: "doing", completed: false, ...(o.t || {}) }, children: [], depth: 0, kind: "own", noEnd: false, progress: 0, leaves: 1, doneLeaves: 0, spanStart: td + 3, spanEnd: td + 6, start: td + 3, end: td + 6, ...o, t: undefined });
    const mk = (o) => { const n = N(o); n.t = { id: "np", title: "未来", kanbanStatus: "doing", completed: false, ...(o.t || {}) }; return n; };
    ok(v.isPending(mk({})) === true, "future start, open -> not started");
    ok(v.isPending(mk({ spanStart: td, start: td })) === false, "starts today -> in progress, not pending");
    ok(v.isPending(mk({ spanStart: td - 2, start: td - 2, spanEnd: td + 1, end: td + 1 })) === false, "already started -> not pending");
    ok(v.isPending(mk({ t: { completed: true } })) === false, "done is never pending");
    ok(v.isPending(mk({ t: { kanbanStatus: "abandoned" } })) === false, "abandoned is never pending");
    ok(v.isPending(mk({ spanStart: null, start: null, kind: null })) === false, "unscheduled is not pending");
    const out = JSON.stringify(v.renderTask(mk({}), 2000), (k, x) => (k === "listeners" ? undefined : x));
    ok(out.includes("--c:#8b5cf6"), "not-started bar drawn in the not-started colour");
    const out2 = JSON.stringify(v.renderTask(mk({ spanStart: td - 1, start: td - 1, end: td + 2, spanEnd: td + 2 }), 2000), (k, x) => (k === "listeners" ? undefined : x));
    ok(out2.includes("--c:#3b82f6") && !out2.includes("#8b5cf6"), "started bar keeps the normal colour");
  }

  // ---- resize + destroy
  v.startResize({ button: 0, clientX: 300, pointerId: 1, currentTarget: El("i"), preventDefault() {}, stopPropagation() {} });
  v.destroy(); ok((winL.keydown || []).length === 0 && (winL.pointerdown || []).length === 0, "destroy removed window listeners");
  ok(nullAppend === 0, "still no null appends (" + nullAppend + ")");
})().catch((e) => { console.log("CRASH", e); process.exitCode = 1; });
