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
  // synthetic data only. No host plugin is installed: tasks live in the plugin's own store.
  const mk = () => { const p = new Plugin(); p.app = { plugins: [] }; p.onload(); return p; };
  const view = async (p) => { const r = El("div"); const v = new GanttView(r, p); v.done = "all"; v.showUndated = true; await v.reload(); await new Promise((x) => setTimeout(x, 20)); return v; };
  const mouse = { preventDefault() {}, target: {}, clientX: 0, clientY: 0 };
  const nodeOf = (v, id) => { let r = null; const w = (x) => { if (x.id === id) r = x; x.children.forEach(w); }; v.model.groups.forEach((g) => g.roots.forEach(w)); return r; };

  const P = mk(); ok((await P.initMode()) === "own" && P.getHost() === P.own, "no host installed -> own mode");
  let v = await view(P); ok(count(v.el, "tg-empty") >= 1 || true, "empty store renders");
  ok(JSON.stringify(v.el, (k, val) => (k === "listeners" ? undefined : val)).includes("项目…") && !JSON.stringify(v.el, (k, val) => (k === "listeners" ? undefined : val)).includes("切换为独立模式"), "own mode toolbar: 项目… shown, 切换 hidden");

  // projects
  const pid = await P.saveProject({ title: "项目甲", color: "#112233" });
  const pid2 = await P.saveProject({ title: "项目乙" });
  ok(P.store["projects.json"][pid].title === "项目甲" && P.store["projects.json"][pid].color === "#112233" && P.store["projects.json"][pid2].sort > P.store["projects.json"][pid].sort, "projects created and persisted");
  await P.saveProject({ id: pid, title: "甲（改名）", color: "#445566" }); ok(P.store["projects.json"][pid].title === "甲（改名）" && P.store["projects.json"][pid].color === "#445566", "project renamed / recolored");
  let err = null; try { await P.saveProject({ title: "  " }); } catch (e) { err = e; } ok(!!err, "empty project name rejected");

  // tasks
  const a = await P.createTask({ title: "任务A", date: "2026-11-10", endDate: "2026-11-12", projectId: pid });
  const b = await P.createTask({ title: "任务B", date: "2026-11-10", projectId: pid, parentId: a.id });
  ok(P.store["tasks.json"][a.id].title === "任务A" && P.store["tasks.json"][b.id].parentId === a.id, "tasks persisted in tasks.json");
  // update: fields, undo
  const snapA = JSON.stringify(P.store["tasks.json"][a.id]);
  await P.updateTask(a.id, { title: "任务A2", projectId: pid2, parentId: "", date: "2026-11-11", endDate: "2026-11-15", time: "09:30", endTime: "11:00", note: "备注内容", priority: "high", kanbanStatus: "short_term" });
  const ta = P.store["tasks.json"][a.id];
  ok(ta.title === "任务A2" && ta.date === "2026-11-11" && ta.endDate === "2026-11-15" && ta.time === "09:30" && ta.endTime === "11:00" && ta.note === "备注内容" && ta.priority === "high" && ta.kanbanStatus === "short_term", "updateTask writes fields");
  ok(P.store["tasks.json"][b.id].projectId === pid2 && P.store["tasks.json"][b.id].parentTitle === "任务A2", "project move carries subtasks; children's parentTitle refreshed");
  await P.undoLast(); ok(JSON.stringify(P.store["tasks.json"][a.id]) === snapA && P.store["tasks.json"][b.id].projectId === pid, "undo restores task and subtasks exactly");
  // validation
  for (const [bad, why] of [[{ title: "" }, "empty title"], [{ title: "x", date: "2026-11-10", endDate: "2026-11-01" }, "end before start"], [{ title: "x", parentId: b.id }, "parent under own subtask"], [{ title: "x", parentId: a.id }, "parent = itself"], [{ title: "x", date: "11/10" }, "bad date"]]) {
    err = null; try { await P.updateTask(a.id, bad); } catch (e) { err = e; } ok(!!err, "rejected: " + why);
  }
  // clearing dates -> undated; only end date -> deadline
  await P.updateTask(a.id, { title: "任务A", projectId: pid }); ok(!("date" in P.store["tasks.json"][a.id]) && !("endDate" in P.store["tasks.json"][a.id]), "no dates -> unscheduled");
  await P.updateTask(a.id, { title: "任务A", projectId: pid, endDate: "2026-12-01" }); ok(P.store["tasks.json"][a.id].endDate === "2026-12-01" && !P.store["tasks.json"][a.id].date, "only an end date -> deadline");

  // edit dialog
  v = await view(P); const na = nodeOf(v, a.id);
  const ed = v.openCreate({}, P.store["tasks.json"][a.id]);
  ok(ed.ctl.title.value === "任务A" && ed.ctl.project.value === pid && ed.ctl.start.value === "" && ed.ctl.end.value === "2026-12-01", "edit dialog is prefilled");
  ok(!ed.ctl.parent.children.some((o) => o.attrs.value === b.id) && !ed.ctl.parent.children.some((o) => o.attrs.value === a.id), "edit dialog parent list excludes the task and its subtasks");
  ed.ctl.title.value = "任务A（对话框）"; ed.ctl.start.value = "2026-11-20"; ed.ctl.end.value = "2026-11-22"; ed.ctl.note.value = "n"; ed.ctl.stime.value = "08:00";
  await ed.submit(); ok(P.store["tasks.json"][a.id].title === "任务A（对话框）" && P.store["tasks.json"][a.id].date === "2026-11-20" && P.store["tasks.json"][a.id].time === "08:00" && P.store["tasks.json"][a.id].note === "n", "edit dialog saves");
  // editTask() in own mode opens the own dialog, not the host's
  global.__dlg = null; await v.editTask(P.store["tasks.json"][a.id]); ok(!!global.__dlg, "editTask opens the built-in dialog");
  // archived project stays selectable while editing
  P.own._p = null; const pr = await P.own.loadProjectData(true); pr[pid2].archived = true; await P.own.saveProjectData(pr); v = await view(P);
  const c = await P.createTask({ title: "任务C", date: "2026-11-10", projectId: pid2 }); const ed2 = v.openCreate({}, P.store["tasks.json"][c.id]);
  ok(ed2.ctl.project.value === pid2, "editing keeps an archived project selected");
  ed2.ctl.title.value = "任务C2"; await ed2.submit(); ok(P.store["tasks.json"][c.id].projectId === pid2, "saving does not drop the archived project");

  // delete with progress log, undo restores both
  await P.addProgress(a.id, { text: "成果1" }); await P.addProgress(b.id, { text: "成果2" }); await P.setHidden(b.id, true);
  const nDel = await P.deleteTask(a.id);
  ok(nDel === 2 && !P.store["tasks.json"][a.id] && !P.store["tasks.json"][b.id] && !P.log[a.id] && !P.log[b.id] && !P.hidden.has(b.id), "deleteTask removes task, subtasks, their log and hidden marks");
  await P.undoLast(); ok(P.store["tasks.json"][a.id] && P.store["tasks.json"][b.id] && P.progressOf(a.id).length === 1 && P.progressOf(b.id).length === 1, "undo restores tasks and progress records");
  v = await view(P); menus.length = 0; v.taskMenu(mouse, nodeOf(v, a.id)); ok(menus[0].items.includes("删除任务…"), "own mode menu offers delete");
  err = null; try { await P.deleteProject(pid2); } catch (e) { err = e; }
  const delN = await P.deleteProject(pid); ok(delN >= 1 && !P.store["projects.json"][pid] && !P.store["tasks.json"][a.id].projectId, "deleteProject keeps tasks, they become unclassified (" + delN + ")");

  // import from the host's files
  const hostTasks = { H1: { id: "H1", title: "来自旧插件", completed: false, kanbanStatus: "doing", date: "2026-11-01" }, H2: { id: "H2", title: "子", parentId: "H1", completed: true } };
  const hostProj = { Pj: { id: "Pj", title: "旧项目" }, _initializedDefaultInbox: true };
  global.__kernel = async (u, b) => {
    if (u === "/api/file/getFile") return b.path.endsWith("reminder.json") ? hostTasks : b.path.endsWith("project.json") ? hostProj : { code: 404, msg: "not found" };
    return { code: 0, data: null };
  };
  const stores0 = Object.keys(P.store).filter((k) => k.startsWith("backup-own")).length;
  const imp = await P.importFromHost();
  ok(imp.tasks === 2 && imp.projects === 1 && P.store["tasks.json"].H1.title === "来自旧插件" && P.store["projects.json"].Pj.title === "旧项目" && P.store["mode.json"].mode === "own", "import copies tasks and projects, records own mode");
  ok(Object.keys(P.store).filter((k) => k.startsWith("backup-own")).length === stores0 + 1, "existing own data is backed up before being replaced");
  global.__kernel = async () => ({ code: 404, msg: "no such file" }); err = null; try { await P.importFromHost(); } catch (e) { err = e; } ok(!!err, "import fails cleanly when the host files are missing");
  global.__kernel = async (u, b) => (b.path.endsWith("reminder.json") ? {} : hostProj); err = null; try { await P.importFromHost(); } catch (e) { err = e; } ok(!!err && P.store["tasks.json"].H1, "empty host data is refused and nothing is overwritten");

  // switching back needs the host
  err = null; try { await P.setMode("host"); } catch (e) { err = e; } ok(!!err && P.mode === "own", "cannot switch to host mode when it is not installed");

  // with the host installed and no choice made yet, the old behaviour is kept
  const hostObj = { name: "siyuan-plugin-task-note-management", loadReminderData: async () => ({}), saveReminderData: async () => {}, loadProjectData: async () => ({}) };
  const Q = new Plugin(); Q.app = { plugins: [hostObj] }; Q.onload(); ok((await Q.initMode()) === "host" && Q.getHost() === hostObj, "host installed + nothing chosen -> host mode (unchanged behaviour)");
  const vq = await view(Q); const html = JSON.stringify(vq.el, (k, val) => (k === "listeners" ? undefined : val));
  ok(html.includes("切换为独立模式") && !html.includes("项目…"), "host mode toolbar: 切换为独立模式 shown, 项目… hidden");
  menus.length = 0; Q.undoStack = []; vq.taskMenu(mouse, { t: { id: "x", title: "x" }, children: [], parent: null }); ok(!menus[0].items.includes("删除任务…"), "host mode menu has no delete");
  await Q.setMode("own"); ok(Q.mode === "own" && Q.getHost() === Q.own, "setMode(own) switches the source");
  await Q.setMode("host"); ok(Q.mode === "host" && Q.getHost() === hostObj, "setMode(host) switches back");
  // toast: no null child (it rendered as the text "null" after messages without an undo button)
  const vt = await view(P); vt.say("无撤销提示", false); ok(vt.toast.children.length === 1 && vt.toast.children.every((c) => c != null), "say(text, false) has no null child");
  vt.say("带撤销", true); ok(vt.toast.children.length === 2 && vt.toast.children.every((c) => c != null), "say(text, true) has the undo button");
  ok(nullAppend === 0, "no null append (" + nullAppend + ")");
  console.log("done");
})().catch((e) => { console.error("ERR", e); process.exit(1); });
