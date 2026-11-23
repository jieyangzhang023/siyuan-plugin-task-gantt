const Module = require("module"), fs = require("fs"); const orig = Module._load;
const menus = [];
Module._load = function (r, ...a) { if (r === "siyuan") return { Plugin: class { constructor(){ this.store={}; } async loadData(n){return this.store[n];} async saveData(n,v){this.store[n]=v;} addIcons(){} addTab(){} addTopBar(){} addCommand(){} }, openTab() {}, showMessage(m){ (global.__msgs ||= []).push(m); }, fetchSyncPost: async (u, d) => global.__kernel(u, d), Dialog: class { constructor(o){ this.o=o; const f=global.El("div"), a=global.El("div"); this.element={ querySelector:(q)=>q===".tg-form"?f:a, f, a }; global.__dlg=this; } destroy(){ global.__dlgDestroyed=(global.__dlgDestroyed||0)+1; } }, confirm(){},
  Menu: class { constructor(){ this.items=[]; menus.push(this);} addItem(i){this.items.push(i.label);} addSeparator(){} open(){} } }; return orig.call(this, r, ...a); };
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
  // synthetic data only: this test does not depend on the author's tasks
  const day = (off) => { const d = new Date(); return fromN(Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5) + off); }; // local calendar day, same as the plugin's todayNum()
  const t = (id, o) => ({ id, title: id, completed: false, kanbanStatus: "short_term", ...o });
  data = {
    A: t("A", { date: day(-1), endDate: day(1), priority: "low" }),          // spans today
    A2: t("A2", { date: day(0), endDate: day(0), priority: "high" }),        // today, high priority
    B: t("B", { date: day(-9), endDate: day(-3) }),                          // overdue 3 days
    C: t("C", { date: day(-5), kanbanStatus: "doing" }),                     // open-ended, in progress
    D: t("D", { kanbanStatus: "doing" }),                                    // no date, in progress
    E: t("E", { date: day(-2) }),                                            // open-ended, not in progress, not today -> neither
    F: t("F", { date: day(-8), endDate: day(-6) }),                          // parent: excluded itself
    F1: t("F1", { parentId: "F", date: day(-8), endDate: day(-7) }),         // overdue leaf under F (counted)
    G: t("G", { date: day(0), completed: true }),                            // done
    H: t("H", { date: day(0), kanbanStatus: "abandoned" }),                  // dropped
    I: t("I", { endDate: day(0) }),                                          // deadline today
    J: t("J", { date: day(0) }),                                             // open-ended starting today
    K: t("K", { date: day(3), endDate: day(5) }),                            // future
  };
  const root = El("div"); const v = new GanttView(root, plugin); v.done = "all"; v.showUndated = true; await v.reload();
  const { due, late } = v.focusLists();
  const ids = (l) => l.map((n) => n.id).sort().join(",");
  ok(ids(due) === "A,A2,C,I,J", "today list (undated D excluded): " + ids(due));
  ok(ids(v.focusLists().undated) === "D", "undated list: " + ids(v.focusLists().undated));
  ok(ids(late) === "B,F1", "overdue list: " + ids(late) + " (parent F and open-ended E excluded)");
  ok(late[0].id === "F1" || late[0].end <= late[1].end, "overdue sorted most overdue first");
  ok(due[0].id === "A2", "today sorted by priority (high first): " + due[0].id);
  ok(!late.some((n) => n.t.completed) && !due.some((n) => ["G", "H", "K", "E", "F"].includes(n.id)), "done/dropped/future/parent excluded");

  // strip + panel
  v.sumOpen = ""; v.render();
  ok(count(v.el, "tg-chip") === 4 && count(v.el, "tg-fitem") === 0, "strip shows four chips, no list when closed");
  v.sumOpen = "late"; v.render(); ok(count(v.el, "tg-fitem") === late.length, "late list rows: " + count(v.el, "tg-fitem"));
  v.sumOpen = "today"; v.render(); ok(count(v.el, "tg-fitem") === due.length, "today list rows: " + count(v.el, "tg-fitem"));
  v.sumOpen = "undated"; v.render(); ok(count(v.el, "tg-fitem") === 1, "undated list rows: " + count(v.el, "tg-fitem"));
  // project filter narrows the numbers
  v.project = "no-such-project"; v.render(); ok(v.focusLists().due.length === 0 && v.focusLists().late.length === 0 && v.focusLists().undated.length === 0, "project filter applies to the summary");
  v.project = "";
  // no overdue -> ok state
  for (const k of ["B", "F", "F1"]) delete data[k]; await v.reload();
  ok(v.focusLists().late.length === 0 && count(v.el, "tg-c-ok") === 1, "no overdue shows the ok chip");
  v.sumOpen = "late"; v.render(); ok(count(v.el, "tg-empty") >= 1, "empty overdue panel message");

  // schedule from the undated list -> becomes a 1-day task today
  const nd = v.focusLists().undated[0]; await v.schedule(nd, v.model.today, v.model.today);
  ok(data.D.date === day(0) && !data.D.endDate, "排到今天 sets date to today: " + data.D.date);
  await v.reload(); ok(v.focusLists().undated.length === 0 && v.focusLists().due.some((n) => n.id === "D"), "scheduled task moves from undated to today");

  // locate unfolds ancestors / project and clears filters
  data.P = t("P", { date: day(-1), endDate: day(1) }); data.P1 = t("P1", { parentId: "P", date: day(0), endDate: day(0) });
  await v.reload(); v.sumOpen = ""; v.fold.add("P"); v.q = "zzz"; v.status = "late"; v.render();
  const node = (() => { let r = null; const w = (x) => { if (x.id === "P1") r = x; x.children.forEach(w); }; v.model.groups.forEach((g) => g.roots.forEach(w)); return r; })();
  v.scroller = v.scroller || El("div");
  v.locate(node);
  ok(!v.fold.has("P") && v.q === "" && v.status === "all", "locate unfolds parent and clears filters");

  // hide a container task: subtree leaves leave 今日 / 未排期, overdue stays
  data.PL = t("PL", { parentId: "P", date: day(-6), endDate: day(-2) }); data.PU = t("PU", { parentId: "P" });
  await v.reload();
  ok(v.focusLists().due.some((n) => n.id === "P1") && v.focusLists().undated.some((n) => n.id === "PU"), "before hiding: P's children are listed");
  menus.length = 0; const pn = v.nodeOf("P"); v.taskMenu({ preventDefault() {}, target: {}, clientX: 0, clientY: 0 }, pn);
  ok(menus[0].items.includes("不在摘要中显示（含子任务）"), "menu offers hide: " + menus[0].items.join(" | "));
  await plugin.setHidden("P", true); await v.reload();
  const fl = v.focusLists();
  ok(!fl.due.some((n) => n.id === "P1") && !fl.undated.some((n) => n.id === "PU"), "hidden: subtree leaves removed from today/undated");
  ok(fl.late.some((n) => n.id === "PL"), "hidden: overdue child is still listed");
  ok(fl.marked.length === 1 && fl.marked[0].id === "P", "marked list has the task");
  ok(plugin.store["summary-hidden.json"].ids.join() === "P", "persisted via saveData");
  v.sumOpen = ""; v.render(); ok(count(v.el, "tg-chip") === 5, "hidden chip appears");
  v.sumOpen = "hidden"; v.render(); ok(count(v.el, "tg-fitem") === 1, "hidden list shows the marked task");
  menus.length = 0; v.taskMenu({ preventDefault() {}, target: {}, clientX: 0, clientY: 0 }, pn);
  ok(menus[0].items.includes("恢复在摘要中显示"), "menu offers restore");
  menus.length = 0; v.taskMenu({ preventDefault() {}, target: {}, clientX: 0, clientY: 0 }, v.nodeOf("PU"));
  ok(menus[0].items.includes("已随上级任务在摘要中隐藏"), "child shows inherited state");
  await plugin.setHidden("P", false); await v.reload();
  ok(v.focusLists().due.some((n) => n.id === "P1") && v.focusLists().marked.length === 0, "restored");
  ok(nullAppend === 0, "no null append (" + nullAppend + ")");
  console.log("done");
})().catch((e) => { console.error("ERR", e); process.exit(1); });
