# Changelog

Versions follow `plugin.json`; each release is tagged `vX.Y.Z`.

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
