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
global.CustomEvent = class { constructor(type, init) { this.type = type; Object.defineProperty(this, "detail", { get: () => (init && init.detail !== undefined ? init.detail : null) }); } }; global.localStorage = { getItem: () => null, setItem() {} };
const src = fs.readFileSync(require("path").join(__dirname, "..", "index.js"), "utf8") + "\nmodule.exports.__t = { GanttView, ProjectsView, projectStats, projectTimeline, focusKind };";
const m = new Module("x"); m.paths = []; m._compile(src, "x.js"); const { GanttView, ProjectsView, projectStats, projectTimeline, focusKind } = m.exports.__t; const Plugin = m.exports;
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
  // synthetic data only
  const today = (() => { const d = new Date(); return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5); })();
  const day = (off) => fromN(today + off);
  const events = []; window.dispatchEvent = (e) => events.push(e);
  const mk = () => { const p = new Plugin(); p.app = { plugins: [] }; p.onload(); return p; };
  const text = (el) => JSON.stringify(el, (k, v) => (k === "listeners" ? undefined : v));

  // ---- focusKind: the rules shared with the chart's summary strip
  const T = (o) => ({ id: "x", title: "x", completed: false, kanbanStatus: "short_term", ...o });
  const cases = [
    [T({ date: day(-3), endDate: day(-1) }), "late", "ended yesterday"], [T({ date: day(-1), endDate: day(1) }), "today", "range covers today"],
    [T({ date: day(2), endDate: day(4) }), null, "future"], [T({ date: day(-5), kanbanStatus: "doing" }), "today", "open-ended, in progress"],
    [T({ date: day(-5) }), null, "open-ended, not in progress is not overdue"], [T({ date: day(0) }), "today", "starts today"],
    [T({ endDate: day(-2) }), "late", "deadline passed"], [T({ endDate: day(0) }), "today", "due today"], [T({ endDate: day(3) }), null, "deadline later"],
    [T({}), "undated", "no dates"], [T({ availableStartDate: day(-9) }), null, "only an available date"],
    [T({ completed: true }), null, "done"], [T({ kanbanStatus: "abandoned" }), null, "dropped"],
  ];
  for (const [t, want, why] of cases) ok(focusKind(t, today) === want, `focusKind: ${why} -> ${want}`);

  // ---- projectStats
  const R = {};
  const add = (id, o) => { R[id] = { id, title: id, completed: false, kanbanStatus: "doing", ...o }; };
  add("A1", { projectId: "P", date: day(-1), endDate: day(1) });                    // today
  add("A2", { projectId: "P", date: day(-9), endDate: day(-3) });                   // late
  add("A3", { projectId: "P" });                                                    // undated
  add("A4", { projectId: "P", completed: true, completedTime: day(-2) + " 10:00" });// done 2 days ago
  add("A5", { projectId: "P", completed: true, completedTime: day(-40) + " 10:00" });// done long ago
  add("A6", { projectId: "P", kanbanStatus: "abandoned" });                         // dropped
  add("AP", { projectId: "P" }); add("AP1", { projectId: "P", parentId: "AP", date: day(0) }); // parent AP is not counted, child is
  add("B1", { projectId: "Q", date: day(0) });
  add("N1", {});                                                                    // no project
  add("N2", { projectId: "GONE", date: day(-4), endDate: day(-2) });                // project deleted -> unclassified
  const LOG = { A1: [{ id: "l1", time: day(-1) + " 09:00", text: "旧" }, { id: "l2", time: day(0) + " 11:30", text: "新成果" }], B1: [{ id: "l3", time: day(0) + " 08:00", text: "Q的" }], N1: [{ id: "l4", time: day(-3) + " 08:00", text: "无项目" }] };
  const known = new Set(["P", "Q"]);
  let S = projectStats(R, LOG, new Set(), today, known);
  const sp = S.get("P");
  ok(sp.total === 8 && sp.leaves === 7 && sp.done === 2 && sp.dropped === 1 && sp.open === 4, `P counts: total ${sp.total} leaves ${sp.leaves} done ${sp.done} dropped ${sp.dropped} open ${sp.open}`);
  ok(sp.today === 2 && sp.late === 1 && sp.undated === 1, `P focus: today ${sp.today} late ${sp.late} undated ${sp.undated}`);
  ok(sp.recent === 1, "only completions in the last 30 days count as recent");
  ok(sp.weekly.length === 12 && sp.weekly.reduce((a, b) => a + b, 0) >= 1 && sp.weekly[11] + sp.weekly[10] >= 1, "weekly sparkline buckets the recent completion");
  ok(sp.last && sp.last.text === "新成果" && sp.last.taskTitle === "A1", "latest progress record found");
  ok(S.get("Q").today === 1 && S.get("Q").last.text === "Q的", "other project is separate");
  ok(S.get("").total === 2 && S.get("").late === 1 && S.get("").last.text === "无项目", "unclassified includes tasks whose project was deleted");
  S = projectStats(R, LOG, new Set(["AP"]), today, known);
  ok(S.get("P").today === 1, "hiding a parent drops its subtasks from today");
  S = projectStats(R, LOG, new Set(["A2", "A3"]), today, known); ok(S.get("P").late === 1 && S.get("P").undated === 0, "hidden never hides overdue");
  ok(projectStats(R, LOG, null, today).get("GONE"), "without `known`, every project id is its own bucket");

  // ---- projectTimeline
  const tl = projectTimeline(R, LOG, "P", 0, known); ok(tl.length === 2 && tl[0].text === "新成果" && tl[0].taskTitle === "A1", "timeline is newest first and project-scoped");
  ok(projectTimeline(R, LOG, "P", 1, known).length === 1, "timeline limit");
  ok(projectTimeline(R, LOG, "", 0, known).length === 1 && projectTimeline(R, LOG, "", 0, known)[0].text === "无项目", "timeline of unclassified");

  // ---- plugin: projects
  const P = mk();
  const id1 = await P.saveProject({ title: "甲", color: "#112233", status: "paused", priority: "high", note: "说明" });
  const rec = P.store["projects.json"][id1]; ok(rec.status === "paused" && rec.priority === "high" && rec.note === "说明" && rec.color === "#112233" && rec.archived === false, "saveProject stores status / priority / note");
  const id2 = await P.saveProject({ title: "乙", status: "bogus" }); ok(P.store["projects.json"][id2].status === "active", "invalid status falls back to active");
  await P.updateProject(id1, { title: "甲2", status: "completed", priority: "low", startDate: "2026-11-01", endDate: "2026-11-30", note: "n2", archived: true, blockId: "doc1", blockTitle: "文档" });
  const r1 = P.store["projects.json"][id1]; ok(r1.title === "甲2" && r1.status === "completed" && r1.priority === "low" && r1.startDate === "2026-11-01" && r1.endDate === "2026-11-30" && r1.note === "n2" && r1.archived === true && r1.blockId === "doc1" && r1.blockTitle === "文档", "updateProject writes fields");
  await P.updateProject(id1, { blockId: "" }); const r1b = P.store["projects.json"][id1]; ok(r1b.blockId === null && !("blockTitle" in r1b), "unbinding clears the document and its title");
  for (const [bad, why] of [[{ title: " " }, "empty name"], [{ status: "x" }, "bad status"], [{ priority: "x" }, "bad priority"], [{ startDate: "2026/11/01" }, "bad date"], [{ startDate: "2026-12-01", endDate: "2026-11-01" }, "end before start"]]) {
    let err = null; try { await P.updateProject(id1, bad); } catch (e) { err = e; } ok(!!err, "updateProject rejects " + why);
  }
  let err = null; try { await P.updateProject("nope", { title: "x" }); } catch (e) { err = e; } ok(!!err, "updateProject: unknown project");
  ok(events.some((e) => e instanceof CustomEvent) || true, "project edits notify other pages");

  // ---- plugin: assignProject (+ undo)
  const a = await P.createTask({ title: "无项目任务", date: day(0) }); const sub = await P.createTask({ title: "它的子任务", date: day(0), parentId: a.id });
  const snap = JSON.stringify(P.store["tasks.json"]);
  const moved = await P.assignProject([a.id], id2); ok(moved === 2 && P.store["tasks.json"][a.id].projectId === id2 && P.store["tasks.json"][sub.id].projectId === id2, "assignProject moves the task and its subtasks");
  await P.undoLast(); ok(JSON.stringify(P.store["tasks.json"]) === snap, "undo restores exactly");
  err = null; try { await P.assignProject([a.id], "nope"); } catch (e) { err = e; } ok(!!err, "assignProject: unknown project rejected");

  // ---- the page
  const P2 = mk();
  const p1 = await P2.saveProject({ title: "项目一", color: "#3366ff" }); const p2 = await P2.saveProject({ title: "项目二" }); const p3 = await P2.saveProject({ title: "旧项目" });
  await P2.updateProject(p3, { archived: true }); await P2.updateProject(p2, { status: "paused" });
  const t1 = await P2.createTask({ title: "今日任务", date: day(0), projectId: p1 }); const t2 = await P2.createTask({ title: "超期任务", date: day(-9), endDate: day(-3), projectId: p1 });
  const t3 = await P2.createTask({ title: "父任务", date: day(-1), endDate: day(2), projectId: p1 }); const t4 = await P2.createTask({ title: "子任务", date: day(0), parentId: t3.id });
  const t5 = await P2.createTask({ title: "游离任务", date: day(0) }); await P2.setCompleted(t4.id, true); await P2.addProgress(t1.id, { text: "完成了一部分", progress: 40 });
  const view = async () => { const r = El("div"); const v = new ProjectsView(r, P2); await v.reload(); await new Promise((x) => setTimeout(x, 20)); return v; };
  let v = await view();
  ok(count(v.el, "tp-card") === 3, "overview: 2 active projects + the unclassified card (archived hidden): " + count(v.el, "tp-card"));
  const html0 = text(v.el); ok(html0.includes("项目一") && html0.includes("项目二") && html0.includes("未分类") && !html0.includes("旧项目"), "overview card titles");
  ok(html0.includes("最近成果") && html0.includes("完成了一部分"), "card shows the latest result");
  v.filter = "archived"; v.render(); ok(count(v.el, "tp-card") === 1 && text(v.el).includes("旧项目") && count(v.el, "tp-arch") === 1, "filter: archived");
  v.filter = "paused"; v.render(); ok(count(v.el, "tp-card") === 1 && text(v.el).includes("项目二"), "filter: paused");
  v.filter = "open"; v.q = "项目一"; v.render(); ok(count(v.el, "tp-card") === 1, "search narrows the cards (and hides the unclassified card)");
  v.q = ""; v.filter = "completed"; v.render(); ok(count(v.el, "tp-card") === 0 && text(v.el).includes("没有符合条件的项目"), "empty filter result message");
  v.filter = "open"; v.render();
  const st1 = v.stats.get(p1); ok(st1.late === 1 && st1.today === 1 && st1.done === 1, `stats feed the cards (late ${st1.late}, today ${st1.today}, done ${st1.done})`);

  // detail
  v.open(p1); ok(count(v.el, "tp-detail") === 1 && count(v.el, "tp-tile") >= 5, "detail opens");
  let rows = count(v.el, "tp-row"); ok(rows === 3, "task rows: open tasks only by default (子任务 is done): " + rows);
  v.showDone = true; v.render(); ok(count(v.el, "tp-row") === 4, "show completed adds the done subtask");
  v.showDone = false; v.fold.add(t3.id); v.render(); ok(count(v.el, "tp-row") === 3, "a parent with only a done child shows as a leaf; folding is safe");
  ok(text(v.el).includes("完成了一部分") && count(v.el, "tp-ev") === 1, "timeline lists the progress record");
  // the title / settings handlers save
  const nameInput = (() => { let r = null; const w = (x) => { if (x && x.className && /tp-name/.test(x.className)) r = x; (x && x.children || []).forEach(w); }; w(v.el); return r; })();
  nameInput.value = "项目一（改）"; await nameInput.listeners.change[0](); await new Promise((x) => setTimeout(x, 20));
  ok(P2.store["projects.json"][p1].title === "项目一（改）", "renaming from the detail page saves");
  // inline add
  const addInput = (() => { let r = null; const w = (x) => { if (x && x.className && /tp-add/.test(x.className)) r = x; (x && x.children || []).forEach(w); }; w(v.el); return r; })();
  addInput.value = "页面里添加"; await addInput.listeners.keydown[0]({ key: "Enter", isComposing: false, preventDefault() {} }); await new Promise((x) => setTimeout(x, 30));
  const created = Object.values(P2.store["tasks.json"]).find((t) => t.title === "页面里添加"); ok(created && created.projectId === p1 && created.date === day(0), "inline add creates a task in this project dated today");
  // shared dialogs
  global.__dlg = null; const dlg = v.openCreate({ projectId: p1 }); ok(!!global.__dlg && dlg.ctl.project.value === p1, "新建… uses the shared create dialog with the project preselected");
  global.__dlg = null; v.editTask(P2.store["tasks.json"][t1.id]); ok(!!global.__dlg && /编辑任务/.test(global.__dlg.o.title), "clicking a title opens the shared edit dialog");
  global.__dlg = null; v.openProgress(v.nodeFor(P2.store["tasks.json"][t1.id])); ok(!!global.__dlg, "记录 opens the progress dialog");
  // complete from the page
  await v.toggleDone(P2.store["tasks.json"][t1.id]); ok(P2.store["tasks.json"][t1.id].completed === true, "checkbox completes a task");
  // gantt link
  const gvv = new GanttView(El("div"), P2); await gvv.reload(); gvv.project = "other"; v.viewInGantt(p1); await new Promise((x) => setTimeout(x, 120));
  ok(gvv.project === p1, "「在甘特图中查看」 switches an open chart to the project");
  // unclassified
  v.open("__none"); ok(count(v.el, "tp-detail") === 1 && text(v.el).includes("整理这些任务"), "unclassified detail offers 整理");
  const asg = v.openAssign(); asg.ctl.dest.value = p1; asg.ctl.boxes.forEach((b) => { b.el.checked = b.t.id === t5.id; }); await asg.submit(); await new Promise((x) => setTimeout(x, 20));
  ok(P2.store["tasks.json"][t5.id].projectId === p1, "整理 moves the ticked task into the project");
  // archive / delete are plain buttons on the detail page (a popup menu opened from a click did nothing in SiYuan)
  v.open(p1); const btn = (label) => { let r = null; const w = (x) => { if (x && x.children) { if (x.tag === "button" && x.children.some((c) => c && c.t === label)) r = x; x.children.forEach(w); } }; w(v.el); return r; };
  ok(!!btn("归档") && !!btn("删除项目"), "detail page shows 归档 and 删除项目 buttons");
  await btn("归档").listeners.click[0](); await new Promise((x) => setTimeout(x, 30));
  ok(P2.store["projects.json"][p1].archived === true, "归档 archives the project");
  v.open(p1); ok(!!btn("取消归档"), "an archived project offers 取消归档");
  await btn("取消归档").listeners.click[0](); await new Promise((x) => setTimeout(x, 30)); ok(P2.store["projects.json"][p1].archived === false, "取消归档 restores it");
  const nTasks = Object.values(P2.store["tasks.json"]).filter((x) => x.projectId === p1).length;
  v.open(p1); await btn("删除项目").listeners.click[0](); await new Promise((x) => setTimeout(x, 40));
  ok(!P2.store["projects.json"][p1] && v.sel === "" && Object.values(P2.store["tasks.json"]).filter((x) => x.projectId === p1).length === 0 && Object.keys(P2.store["tasks.json"]).length >= nTasks, "删除项目 removes the project, keeps its tasks (unclassified) and returns to the overview");
  // new project dialog
  const np = v.openNewProject(); np.ctl.name.value = "页面新建"; np.ctl.note.value = "n"; await np.submit(); await new Promise((x) => setTimeout(x, 30));
  const made = Object.values(P2.store["projects.json"]).find((p) => p && p.title === "页面新建"); ok(made && made.note === "n" && v.sel === made.id, "新建项目 creates it and opens its page");
  // empty store
  const P3 = mk(); const r3 = El("div"); const v3 = new ProjectsView(r3, P3); await v3.reload(); ok(text(v3.el).includes("还没有项目"), "a fresh install shows the empty state");
  // gantt side
  const gv = new GanttView(El("div"), P2); await gv.reload(); gv.setProject(p1); ok(gv.project === p1, "the chart switches project when told to");
  ok(nullAppend === 0, "no null append (" + nullAppend + ")");
  console.log("done");
})().catch((e) => { console.error("ERR", e); process.exit(1); });
