const fs = require('node:fs');
const path = require('node:path');

const VERSION = 2;

const empty = () => ({ version: VERSION, projects: [] });

// v1 kept one `last` string per project. Fold it into the log, never drop it.
const migrate = (doc) => {
  for (const p of doc.projects) {
    if (!Array.isArray(p.entries)) p.entries = [];
    if (typeof p.last === 'string' && p.last.trim() !== '') {
      p.entries.push({ at: p.updatedAt || Date.now(), text: p.last });
    }
    delete p.last;
  }
  doc.version = VERSION;
  return doc;
};

function createStore(filePath) {
  // Quarantine first: the next save would rename an empty doc over the unreadable one.
  const unusable = () => {
    try { fs.copyFileSync(filePath, filePath + '.corrupt.bak'); } catch {}
    return empty();
  };

  const load = () => {
    try {
      // Editors on Windows may prepend a BOM; it is not JSON.
      const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
      const doc = JSON.parse(raw);
      return doc && Array.isArray(doc.projects) ? migrate(doc) : unusable();
    } catch {
      return unusable();
    }
  };

  const save = (doc) => {
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.projects)) {
      throw new TypeError('save(doc): doc.projects must be an array');
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // One-step undo: keep the previous good file, so a bad edit is never the only copy.
    try {
      JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
      fs.copyFileSync(filePath, filePath + '.bak');
    } catch {}
    fs.writeFileSync(filePath + '.tmp', JSON.stringify(doc, null, 2));
    fs.renameSync(filePath + '.tmp', filePath);
  };

  const move = (doc, id, direction) => {
    const projects = doc.projects.slice().sort((a, b) => a.priority - b.priority);
    const from = projects.findIndex((p) => p.id === id);
    const to = from + (direction === 'up' ? -1 : 1);
    if (from !== -1 && to >= 0 && to < projects.length) {
      [projects[from], projects[to]] = [projects[to], projects[from]];
    }
    projects.forEach((p, i) => { p.priority = i; });
    doc.projects = projects;
    return doc;
  };

  return { load, save, move };
}

module.exports = { createStore };
