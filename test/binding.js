const Module = require("module"), fs = require("fs"); const orig = Module._load;
const menus = [];
Module._load = function (r, ...a) { if (r === "siyuan") return { Plugin: class { constructor(){ this.store={}; } async loadData(n){return this.store[n];} async saveData(n,v){this.store[n]=v;} addIcons(){} addTab(){} addTopBar(){} addCommand(){} }, openTab() {}, showMessage(m){ (global.__msgs ||= []).push(m); }, fetchSyncPost: async (u, d) => global.__kernel(u, d), Dialog: class { constructor(o){ this.o=o; const f=global.El("div"), a=global.El("div"); this.element={ querySelector:(q)=>q===".tg-form"?f:a, f, a }; global.__dlg=this; } destroy(){ global.__dlgDestroyed=(global.__dlgDestroyed||0)+1; } }, confirm(a, b, cb){ global.__confirmed = (global.__confirmed || 0) + 1; if (cb) return cb(); },
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
  // synthetic data only. X = bound doc that was deleted, Y = bound doc that exists, Z = unbound
  const alive = new Set(["Y-doc"]); const exists = new Set(["Y-doc"]); const calls = [];
  global.__kernel = async (u, b) => {
    calls.push(u);
    if (u === "/api/query/sql") { const ids = [...b.stmt.matchAll(/'([^']+)'/g)].map((m) => m[1]); return { code: 0, data: ids.filter((i) => alive.has(i)).map((id) => ({ id })) }; }
    if (u === "/api/block/checkBlockExist") return { code: 0, data: exists.has(b.id) };
    return { code: 0, data: null };
  };
  const t = (id, o) => ({ id, title: id, completed: false, kanbanStatus: "doing", date: "2026-11-16", ...o });
  data = { X: t("X", { blockId: "X-doc", docId: "X-doc", docTitle: "已删除的文档" }), Y: t("Y", { blockId: "Y-doc", docId: "Y-doc", docTitle: "还在" }), Z: t("Z") };
  const root = El("div"); const v = new GanttView(root, plugin); v.done = "all"; await v.reload(); await new Promise((r) => setTimeout(r, 30));
  ok(v.dead.has("X") && !v.dead.has("Y") && !v.dead.has("Z"), "dead bindings detected: " + [...v.dead]);
  // index lag: a block missing from the index but still in the block tree is NOT dead
  alive.delete("Y-doc"); const d2 = await plugin.findDeadBindings(data); ok(!d2.has("Y") && d2.has("X"), "index miss re-checked against block tree");
  alive.add("Y-doc");
  // kernel cannot tell -> nothing marked
  const keep = global.__kernel; global.__kernel = async () => { throw new Error("down"); };
  ok((await plugin.findDeadBindings(data)).size === 0, "kernel error -> nothing marked dead"); global.__kernel = keep;
  // hover card + menu
  let node = null; const w = (x) => { if (x.id === "X") node = x; x.children.forEach(w); }; v.model.groups.forEach((g) => g.roots.forEach(w));
  ok(/已被删除/.test(JSON.stringify(v.nodeInfo(node), (k, val) => (k === "listeners" ? undefined : val))), "hover card flags the deleted document");
  menus.length = 0; v.taskMenu({ preventDefault() {}, target: {}, clientX: 0, clientY: 0 }, node);
  ok(menus[0].items.includes("绑定的文档已被删除，解除绑定") && menus[0].items.includes("重新创建文档并绑定…") && !menus[0].items.includes("打开所在文档/块"), "menu: " + menus[0].items.join(" | "));
  // open on a dead binding -> unbind prompt (the stub confirm runs the callback)
  await v.openTask(data.X); await new Promise((r) => setTimeout(r, 30));
  ok(!data.X.blockId && !data.X.docId && !data.X.docTitle, "unbind cleared blockId/docId/docTitle");
  ok(plugin.undoStack.length === 1 && plugin.undoStack[0].label.startsWith("解除绑定"), "unbind is undoable");
  await plugin.undoLast(); ok(data.X.blockId === "X-doc" && data.X.docTitle === "已删除的文档", "undo restores the binding");
  // never unbind a live document
  let err = null; try { await plugin.unbindDoc("Y"); } catch (e) { err = e; } ok(!!err && data.Y.blockId === "Y-doc", "refuses to unbind a document that still exists");
  // rebind over a dead binding is allowed; over a live one it is not
  let created = 0; const k2 = global.__kernel;
  global.__kernel = async (u, b) => { if (u === "/api/filetree/createDocWithMd") { created++; return { code: 0, data: "new-doc" }; } return k2(u, b); };
  const nd = await plugin.createDocAndBind("X", { title: "新文档", box: "nb", parentHPath: "/" });
  ok(nd === "new-doc" && data.X.blockId === "new-doc" && created === 1, "rebinding over a deleted document works");
  err = null; try { await plugin.createDocAndBind("Y", { title: "x", box: "nb", parentHPath: "/" }); } catch (e) { err = e; } ok(!!err && created === 1, "still refuses to rebind a live binding");
  // live binding opens normally
  menus.length = 0; let nodeY = null; const w2 = (x) => { if (x.id === "Y") nodeY = x; x.children.forEach(w2); }; v.model.groups.forEach((g) => g.roots.forEach(w2));
  v.taskMenu({ preventDefault() {}, target: {}, clientX: 0, clientY: 0 }, nodeY);
  ok(menus[0].items.includes("打开所在文档/块"), "live binding keeps the open item");
  ok(nullAppend === 0, "no null append (" + nullAppend + ")");
  console.log("done");
})().catch((e) => { console.error("ERR", e); process.exit(1); });
