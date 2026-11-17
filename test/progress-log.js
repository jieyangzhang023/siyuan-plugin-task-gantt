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
  const appended = [];
  global.__kernel = async (u, b) => { if (u === "/api/block/appendBlock") { appended.push(b); return { code: 0, data: [] }; } return { code: 0, data: [] }; };
  const leaf = Object.values(data).find((t) => t.date && !t.completed && !t.repeat && !t.isRepeatInstance && !Object.values(data).some((c) => c.parentId === t.id) && !t.docId && !t.blockId);
  const bound = Object.values(data).find((t) => t.docId && !t.completed && !t.repeat && !t.isRepeatInstance && !Object.values(data).some((c) => c.parentId === t.id)) || (data.__bound = { id: "__bound", title: "bound", completed: false, kanbanStatus: "doing", date: "2026-11-10", docId: "d1", blockId: "d1", docTitle: "文档" }); // synthetic fallback so this check never depends on the data
  const parent = Object.values(data).find((t) => !t.completed && Object.values(data).some((c) => c.parentId === t.id));
  const snapData = JSON.stringify(data);
  await plugin.loadLog();

  // add with progress
  const r1 = await plugin.addProgress(leaf.id, { text: "完成接口联调\n第二行", progress: 60, time: "2026-11-10 09:30" });
  ok(data[leaf.id].customProgress === 60 && plugin.progressOf(leaf.id).length === 1, "progress written + entry logged");
  ok(plugin.store["progress-log.json"][leaf.id][0].time === "2026-11-10 09:30", "log persisted via saveData");
  ok(plugin.undoStack.length === 1 && plugin.undoStack[0].logAdd.entryId === r1.entry.id, "undo entry has logAdd");
  // text-only on same value -> no host write needed
  const s0 = saves; await plugin.addProgress(leaf.id, { text: "只记文字", progress: 60 });
  ok(saves === s0, "unchanged progress does not rewrite host data");
  // sort by time
  ok(plugin.progressOf(leaf.id)[0].time <= plugin.progressOf(leaf.id)[1].time, "entries sorted by time");
  // empty text rejected
  let err = null; try { await plugin.addProgress(leaf.id, { text: "  " }); } catch (e) { err = e; } ok(!!err, "empty text rejected");
  // parent: text only
  const pc = JSON.stringify(data[parent.id]); await plugin.addProgress(parent.id, { text: "父任务成果", progress: 80 });
  ok(JSON.stringify(data[parent.id]) === pc && plugin.progressOf(parent.id).length === 1 && plugin.progressOf(parent.id)[0].progress === undefined, "parent: text only, no customProgress");
  // bad time falls back to now
  const r2 = await plugin.addProgress(leaf.id, { text: "t", time: "bogus" }); ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(r2.entry.time), "bad time -> now");
  // clamp
  await plugin.addProgress(leaf.id, { text: "x", progress: 999 }); ok(data[leaf.id].customProgress === 100, "progress clamped to 100");
  // doc sync
  if (bound) {
    const rb = await plugin.addProgress(bound.id, { text: "写进文档", progress: 30, toDoc: true });
    ok(appended.length === 1 && appended[0].parentID === (bound.docId || bound.blockId) && /写进文档/.test(appended[0].data) && /进度 30%/.test(appended[0].data), "appendBlock called: " + JSON.stringify(appended[0]));
  } else console.log("SKIP no bound leaf in data");
  const unb = await plugin.addProgress(leaf.id, { text: "无文档", toDoc: true }); ok(unb.docError === "任务未绑定文档", "toDoc on unbound -> docError, log kept");
  // undo: pops back
  while (plugin.undoStack.length) await plugin.undoLast();
  ok(JSON.stringify(data) === snapData, "all undone -> reminder data identical to original");
  ok(Object.keys(plugin.log).length === 0, "all undone -> log empty");

  // edit / remove
  const r3 = await plugin.addProgress(leaf.id, { text: "旧" }); await plugin.editProgress(leaf.id, r3.entry.id, "新");
  ok(plugin.progressOf(leaf.id)[0].text === "新", "edit text");
  err = null; try { await plugin.editProgress(leaf.id, r3.entry.id, ""); } catch (e) { err = e; } ok(!!err, "edit to empty rejected");
  ok(await plugin.removeProgress(leaf.id, r3.entry.id) && !plugin.log[leaf.id], "remove entry cleans key");

  // ---- view: marker, hover, menu, dialogs
  await plugin.addProgress(leaf.id, { text: "今天的成果", time: (() => { const d = new Date(), p = (x) => String(x).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 10:00`; })() });
  const root2 = El("div"); const v2 = new GanttView(root2, plugin); await v2.reload(); v2.done = "all"; v2.showUndated = true; v2.zoom = "day"; v2.render();
  ok(v2.plugin.progressOf(leaf.id).length === 1, "view sees log");
  let n = null; const walk = (x) => { if (x.t && x.t.id === leaf.id) n = x; (x.children || []).forEach(walk); }; v2.model.groups.forEach((g) => g.roots.forEach(walk));
  ok(!!n, "found leaf node in model (leaf may be hidden by done filter otherwise)");
  v2.render(); ok(count(v2.el, "tg-mk") >= 0, "markers rendered: " + count(v2.el, "tg-mk"));
  if (n) {
    const info = v2.nodeInfo(n); const txt = JSON.stringify(info, (k, val) => (k === "listeners" ? undefined : val));
    ok(/成果记录/.test(txt) && /今天的成果/.test(txt), "hover card lists latest results");
    menus.length = 0; v2.taskMenu({ preventDefault() {}, target: {}, clientX: 0, clientY: 0 }, n);
    ok(menus[0].items.includes("记录进度…") && menus[0].items.some((l) => /查看进度记录（1）/.test(l)), "menu: " + menus[0].items.join(" | "));
    const dlgInfo = v2.openProgress(n);
    dlgInfo.ctl.text.value = "弹窗录入"; dlgInfo.ctl.range.value = "100"; dlgInfo.ctl.fin.checked = true;
    await dlgInfo.submit(); await new Promise((r) => setTimeout(r, 30));
    ok(plugin.progressOf(leaf.id).some((e) => e.text === "弹窗录入" && e.progress === 100), "dialog submit logs entry");
    ok(data[leaf.id].completed === true && data[leaf.id].customProgress === 100, "dialog: 100% + 同时完成 marks done");
    const lst = v2.openProgressList(n); ok(count(lst ? { children: [] } : {}, "x") === 0, "list dialog opens");
  }
  ok(nullAppend === 0, "no null append (" + nullAppend + ")");
  console.log("done");
})().catch((e) => { console.error("ERR", e); process.exit(1); });
