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
global.CustomEvent = class {}; global.localStorage = { getItem: () => null, setItem() {} };
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
const plugin = new Plugin(); plugin.app = { plugins: [Object.assign(host, { name: "siyuan-plugin-task-note-management" })] }; plugin.undoStack = [];

(async () => {
  // synthetic data: same start date, a parent should list before plain tasks
  const t = (id, o) => ({ id, title: id, completed: false, kanbanStatus: "doing", ...o });
  data = {
    A: t("A", { date: "2026-11-10", endDate: "2026-11-12" }),                   // plain, ends earliest
    B: t("B", { date: "2026-11-10", endDate: "2026-11-20" }),                   // parent (has a subtask)
    B1: t("B1", { parentId: "B", date: "2026-11-11", endDate: "2026-11-12" }),
    C: t("C", { date: "2026-11-10", endDate: "2026-11-11" }),                   // plain
    D: t("D", { date: "2026-11-10", endDate: "2026-11-30" }),                   // parent whose only subtask is completed (hidden by the done filter)
    D1: t("D1", { parentId: "D", date: "2026-11-10", endDate: "2026-11-10", completed: true, completedTime: "2026-11-10 10:00" }),
    E: t("E", { date: "2026-11-09", endDate: "2026-11-09" }),                   // earlier start still wins
    F: t("F", { date: "2026-11-11", endDate: "2026-11-11" }),
    // same-start subtasks: G is a parent, G1 (itself a parent, so first) and G2 start with it, G1 has its own same-start child G1a; G3 starts later
    G: t("G", { date: "2026-11-08", endDate: "2026-11-15" }),
    X0: t("X0", { date: "2026-11-08", endDate: "2026-11-08" }),               // unrelated plain task, same start as G
    G1: t("G1", { parentId: "G", date: "2026-11-08", endDate: "2026-11-12" }),
    G1a: t("G1a", { parentId: "G1", date: "2026-11-08", endDate: "2026-11-09" }),
    G2: t("G2", { parentId: "G", date: "2026-11-08", endDate: "2026-11-10" }),
    G3: t("G3", { parentId: "G", date: "2026-11-12", endDate: "2026-11-13" }),
  };
  const root = El("div"); const v = new GanttView(root, plugin); v.sort = "time"; v.done = "open"; v.showUndated = true; await v.reload();
  const order = []; const labels = []; const walk = (x) => { if (x && x.children) { if (x.className && x.className.split(" ").includes("tg-row")) { const sp = x.attrs && x.attrs["data-id"]; if (sp) order.push(sp); } x.children.forEach(walk); } }; walk(v.el);
  ok(order.join(",") === "G,G1,G1a,G2,X0,E,B,D,C,A,F,B1,G3", "time order: " + order.join(","));
  ok(order.indexOf("G") + 1 === order.indexOf("G1") && order.indexOf("G1") + 1 === order.indexOf("G1a") && order.indexOf("G1a") + 1 === order.indexOf("G2") && order.indexOf("G2") + 1 === order.indexOf("X0"), "same-start subtasks sit directly under their parent, grandchild under its own parent, before unrelated tasks");
  ok(order.indexOf("G3") > order.indexOf("F"), "a subtask with a later start is NOT pulled under its parent");
  const i = (id) => order.indexOf(id);
  ok(i("E") < i("B") && i("B") < i("C") && i("D") < i("C") && i("B") < i("A") && i("D") < i("A"), "same start: parents (B, D) before plain tasks (A, C)");
  ok(i("C") < i("A"), "among plain tasks the earlier end still comes first");
  ok(i("B") < i("D"), "among parents the earlier end still comes first");
  ok(i("E") < i("B"), "an earlier start still wins over parent status");
  ok(nullAppend === 0, "no null append (" + nullAppend + ")");
  console.log("done");
})().catch((e) => { console.error("ERR", e); process.exit(1); });
