const invoke = window.__TAURI__.core.invoke;

const list = document.getElementById('list');
const empty = document.getElementById('empty');
const pin = document.getElementById('pin');
const log = document.getElementById('log');
const quick = document.getElementById('quick');
const detailName = document.getElementById('detail-name');
const detailNext = document.getElementById('detail-next');
const detailDone = document.getElementById('detail-done');

let doc = { version: 2, projects: [] };
let saveFailed = false;

// The expand/collapse decision lives in Rust, next to the real cursor. This is
// only the mirror the CSS reacts to: circle, popover or the full panel.
let mode = document.documentElement.dataset.mode || 'circle';
let pinned = localStorage.getItem('taskx:pinned') === '1';

// The project the card, the log and Quick add speak about.
let selectedId = null;

// Uncommitted text per project, so re-renders and switching projects cannot eat it.
const drafts = new Map();

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function stamp(at) {
  return new Date(at).toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/** How long since this was touched, in the fewest characters that still read. */
function age(at) {
  const minutes = Math.floor((Date.now() - at) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 14 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

function labelOf(project) {
  return String(project?.name ?? '').trim() || 'this project';
}

const newest = (project) => (project.entries || []).at(-1);

/* ── panel ─────────────────────────────────────────────────────────────── */

function setMode(next) {
  if (next === mode) return;
  mode = next;
  document.documentElement.dataset.mode = next;
  invoke('panel_set_mode', { mode: next, instant: reduceMotion() }).catch((err) => {
    console.error('panel_set_mode failed', err);
  });
  fitCard();
}

/** The card is as tall as its rows and the log field; Rust resizes the window to match. */
function fitCard() {
  if (mode !== 'popover') return;
  const content = getComputedStyle(document.querySelector('.panel-content'));
  const height = 2 // the panel's border
    + document.querySelector('.bar').offsetHeight
    + parseFloat(content.paddingTop) + parseFloat(content.paddingBottom)
    + (list.hidden ? empty.offsetHeight : list.scrollHeight)
    + parseFloat(getComputedStyle(quick).marginTop) + quick.offsetHeight;
  invoke('panel_set_card_height', { height: Math.ceil(height) }).catch(() => {});
}

/** Never collapse under someone who is typing or holding an unsaved line. */
function busy() {
  const el = document.activeElement;
  const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  return Boolean(typing) || drafts.size > 0;
}

/// Pinned or mid-sentence: tell the watcher to leave the panel alone.
function syncHold() {
  invoke('panel_set_hold', { hold: pinned || busy() }).catch(() => {});
}

function syncPin() {
  pin.setAttribute('aria-pressed', String(pinned));
  pin.setAttribute('aria-label', pinned ? 'Unpin panel' : 'Pin panel open');
  pin.title = pinned ? 'Unpin' : 'Pin open';
  localStorage.setItem('taskx:pinned', pinned ? '1' : '0');
}

function wirePanel() {
  syncPin();

  // Focus moving in or out changes what counts as "busy". Leaving a field is
  // also the moment a debounced save should land.
  document.addEventListener('focusin', () => syncHold());
  document.addEventListener('focusout', () => {
    if (saveTimer) save();
    setTimeout(syncHold, 0);
  });

  pin.addEventListener('click', () => {
    pinned = !pinned;
    syncPin();
    syncHold();
    if (pinned) setMode('panel');
  });

  document.getElementById('collapse').addEventListener('click', () => setMode('circle'));
  document.getElementById('expand').addEventListener('click', () => setMode('panel'));
  document.getElementById('logo').addEventListener('click', () => {
    setMode(mode === 'circle' ? 'popover' : 'circle');
  });
}

/* ── data ──────────────────────────────────────────────────────────────── */

// Saves run one after another, never two at once: they share one temp file.
let saving = Promise.resolve(true);
let saveTimer = null;

async function write() {
  try {
    await invoke('data_save', { doc });
    saveFailed = false;
    return true;
  } catch (err) {
    if (!saveFailed) alert('Could not save: ' + err);
    saveFailed = true;
    return false;
  }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  saving = saving.then(write);
  return saving;
}

// ponytail: typing saves 300 ms after the last key; quitting from the tray
// inside that window loses those keys. Flush on quit if it ever matters.
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 300);
}

/** Important first, then the rest; your own order inside each group. */
function ordered() {
  return doc.projects
    .slice()
    .sort((a, b) => Number(Boolean(b.star)) - Number(Boolean(a.star)) || a.priority - b.priority);
}

/** Falls back to the first project, so the card is never blank for no reason. */
function selected() {
  const all = ordered();
  return all.find((p) => p.id === selectedId) || all[0] || null;
}

function select(id) {
  if (id === selectedId) return;
  selectedId = id;
  for (const row of list.children) row.classList.toggle('is-selected', row.dataset.id === id);
  renderDetail();
  renderQuick();
  fitCard();
}

function rowOf(id) {
  return Array.from(list.children).find((li) => li.dataset.id === id);
}

function focusAction(id, action) {
  const row = rowOf(id);
  const button = row && row.querySelector(`[data-action="${action}"]`);
  (button || document.getElementById('add')).focus();
}

function actionButton(label, ariaLabel, action, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.dataset.action = action;
  button.setAttribute('aria-label', ariaLabel);
  button.addEventListener('click', onClick);
  return button;
}

/**
 * Saves a structural change, or puts every project back the way it was.
 * Changes must replace `entries` rather than push into it: the snapshot is shallow.
 */
async function commitOrRollback(change) {
  const snapshot = doc.projects.map((p) => ({ ...p }));
  change();
  if (await save()) return true;
  doc.projects = snapshot;
  // The rows still hold the discarded objects; rebuild them on the restored ones.
  render();
  return false;
}

/** Moves stay inside their group: a starred project never sinks below a plain one. */
async function moveProject(id, direction) {
  const all = ordered();
  const from = all.findIndex((p) => p.id === id);
  const to = direction === 'up' ? from - 1 : from + 1;
  const a = all[from];
  const b = all[to];
  if (!a || !b || Boolean(a.star) !== Boolean(b.star)) return;

  await commitOrRollback(() => {
    [all[from], all[to]] = [b, a];
    all.forEach((p, i) => { p.priority = i; });
  });
  render();
  focusAction(id, direction);
}

async function toggleStar(project) {
  await commitOrRollback(() => {
    project.star = !project.star;
    project.updatedAt = Date.now();
  });
  render();
  focusAction(project.id, 'star');
}

/** The next step is done: it becomes the newest log entry and the field clears for the one after. */
async function markDone(project) {
  const text = String(project.next ?? '').trim();
  if (!text) return;
  await commitOrRollback(() => {
    project.entries = [...(project.entries || []), { at: Date.now(), text }];
    project.next = '';
    project.updatedAt = Date.now();
  });
  render();
  const field = mode === 'panel' ? detailNext : rowOf(project.id)?.querySelector('.next');
  field?.focus();
}

// The themed stand-in for confirm(): a native <dialog>, centred by the browser.
function ask(text) {
  const dialog = document.getElementById('ask');
  document.getElementById('ask-text').textContent = text;
  dialog.returnValue = '';
  dialog.showModal();
  dialog.querySelector('[value="no"]').focus();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), { once: true });
  });
}

async function deleteProject(project) {
  const name = String(project.name ?? '').trim();
  if (name && !(await ask(`Delete "${name}" and its whole log?`))) return;

  const index = Array.from(list.children).findIndex((li) => li.dataset.id === project.id);
  const ok = await commitOrRollback(() => {
    doc.projects = ordered().filter((p) => p.id !== project.id);
    doc.projects.forEach((p, i) => { p.priority = i; });
  });
  if (ok) drafts.delete(project.id);
  render();
  const nearest = list.children[Math.min(index, list.children.length - 1)];
  focusAction(nearest && nearest.dataset.id, 'delete');
}

/** The next step is shown in the row and in the dashboard; typing in one updates the other. */
function setNext(project, value, source) {
  project.next = value;
  project.updatedAt = Date.now();
  const row = rowOf(project.id);
  const rowNext = row && row.querySelector('.next');
  if (rowNext && rowNext !== source) rowNext.value = value;
  if (row) row.querySelector('.done').disabled = value.trim() === '';
  if (project === selected()) {
    if (detailNext !== source) detailNext.value = value;
    detailDone.disabled = value.trim() === '';
  }
  saveSoon();
}

/* ── rows ──────────────────────────────────────────────────────────────── */

function attachRow(project) {
  const row = document.createElement('li');
  row.className = 'row';
  row.dataset.id = project.id;
  row.classList.toggle('is-selected', project.id === selectedId);
  row.classList.toggle('is-star', Boolean(project.star));

  // Line 1: importance, name, how long since the last entry.
  const head = document.createElement('div');
  head.className = 'row-head';

  const star = document.createElement('button');
  star.type = 'button';
  star.className = 'star';
  star.dataset.action = 'star';
  star.textContent = project.star ? '★' : '☆';
  star.setAttribute('aria-pressed', String(Boolean(project.star)));
  star.setAttribute('aria-label', `Mark ${labelOf(project)} important`);
  star.title = project.star ? 'Important' : 'Mark important';
  star.addEventListener('click', () => toggleStar(project));

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'name';
  nameInput.placeholder = 'project name';
  nameInput.value = String(project.name ?? '');
  nameInput.setAttribute('aria-label', `Name of ${labelOf(project)}`);
  nameInput.addEventListener('input', () => {
    project.name = nameInput.value;
    project.updatedAt = Date.now();
    if (project === selected()) detailName.textContent = labelOf(project);
    saveSoon();
  });

  const when = document.createElement('span');
  when.className = 'age';
  const last = newest(project);
  when.textContent = last ? age(last.at) : '';
  if (last) when.title = stamp(last.at);

  head.append(star, nameInput, when);

  // Line 2: what's next, with the box that marks it done.
  const nextLine = document.createElement('div');
  nextLine.className = 'next-line';

  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'done';
  done.setAttribute('aria-label', `Mark next step for ${labelOf(project)} done`);
  done.title = 'Done';
  done.disabled = String(project.next ?? '').trim() === '';
  done.addEventListener('click', () => markDone(project));

  const nextInput = document.createElement('input');
  nextInput.type = 'text';
  nextInput.className = 'next';
  nextInput.placeholder = "what's next…";
  nextInput.value = String(project.next ?? '');
  nextInput.setAttribute('aria-label', `What's next for ${labelOf(project)}`);
  nextInput.addEventListener('input', () => setNext(project, nextInput.value, nextInput));

  nextLine.append(done, nextInput);

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(
    actionButton('↑', 'Move up', 'up', () => moveProject(project.id, 'up')),
    actionButton('↓', 'Move down', 'down', () => moveProject(project.id, 'down')),
    actionButton('×', 'Delete project', 'delete', () => deleteProject(project)),
  );

  row.append(head, nextLine);

  // Line 3: the last thing done, so where you left off is visible without opening anything.
  if (last) {
    const did = document.createElement('p');
    did.className = 'did';
    did.textContent = last.text;
    did.title = `${stamp(last.at)} — ${last.text}`;
    row.append(did);
  }

  row.append(actions);
  row.addEventListener('focusin', () => select(project.id));
  row.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    select(project.id);
  });

  return row;
}

/* ── dashboard detail ──────────────────────────────────────────────────── */

function emptyNote(text) {
  const li = document.createElement('li');
  li.className = 'note';
  li.textContent = text;
  return li;
}

function renderDetail() {
  const project = selected();
  log.textContent = '';
  detailName.textContent = project ? labelOf(project) : '';
  detailNext.disabled = !project;
  detailNext.value = project ? String(project.next ?? '') : '';
  detailDone.disabled = !project || detailNext.value.trim() === '';

  if (!project) {
    log.append(emptyNote('Add a project to start a log.'));
    return;
  }

  const entries = project.entries || [];
  if (entries.length === 0) {
    log.append(emptyNote(`Nothing logged on ${labelOf(project)} yet.`));
    return;
  }

  for (const entry of entries.slice().reverse()) {
    const item = document.createElement('li');

    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = stamp(entry.at);

    const text = document.createElement('span');
    text.className = 'what';
    text.textContent = entry.text;

    item.append(when, text);

    // What the next step was when this was logged; older entries have none.
    if (entry.next) {
      const after = document.createElement('span');
      after.className = 'then';
      after.textContent = entry.next;
      item.append(after);
    }
    log.append(item);
  }
}

/* ── quick add ─────────────────────────────────────────────────────────── */

function renderQuick() {
  const project = selected();
  quick.disabled = !project;
  quick.value = project ? drafts.get(project.id) || '' : '';
  quick.placeholder = project
    ? `What did you do on ${labelOf(project)}?`
    : 'Add a project first';
  quick.setAttribute('aria-label', project ? `Log what I did on ${labelOf(project)}` : 'Quick add');
}

async function commit() {
  const project = selected();
  const text = quick.value.trim();
  if (!project || text === '') return;

  if (newest(project)?.text !== text) {
    // Keep the next step as it stood at this moment: history stays a narrative,
    // not just a list of things that happened.
    const ok = await commitOrRollback(() => {
      project.entries = [...(project.entries || []), {
        at: Date.now(), text, next: String(project.next ?? '').trim(),
      }];
      project.updatedAt = Date.now();
    });
    if (!ok) return;
  }
  quick.value = '';
  drafts.delete(project.id);
  render();
  quick.focus();
  syncHold();
}

function wireQuick() {
  quick.addEventListener('input', () => {
    const project = selected();
    if (!project) return;
    if (quick.value === '') drafts.delete(project.id);
    else drafts.set(project.id, quick.value);
    syncHold();
  });

  // Committed only on Enter: a half-typed line is never logged.
  quick.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      // The first Escape drops the draft; with nothing left it closes the card.
      if (quick.value === '') {
        quick.blur();
        return;
      }
      event.stopPropagation();
      quick.value = '';
      const project = selected();
      if (project) drafts.delete(project.id);
      syncHold();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commit();
  });

  detailNext.addEventListener('input', () => {
    const project = selected();
    if (project) setNext(project, detailNext.value, detailNext);
  });
  detailDone.addEventListener('click', () => {
    const project = selected();
    if (project) markDone(project);
  });
}

/* ── render ────────────────────────────────────────────────────────────── */

function render() {
  const all = ordered();
  if (!all.some((p) => p.id === selectedId)) selectedId = all[0] ? all[0].id : null;

  const scroll = list.scrollTop;
  list.textContent = '';
  for (const project of all) list.append(attachRow(project));
  list.scrollTop = scroll;

  const none = all.length === 0;
  empty.hidden = !none;
  list.hidden = none;

  renderDetail();
  renderQuick();
  fitCard();
}

async function addProject() {
  const project = {
    id: newId(),
    name: '',
    priority: doc.projects.length,
    entries: [],
    next: '',
    updatedAt: Date.now(),
  };
  if (!(await commitOrRollback(() => doc.projects.push(project)))) return;
  selectedId = project.id;
  render();
  rowOf(project.id)?.querySelector('.name').focus();
}

async function init() {
  wirePanel();
  wireQuick();

  // The panel decides when it opens; this only mirrors the decision into CSS.
  await window.__TAURI__.event.listen('panel:state', (event) => {
    mode = String(event.payload);
    document.documentElement.dataset.mode = mode;
    fitCard();
  });
  // Summoned by Alt+X or the tray: ready to type the log line straight away.
  await window.__TAURI__.event.listen('panel:focus', () => quick.focus());

  await invoke('panel_set_reduced', { reduced: reduceMotion() });
  syncHold();
  // A pinned panel comes back open, because that is what pinning asked for.
  if (pinned) invoke('panel_set_mode', { mode: 'panel', instant: true }).catch(() => {});

  try {
    doc = await invoke('data_load');
  } catch (err) {
    doc = { version: 2, projects: [] };
    alert('Could not load projects: ' + err);
  }
  render();

  // Ages ("2h") drift while the panel sits open; a minute is fine-grained enough.
  setInterval(() => {
    for (const row of list.children) {
      const project = doc.projects.find((p) => p.id === row.dataset.id);
      const last = project && newest(project);
      if (last) row.querySelector('.age').textContent = age(last.at);
    }
  }, 60000);

  document.getElementById('add').addEventListener('click', () => { setMode('panel'); addProject(); });
  document.getElementById('add-empty').addEventListener('click', addProject);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      // Escape in the dialog only closes the dialog.
      if (document.getElementById('ask').open) return;
      setMode('circle');
      return;
    }
    if (!event.ctrlKey || event.altKey || event.shiftKey) return;
    if (event.key.toLowerCase() !== 'n') return;
    event.preventDefault();
    setMode('panel');
    addProject();
  });
}

document.addEventListener('DOMContentLoaded', init);
