Plain Node scripts, no dependencies. They stub the `siyuan` module and a minimal DOM, and run the plugin against an
in-memory COPY of your real task data (`reminder.json`, `project.json`); nothing is written back.

    TASK_DATA_DIR=/path/to/storage/petal/siyuan-plugin-task-note-management node test/regression.js
    TASK_DATA_DIR=... node test/progress-log.js

`TASK_DATA_DIR` defaults to `~/Documents/siyuan/data/storage/petal/siyuan-plugin-task-note-management`.
A few assertions look for specific titles (e.g. a search keyword) and need data that contains them, so they are
written for the author's workspace; failures on other data are expected until fixtures are added.
