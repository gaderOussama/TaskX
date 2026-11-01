const invoke = window.__TAURI__.core.invoke;

const list = document.getElementById('list');
const empty = document.getElementById('empty');
const pin = document.getElementById('pin');
const last = document.getElementById('last');
const quick = document.getElementById('quick');

let doc = { version: 2, projects: [] };
let saveFailed = false;

// The expand/collapse decision lives in Rust, next to the real cursor. This is
// only the mirror the CSS reacts to: circle, popover or the full panel.
let mode = document.documentElement.dataset.mode || 'circle';
let pinned = localStorage.getItem('taskx:pinned') === '1';

// The project Last session and Quick add speak about.
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

function initial(name) {
  const text = String(name ?? '').trim();
  return text ? text[0] : '•';
}

function labelOf(project) {
  return String(project?.name ?? '').trim() || 'this project';
}

// Same id always gets the same colour, so a project is recognisable before you read it.
// Fixed hues rather than a free-running hash: neighbours must be told apart at a
// glance, and a hash alone can land two ids on the same purple.
const BADGE_HUES = [212, 268, 158, 30, 350, 190, 96, 300];
function badgeColor(id) {
  let n = 0;
  for (const ch of String(id)) n = (n * 31 + ch.codePointAt(0)) % 9973;
  return `hsl(${BADGE_HUES[n % BADGE_HUES.length]} 45% 42%)`;
}

/* ── panel ─────────────────────────────────────────────────────────────── */

function setMode(next) {
  if (next === mode) return;
  mode = next;
  document.documentElement.dataset.mode = next;
  invoke('panel_set_mode', { mode: next, instant: reduceMotion() }).catch((err) => {
    console.error('panel_set_mode failed', err);
  });
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

  // Focus moving in or out changes what counts as "busy".
  document.addEventListener('focusin', () => syncHold());
  document.addEventListener('focusout', () => setTimeout(syncHold, 0));

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

async function save() {
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

function ordered() {
  return doc.projects.slice().sort((a, b) => a.priority - b.priority);
}

/** Falls back to the first project, so the lower half is never blank for no reason. */
function selected() {
  const all = ordered();
  return all.find((p) => p.id === selectedId) || all[0] || null;
}

function select(id) {
  if (id === selectedId) return;
  selectedId = id;
  for (const row of list.children) row.classList.toggle('is-selected', row.dataset.id === id);
  renderLast();
  renderQuick();
}

function focusAction(id, action) {
  const row = Array.from(list.children).find((li) => li.dataset.id === id);
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

async function moveProject(id, direction) {
  try {
    doc = await invoke('data_move', { id, direction });
    render();
    focusAction(id, direction);
  } catch (err) {
    alert('Could not move project: ' + err);
  }
}

async function deleteProject(project) {
  const blank = String(project.name ?? '').trim() === '';
  if (!blank && !confirm('Delete this project?')) return;

  const index = Array.from(list.children).findIndex((li) => li.dataset.id === project.id);
  const snapshot = doc.projects.map((p) => [p, p.priority]);
  doc.projects = doc.projects
    .filter((p) => p.id !== project.id)
    .sort((a, b) => a.priority - b.priority);
  doc.projects.forEach((p, i) => { p.priority = i; });
  drafts.delete(project.id);

  if (!(await save())) {
    doc.projects = snapshot.map(([p]) => p);
    snapshot.forEach(([p, priority]) => { p.priority = priority; });
  }
  render();
  const nearest = list.children[Math.min(index, list.children.length - 1)];
  focusAction(nearest && nearest.dataset.id, 'delete');
}

/* ── rows ──────────────────────────────────────────────────────────────── */

function attachRow(project) {
  const row = document.createElement('li');
  row.className = 'row';
  row.dataset.id = project.id;
  row.classList.toggle('is-selected', project.id === selectedId);

  const head = document.createElement('div');
  head.className = 'row-head';

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.setAttribute('aria-hidden', 'true');
  badge.style.background = badgeColor(project.id);
  badge.textContent = initial(project.name);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'name';
  nameInput.dataset.field = 'name';
  nameInput.placeholder = 'project name';
  nameInput.value = String(project.name ?? '');
  nameInput.addEventListener('input', () => {
    project.name = nameInput.value;
    project.updatedAt = Date.now();
    badge.textContent = initial(nameInput.value);
    save();
  });

  head.append(badge, nameInput);

  const nextInput = document.createElement('input');
  nextInput.type = 'text';
  nextInput.className = 'next';
  nextInput.dataset.field = 'next';
  nextInput.placeholder = "what's next…";
  nextInput.value = String(project.next ?? '');
  nextInput.addEventListener('input', () => {
    project.next = nextInput.value;
    project.updatedAt = Date.now();
    save();
  });

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(
    actionButton('↑', 'Move up', 'up', () => moveProject(project.id, 'up')),
    actionButton('↓', 'Move down', 'down', () => moveProject(project.id, 'down')),
    actionButton('×', 'Delete project', 'delete', () => deleteProject(project)),
  );

  row.append(head, nextInput, actions);
  row.addEventListener('focusin', () => select(project.id));
  row.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    select(project.id);
  });

  nameInput.setAttribute('aria-label', `Name of ${labelOf(project)}`);
  nextInput.setAttribute('aria-label', `What's next for ${labelOf(project)}`);

  return row;
}

/* ── last session ──────────────────────────────────────────────────────── */

function emptyNote(text) {
  const p = document.createElement('p');
  p.className = 'note';
  p.textContent = text;
  return p;
}

function renderLast() {
  const project = selected();
  last.textContent = '';

  if (!project) {
    last.append(emptyNote('Add a project to start a log.'));
    return;
  }

  const entries = project.entries || [];
  const newest = entries[entries.length - 1];
  if (!newest) {
    last.append(emptyNote(`Nothing logged on ${labelOf(project)} yet.`));
    return;
  }

  const meta = document.createElement('div');
  meta.className = 'last-meta';
  meta.textContent = `${labelOf(project)} · ${stamp(newest.at)}`;

  const what = document.createElement('p');
  what.className = 'last-what';
  what.textContent = newest.text;

  last.append(meta, what);

  const older = entries.length - 1;
  if (older < 1) return;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'toggle';
  toggle.textContent = `${older} earlier ▾`;
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', `Show ${older} earlier entries for ${labelOf(project)}`);

  const history = document.createElement('ol');
  history.className = 'history';
  history.hidden = true;

  const fill = () => {
    history.textContent = '';
    for (const entry of entries.slice(0, -1).reverse()) {
      const item = document.createElement('li');

      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = stamp(entry.at);

      const text = document.createElement('span');
      text.className = 'what';
      text.textContent = entry.text;

      item.append(when, text);

      // Entries logged before this field existed simply have no next step.
      if (entry.next) {
        const after = document.createElement('span');
        after.className = 'next';
        after.textContent = entry.next;
        item.append(after);
      }
      history.append(item);
    }
  };

  toggle.addEventListener('click', () => {
    history.hidden = !history.hidden;
    toggle.setAttribute('aria-expanded', String(!history.hidden));
    toggle.textContent = history.hidden ? `${older} earlier ▾` : `${older} earlier ▴`;
    if (!history.hidden) fill();
  });

  last.append(toggle, history);
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

  const entries = project.entries || (project.entries = []);
  const newest = entries[entries.length - 1];
  if (newest && newest.text === text) {
    quick.value = '';
    drafts.delete(project.id);
    return;
  }

  const snapshot = entries.slice();
  // Keep the next step as it stood at this moment: history stays a narrative,
  // not just a list of things that happened.
  entries.push({ at: Date.now(), text, next: String(project.next ?? '').trim() });
  project.updatedAt = Date.now();
  quick.value = '';
  drafts.delete(project.id);
  if (!(await save())) project.entries = snapshot;
  renderLast();
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
      // Escape here is for the draft, not for closing the panel.
      event.stopPropagation();
      if (quick.value === '') quick.blur();
      else {
        quick.value = '';
        const project = selected();
        if (project) drafts.delete(project.id);
        syncHold();
      }
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commit();
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

  renderLast();
  renderQuick();
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
  const snapshot = doc.projects.slice();
  doc.projects.push(project);
  if (!(await save())) {
    doc.projects = snapshot;
    return;
  }
  selectedId = project.id;
  render();
  const row = Array.from(list.children).find((li) => li.dataset.id === project.id);
  if (row) row.querySelector('input').focus();
}

async function init() {
  wirePanel();
  wireQuick();

  // The panel decides when it opens; this only mirrors the decision into CSS.
  await window.__TAURI__.event.listen('panel:state', (event) => {
    mode = String(event.payload);
    document.documentElement.dataset.mode = mode;
  });

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

  document.getElementById('add').addEventListener('click', () => { setMode('panel'); addProject(); });
  document.getElementById('add-empty').addEventListener('click', addProject);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
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
