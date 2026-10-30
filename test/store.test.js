const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../store.js');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'taskx-')), 'data.json');
}

const project = (id, priority) => ({
  id, name: id, priority, entries: [], next: '', updatedAt: 0,
});

const emptyDoc = () => ({ version: 2, projects: [] });

test('load returns an empty doc when the file is missing', () => {
  assert.deepStrictEqual(createStore(tmpFile()).load(), emptyDoc());
});

test('save then load round-trips projects', () => {
  const store = createStore(tmpFile());
  const doc = { version: 2, projects: [project('a', 0), project('b', 1)] };
  store.save(doc);
  assert.deepStrictEqual(store.load(), doc);
});

test('save leaves no .tmp file behind', () => {
  const file = tmpFile();
  createStore(file).save(emptyDoc());
  assert.strictEqual(fs.existsSync(file + '.tmp'), false);
  assert.strictEqual(fs.existsSync(file), true);
});

test('save rejects a doc without a projects array', () => {
  const file = tmpFile();
  const store = createStore(file);
  assert.throws(() => store.save(null), TypeError);
  assert.throws(() => store.save({ version: 2 }), TypeError);
  assert.strictEqual(fs.existsSync(file), false);
});

test('load returns an empty doc for corrupt JSON instead of throwing', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ not json');
  assert.deepStrictEqual(createStore(file).load(), emptyDoc());
});

test('load quarantines a corrupt file before it can be overwritten', () => {
  const file = tmpFile();
  const corrupt = '{ not json';
  fs.writeFileSync(file, corrupt);
  createStore(file).load();
  assert.strictEqual(fs.existsSync(file + '.corrupt.bak'), true);
  assert.strictEqual(fs.readFileSync(file + '.corrupt.bak', 'utf8'), corrupt);
});

test('load returns an empty doc for valid JSON of the wrong shape', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{"projects":"x"}');
  assert.deepStrictEqual(createStore(file).load(), emptyDoc());
  assert.strictEqual(fs.readFileSync(file + '.corrupt.bak', 'utf8'), '{"projects":"x"}');
});

test('a v1 `last` line becomes the first history entry', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    projects: [{ id: 'a', name: 'Alpha', priority: 0, last: 'fixed the parser', next: 'ship it', updatedAt: 42 }],
  }));
  const doc = createStore(file).load();
  assert.strictEqual(doc.version, 2);
  assert.deepStrictEqual(doc.projects[0].entries, [{ at: 42, text: 'fixed the parser' }]);
  assert.strictEqual('last' in doc.projects[0], false);
  assert.strictEqual(doc.projects[0].next, 'ship it');
});

test('migrating twice does not duplicate the entry', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    projects: [{ id: 'a', name: 'Alpha', priority: 0, last: 'only once' }],
  }));
  const store = createStore(file);
  store.load();
  store.save(store.load());
  assert.strictEqual(store.load().projects[0].entries.length, 1);
});

test('history entries survive a round trip in order', () => {
  const store = createStore(tmpFile());
  const entries = [
    { at: 1, text: 'first' },
    { at: 2, text: 'second' },
    { at: 3, text: 'third' },
  ];
  store.save({ version: 2, projects: [{ ...project('a', 0), entries }] });
  assert.deepStrictEqual(store.load().projects[0].entries, entries);
});

test('non-ASCII text survives a round trip', () => {
  const store = createStore(tmpFile());
  const p = {
    ...project('a', 0),
    name: 'مشروع',
    next: '🚀 ship it',
    entries: [{ at: 1, text: 'naïve café' }],
  };
  store.save({ version: 2, projects: [p] });
  assert.deepStrictEqual(store.load().projects[0], p);
});

test('a UTF-8 BOM from an editor does not count as corruption', () => {
  const file = tmpFile();
  const doc = { version: 2, projects: [project('a', 0)] };
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify(doc));
  assert.deepStrictEqual(createStore(file).load().projects.map((p) => p.id), ['a']);
  assert.strictEqual(fs.existsSync(file + '.corrupt.bak'), false);
});

test('save keeps the previous file as .bak', () => {
  const file = tmpFile();
  const store = createStore(file);
  store.save({ version: 2, projects: [project('first', 0)] });
  store.save({ version: 2, projects: [project('second', 0)] });

  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).projects[0].id, 'second');
  assert.strictEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')).projects[0].id, 'first');
});

test('save writes no .bak when there is nothing to back up', () => {
  const file = tmpFile();
  createStore(file).save(emptyDoc());
  assert.strictEqual(fs.existsSync(file + '.bak'), false);
});

test('save never overwrites a good .bak with a corrupt file', () => {
  const file = tmpFile();
  const store = createStore(file);
  store.save({ version: 2, projects: [project('good', 0)] });
  store.save({ version: 2, projects: [project('newer', 0)] });
  fs.writeFileSync(file, '{ broken');
  store.save({ version: 2, projects: [project('after', 0)] });
  assert.strictEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')).projects[0].id, 'good');
});

test('move up renumbers priorities sequentially', () => {
  const doc = { version: 2, projects: [project('a', 0), project('b', 1), project('c', 2)] };
  const out = createStore(tmpFile()).move(doc, 'c', 'up');
  assert.deepStrictEqual(out.projects.map(p => [p.id, p.priority]), [['a', 0], ['c', 1], ['b', 2]]);
});

test('move past the top edge is a no-op', () => {
  const doc = { version: 2, projects: [project('a', 0), project('b', 1)] };
  const out = createStore(tmpFile()).move(doc, 'a', 'up');
  assert.deepStrictEqual(out.projects.map(p => p.id), ['a', 'b']);
});

test('move with an unknown id renumbers and does not throw', () => {
  const doc = { version: 2, projects: [project('a', 5), project('b', 9)] };
  const out = createStore(tmpFile()).move(doc, 'nope', 'up');
  assert.deepStrictEqual(out.projects.map(p => [p.id, p.priority]), [['a', 0], ['b', 1]]);
});
