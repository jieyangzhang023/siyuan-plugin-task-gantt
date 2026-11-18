# Changelog

Versions follow `plugin.json`; each release is tagged `vX.Y.Z`. 中文版：[CHANGELOG_zh_CN.md](./CHANGELOG_zh_CN.md)

## 0.14.0
- Results are rendered as Markdown (headings, bold / italic, lists, task lists, quotes, code blocks, tables, links) in the project page's results timeline and in the chart's "View progress log" list. SiYuan's own Lute renders it with sanitising on; single line breaks are kept, so existing plain notes look the same. Links open in the system browser. If Lute is unavailable the text is shown as plain text. The hover card is unchanged.
- The text you wrote is shown in a bordered card, separate from the task title.

## 0.13.0
- "Create document and bind": right-click a row in the parent-document tree (a document or a notebook) → "New subdocument". A name box (default 「新建笔记」) appears under it; press Enter to create a blank document there and have it selected as the parent, Esc to cancel. This lets you create the missing folder (A/B/C where B does not exist yet) without leaving the dialog.
- Fix: a Gantt chart or project page left open overnight kept yesterday's date, so the "today" line was wrong and the 「今天」 button did nothing. They now reload when the date changes (at midnight, or when the window is shown again), and the 「今天」 button refreshes a stale chart first.

## 0.12.0
- Tasks that have not started yet (open, first day still ahead) are drawn in purple, with a legend entry and a 「未开始」 note on the hover card. Parent summary bars follow the same rule.

## 0.11.0
- 「创建文档并绑定」: the parent document is now picked from the full notebook tree (collapsed at first, levels load when opened); search and the ★ shortcuts still work.
- New / edit task dialog: the parent task is picked from the project's task tree the same way (collapsed at first; the way down to a preset parent is opened); keyword search still works.

## 0.10.3
- Fix: the 「甘特图」 button on a project card opened the chart on the wrong project (first all projects, then always the same one). The project id was lost in a read-only `CustomEvent.detail`, and the window event itself did not reliably reach an open chart. The page now switches the open chart directly.

## 0.10.2
- Bazaar preparation: icon and preview image, English README (default) with the Chinese one as README_zh_CN.md, screenshots, keywords. No code changes.

## 0.10.1
- Fix: the 「⋯」 button on the project page did nothing (a popup menu opened from a click was closed immediately). Archive / unarchive and 「删除项目」 are now plain buttons next to the project settings.

## 0.10.0
- **Project page** (second top-bar icon / command 「打开项目管理」 / chart toolbar 「项目…」): overview cards per project (status, priority, progress bar, today / overdue / undated / open counts, latest result, 12-week completion sparkline, 「甘特图」 shortcut), status filter and search, a 「未分类」 card for tasks without a project.
- Project detail: edit name, color, status (进行中 / 暂停 / 已完成), priority, dates, note inline; bind / change / unbind a document; archive or delete; stat tiles; task tree with complete checkbox, quick add, edit, log progress, add subtask, delete; results timeline across the project's tasks; 「整理这些任务…」 moves unclassified tasks into a project in one undoable step.
- The chart's summary strip and the project cards now share one rule set (`focusKind`); a task that only has an "available from" date is no longer counted as overdue. Progress records now refresh other open pages immediately. The old project dialog in the chart is replaced by the page.

## 0.9.0
- **The plugin is now fully standalone.** Removed everything that referred to Task Note Management: the 「切换为独立模式…」 toolbar button, the import / switch-back commands, the host data mode, and every call into the host plugin. Tasks and projects always live in this plugin's storage (`tasks.json`, `projects.json`). A fresh install starts empty. The new-document dialog remembers the notebook used last time instead of reading the host's setting. Repeating tasks can no longer be completed from the chart.
- Existing `tasks.json` / `projects.json` (including data imported in 0.8.x) keep working unchanged.

## 0.8.1
- Fix: toast messages without an undo button (e.g. after switching to standalone mode, creating a document) showed a stray "null".

## 0.8.0
- **Standalone mode.** Tasks and projects can live in this plugin's own storage (`tasks.json`, `projects.json`, same record shape as Task Note Management), so the plugin no longer needs it. Without the host plugin installed it starts in standalone mode; with it installed and nothing chosen, behaviour is unchanged. 「切换为独立模式…」 (toolbar) / command 「从任务笔记管理导入任务并切换为独立模式」 copies the host's tasks and projects once (the host's files are only read, existing own data is backed up first); command 「切回任务笔记管理的数据」 switches back.
- Built-in task editor (title, project, parent, dates, times, priority, status, note) used in standalone mode; 「删除任务…」 (with subtasks and their progress records, undoable); 「项目…」 manager (add, rename, recolor, delete; deleting keeps the tasks as unclassified).
- Fix: two projects created in the same millisecond could share an id.

## 0.7.4
- Sort by start time: a subtask that starts on the same day as its parent is now listed directly under the parent (grandchildren likewise); subtasks with a later start keep their own place. Parents still come before plain tasks that share the start date.

## 0.7.3
- Sort by start time: tasks with the same start date now list parent tasks (those with subtasks) first, then by end date as before.

## 0.7.2
- Fix: after the bound document was deleted the task still looked bound and 「打开所在文档/块」 failed with 「块不存在」. Deleted bindings are now detected (hover card says 「文档已被删除」); the menu offers 「解除绑定」 (undoable) and 「重新创建文档并绑定…」; opening a task whose document is gone offers to unbind. Unknown or lagging index answers are re-checked against the block tree and never treated as deleted.

## 0.7.1
- Verified against Task Note Management 7.2.2 (host methods, data file and block attributes unchanged); README updated. No code changes.

## 0.7.0
- Right-click a task → 「不在摘要中显示（含子任务）」: it and all its subtasks stop counting in 今日 / 未排期 (overdue is never hidden). A 「已隐藏 N」 chip lists them with 「恢复显示」. Stored in `summary-hidden.json`; the chart itself is unchanged.

## 0.6.1
- Tasks with no date are no longer listed under 今日; they get their own 「未排期 N」 chip (in progress first, then short/long term). Each row has 「排到今天」 (sets the start date to today) besides 「记录进度」 and 「完成」.

## 0.6.0
- Summary strip under the toolbar: 「今日 N」and「超期 N」chips. Click one to open its list; click a title to jump to the task on the chart (unfolds parents, clears filters, flashes the row); each row has 「记录进度」and「完成」buttons. Follows the project filter; state is remembered. Today = date range covers today, open-ended in-progress, or in-progress with no date. Overdue = end date in the past (open-ended tasks never count).

## 0.5.1
- Removed the 「导入任务计划」command (it read a local `import-plan.json` and was specific to the author's workflow).

## 0.5.0
- Right-click a task → 「记录进度…」: log a result (text, optional progress %, backdated time), optionally append a line to the bound document. Stored in `progress-log.json`; progress is written to the host's `customProgress`. Diamond markers on the timeline, latest entries in the hover card, 「查看进度记录」 to edit/delete. Undoable (Ctrl+Z).

## 0.4.0
- Right-click → 「创建文档并绑定…」 with searchable parent document. Fixed dialog buttons going off screen.

## 0.3.0
- Three ways to create tasks (toolbar dialog, drag on a project row, inline add row); parent-task search.

## 0.2.0
- Overdue red tail, undo, search / status filter / fold-all, paint-schedule, resizable label column, Ctrl+wheel zoom, pan. Open-ended tasks ("持续中") are no longer overdue.

## 0.1.0
- Gantt grouped by project with subtask hierarchy, drag to reschedule, hover card, edit via host dialog, completed-task range, sort, plan importer.
