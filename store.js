const fs = require('node:fs');
const path = require('node:path');

const empty = () => ({ version: 1, projects: [] });

function createStore(filePath) {
  const load = () => {
    try {
      const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return doc && Array.isArray(doc.projects) ? doc : empty();
    } catch {
      return empty();
    }
  };

  const save = (doc) => {
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.projects)) {
      throw new TypeError('save(doc): doc.projects must be an array');
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
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
