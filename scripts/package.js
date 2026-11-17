// Builds the contents of package.zip in dist/. The bazaar shows only the README, so the packaged
// READMEs get the latest changelog entries appended; both changelogs are shipped too.
// dist/RELEASE_NOTES.md holds this version's entries for the GitHub Release.
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const version = require(path.join(root, "plugin.json")).version;
const KEEP = 5; // versions shown in the README
const dist = path.join(root, "dist");
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);

const sections = (text) => text.split(/^## /m).slice(1).map((s) => { const i = s.indexOf("\n"); return { version: s.slice(0, i).trim(), body: s.slice(i + 1).trim() }; });
const pairs = [["README.md", "CHANGELOG.md", "Changelog", "Full changelog"], ["README_zh_CN.md", "CHANGELOG_zh_CN.md", "更新日志", "完整更新日志"]];
const notes = [];
for (const [readme, log, title, full] of pairs) {
  const secs = sections(fs.readFileSync(path.join(root, log), "utf8"));
  const cur = secs.find((s) => s.version === version);
  if (!cur) throw new Error(`${log} has no section for ${version}`);
  const recent = secs.slice(0, KEEP).map((s) => `### ${s.version}\n\n${s.body}`).join("\n\n");
  const link = `https://github.com/jieyangzhang023/siyuan-plugin-task-gantt/blob/main/${log}`;
  fs.writeFileSync(path.join(dist, readme), fs.readFileSync(path.join(root, readme), "utf8").replace(/\s*$/, "\n") + `\n## ${title}\n\n${recent}\n\n[${full}](${link})\n`);
  notes.push(cur.body);
}
fs.writeFileSync(path.join(dist, "RELEASE_NOTES.md"), `${notes[0]}\n\n---\n\n${notes[1]}\n`);
for (const f of ["index.js", "index.css", "plugin.json", "LICENSE", "CHANGELOG.md", "CHANGELOG_zh_CN.md", "icon.png", "preview.png"]) {
  if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(dist, f));
}
console.log("packaged", version);
