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
  id, name: id, priority, last: '', next: '', updatedAt: 0,
});

test('load returns an empty doc when the file is missing', () => {
  assert.deepStrictEqual(createStore(tmpFile()).load(), { version: 1, projects: [] });
});

test('save then load round-trips projects', () => {
  const store = createStore(tmpFile());
  const doc = { version: 1, projects: [project('a', 0), project('b', 1)] };
  store.save(doc);
  assert.deepStrictEqual(store.load(), doc);
});

test('save leaves no .tmp file behind', () => {
  const file = tmpFile();
  createStore(file).save({ version: 1, projects: [] });
  assert.strictEqual(fs.existsSync(file + '.tmp'), false);
  assert.strictEqual(fs.existsSync(file), true);
});

test('save rejects a doc without a projects array', () => {
  const file = tmpFile();
  const store = createStore(file);
  assert.throws(() => store.save(null), TypeError);
  assert.throws(() => store.save({ version: 1 }), TypeError);
  assert.strictEqual(fs.existsSync(file), false);
});

test('load returns an empty doc for corrupt JSON instead of throwing', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ not json');
  assert.deepStrictEqual(createStore(file).load(), { version: 1, projects: [] });
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
  assert.deepStrictEqual(createStore(file).load(), { version: 1, projects: [] });
  assert.strictEqual(fs.readFileSync(file + '.corrupt.bak', 'utf8'), '{"projects":"x"}');
});

test('non-ASCII text survives a round trip', () => {
  const store = createStore(tmpFile());
  const p = { ...project('a', 0), name: 'مشروع', last: 'naïve café', next: '🚀 ship it' };
  store.save({ version: 1, projects: [p] });
  assert.deepStrictEqual(store.load().projects[0], p);
});

test('move up renumbers priorities sequentially', () => {
  const doc = { version: 1, projects: [project('a', 0), project('b', 1), project('c', 2)] };
  const out = createStore(tmpFile()).move(doc, 'c', 'up');
  assert.deepStrictEqual(out.projects.map(p => [p.id, p.priority]), [['a', 0], ['c', 1], ['b', 2]]);
});

test('move past the top edge is a no-op', () => {
  const doc = { version: 1, projects: [project('a', 0), project('b', 1)] };
  const out = createStore(tmpFile()).move(doc, 'a', 'up');
  assert.deepStrictEqual(out.projects.map(p => p.id), ['a', 'b']);
});

test('move with an unknown id renumbers and does not throw', () => {
  const doc = { version: 1, projects: [project('a', 5), project('b', 9)] };
  const out = createStore(tmpFile()).move(doc, 'nope', 'up');
  assert.deepStrictEqual(out.projects.map(p => [p.id, p.priority]), [['a', 0], ['b', 1]]);
});
