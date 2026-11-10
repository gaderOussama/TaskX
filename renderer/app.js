const invoke = window.__TAURI__.core.invoke;

const list = document.getElementById('list');
const empty = document.getElementById('empty');
const pin = document.getElementById('pin');
const log = document.getElementById('log');
const quick = document.getElementById('quick');
const detailName = document.getElementById('detail-name');
const detailNext = document.getElementById('detail-next');
const detailDone = document.getElementById('detail-done');
const detail = document.querySelector('.detail');
const detailArea = document.getElementById('detail-area');
const detailNote = document.getElementById('detail-note');
const welcome = document.getElementById('welcome');
const ideasSum = document.getElementById('ideas-sum');
const ideasList = document.getElementById('ideas-list');
const ideaInput = document.getElementById('idea');
const capture = document.getElementById('capture');
const topBar = document.querySelector('.top');
const areasNav = document.getElementById('areas');
const areasList = document.getElementById('areas-list');
const inboxRow = document.getElementById('inbox-row');
const inboxList = document.getElementById('inbox-list');
const whisperName = document.getElementById('whisper-name');
const whisperText = document.getElementById('whisper-text');
const recapDialog = document.getElementById('recap');
const recapMsg = document.getElementById('recap-text');

let doc = { version: 3, projects: [] };
let saveFailed = false;

// The expand/collapse decision lives in Rust, next to the real cursor. This is
// only the mirror the CSS reacts to: circle, popover or the full panel.
let mode = document.documentElement.dataset.mode || 'circle';
let pinned = localStorage.getItem('taskx:pinned') === '1';

// The project the card, the log and Quick add speak about.
let selectedId = null;

// Uncommitted text per project, so re-renders and switching projects cannot eat it.
const drafts = new Map();

// The dashboard shows the inbox instead of a project while this is set.
let showInbox = false;
// The area tab in force; '' is "All". Falls back to All when no project has it any more.
let area = localStorage.getItem('taskx:area') || '';

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
const inboxOf = () => doc.inbox || [];
const ideasOf = (project) => project.ideas || [];
const areaOf = (project) => String(project.area ?? '').trim();

/* ── panel ─────────────────────────────────────────────────────────────── */

/** The inbox is a dashboard view; the card goes back to speaking about a project. */
function leaveInbox() {
  if (!showInbox) return;
  showInbox = false;
  markSelected();
  renderDetail();
}

/** Restarts the accent-to-rest fade (.flash) on an element. */
function flash(el) {
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth; // reflow, so the animation restarts
  el.classList.add('flash');
}

function setMode(next) {
  if (next === mode) return;
  mode = next;
  document.documentElement.dataset.mode = next;
  if (next !== 'panel') leaveInbox();
  invoke('panel_set_mode', { mode: next, instant: reduceMotion() }).catch((err) => {
    console.error('panel_set_mode failed', err);
  });
  render(); // the card lists every project, the dashboard only the area in force
}

/** The card is as tall as its rows and the log field; Rust resizes the window to match. */
function fitCard() {
  if (mode !== 'popover') return;
  const content = getComputedStyle(document.querySelector('.panel-content'));
  const height = 2 // the panel's border
    + document.querySelector('.bar').offsetHeight
    + parseFloat(content.paddingTop) + parseFloat(content.paddingBottom)
    + topBar.offsetHeight + inboxRow.offsetHeight
    + (list.hidden ? empty.offsetHeight : list.scrollHeight)
    + parseFloat(getComputedStyle(quick).marginTop) + quick.offsetHeight;
  invoke('panel_set_card_height', { height: Math.ceil(height) }).catch(() => {});
}

/** Never collapse under someone who is typing or holding an unsaved line. */
function busy() {
  const el = document.activeElement;
  const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  return Boolean(typing) || drafts.size > 0 || capture.value !== '';
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
    setTimeout(checkOutside, 0);
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
let queued = 0; // saves running or waiting; an outside reload must not land in between
let lastStamp = 0; // the file's mtime as of our last load or save

async function write() {
  try {
    const mtime = await invoke('data_save', { doc });
    if (typeof mtime === 'number') lastStamp = mtime;
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
  queued++;
  saving = saving.then(write).finally(() => { queued--; });
  return saving;
}

// Another program (an MCP server) may write the file. Pick that up when we are
// idle: nothing waiting to be saved, nothing half-typed, no field focused.
// ponytail: a save made while typing can still overwrite an outside write made
// in that window; merge per project by updatedAt if it ever matters.
async function checkOutside() {
  const idle = () => !saveTimer && !queued && !busy();
  if (!idle()) return;
  let stampNow;
  try {
    stampNow = await invoke('data_stamp');
  } catch {
    return;
  }
  if (stampNow === lastStamp || !idle()) return;
  try {
    const fresh = await invoke('data_load');
    if (!idle()) return; // the user moved while we were reading; try again next tick
    lastStamp = stampNow;
    doc = fresh;
    render();
  } catch (err) {
    console.error('reload failed', err);
  }
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

/** Every area in use, as first typed, without case-only duplicates. */
function areas() {
  const seen = new Map();
  for (const p of ordered()) {
    const name = areaOf(p);
    if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  return [...seen.values()];
}

function currentArea() {
  return areas().find((name) => name.toLowerCase() === area.toLowerCase()) || '';
}

/** What the card and the dashboard list: the card everything, the dashboard one area. */
function visible() {
  const key = mode === 'popover' ? '' : currentArea().toLowerCase();
  return key ? ordered().filter((p) => areaOf(p).toLowerCase() === key) : ordered();
}

/** Falls back to the first project, so the card is never blank for no reason. */
function selected() {
  return ordered().find((p) => p.id === selectedId) || visible()[0] || null;
}

function markSelected() {
  for (const row of list.children) {
    row.classList.toggle('is-selected', !showInbox && row.dataset.id === selectedId);
  }
  inboxRow.classList.toggle('is-selected', showInbox);
  renderInboxRow();
}

function select(id) {
  if (id === selectedId && !showInbox) return;
  selectedId = id;
  showInbox = false;
  ideaInput.value = '';
  markSelected();
  renderDetail();
  renderQuick();
  fitCard();
}

function setArea(name) {
  area = name;
  localStorage.setItem('taskx:area', name);
  const shown = visible();
  if (!shown.some((p) => p.id === selectedId)) selectedId = shown[0] ? shown[0].id : selectedId;
  render();
}

function openInbox() {
  showInbox = true;
  setMode('panel');
  markSelected();
  renderDetail();
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
 * Saves a structural change, or puts everything back the way it was.
 * Changes must replace `entries`, `ideas` and `inbox` rather than push into them:
 * the snapshot is shallow.
 */
async function commitOrRollback(change) {
  const snapshot = {
    projects: doc.projects.map((p) => ({ ...p })),
    inbox: [...inboxOf()],
    settings: { ...doc.settings },
  };
  change();
  if (await save()) return true;
  Object.assign(doc, snapshot);
  // The rows still hold the discarded objects; rebuild them on the restored ones.
  render();
  return false;
}

/** Moves stay inside their group, and over the rows you can see: a starred project never sinks below a plain one. */
async function moveProject(id, direction) {
  // The card hides plain projects but the selected one; moving past a hidden row would look like nothing happened.
  const shown = visible().filter((p) => mode !== 'popover' || p.star || p.id === selectedId);
  const from = shown.findIndex((p) => p.id === id);
  const a = shown[from];
  const b = shown[direction === 'up' ? from - 1 : from + 1];
  if (!a || !b || Boolean(a.star) !== Boolean(b.star)) return;

  // Swap the two in the whole order; projects hidden between them stay put.
  const all = ordered();
  await commitOrRollback(() => {
    const i = all.indexOf(a);
    const j = all.indexOf(b);
    [all[i], all[j]] = [b, a];
    all.forEach((p, k) => { p.priority = k; });
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
  syncWhisper();
  saveSoon();
}

/* ── inbox ─────────────────────────────────────────────────────────────── */

async function captureThought() {
  const text = capture.value.trim();
  if (!text) return;
  capture.value = '';
  const ok = await commitOrRollback(() => {
    doc.inbox = [...inboxOf(), { id: newId(), at: Date.now(), text }];
  });
  if (ok) {
    render();
    flash(inboxRow);
  } else capture.value = text;
  syncHold();
}

/** An empty next step takes the thought; otherwise it waits among the project's ideas. */
async function moveInbox(item, projectId) {
  const project = doc.projects.find((p) => p.id === projectId);
  if (!project) return;
  await commitOrRollback(() => {
    doc.inbox = inboxOf().filter((i) => i.id !== item.id);
    if (String(project.next ?? '').trim() === '') project.next = item.text;
    else project.ideas = [...ideasOf(project), { ...item }];
    project.updatedAt = Date.now();
  });
  render();
  flash(inboxRow);
  inboxList.focus(); // not another item's <select>: an arrow key there would move the wrong thought
}

async function dropInbox(item) {
  await commitOrRollback(() => {
    doc.inbox = inboxOf().filter((i) => i.id !== item.id);
  });
  render();
  inboxList.focus();
}

function renderInboxRow() {
  const count = inboxOf().length;
  inboxRow.hidden = count === 0 && !showInbox;
  inboxRow.textContent = count ? `Inbox · ${count}` : 'Inbox';
}

function renderInbox() {
  inboxList.textContent = '';
  if (inboxOf().length === 0) inboxList.append(emptyNote('Inbox is empty.'));
  for (const item of inboxOf()) {
    const li = document.createElement('li');

    const text = document.createElement('span');
    text.className = 'item-text';
    text.textContent = item.text;

    const when = document.createElement('span');
    when.className = 'age';
    when.textContent = age(item.at);
    when.title = stamp(item.at);

    const move = document.createElement('select');
    move.setAttribute('aria-label', 'Move to a project');
    move.append(new Option('Move to project…', ''));
    for (const p of ordered()) move.append(new Option(labelOf(p), p.id));
    move.addEventListener('change', () => moveInbox(item, move.value));

    const tools = document.createElement('div');
    tools.className = 'inbox-tools';
    tools.append(when, move, miniButton('×', 'Delete thought', () => dropInbox(item)));

    li.append(text, tools);
    inboxList.append(li);
  }
}

/* ── ideas ─────────────────────────────────────────────────────────────── */

function miniButton(label, ariaLabel, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mini';
  button.textContent = label;
  button.setAttribute('aria-label', ariaLabel);
  button.addEventListener('click', onClick);
  return button;
}

async function addIdea() {
  const project = selected();
  const text = ideaInput.value.trim();
  if (!project || !text) return;
  ideaInput.value = '';
  const ok = await commitOrRollback(() => {
    project.ideas = [...ideasOf(project), { id: newId(), at: Date.now(), text }];
    project.updatedAt = Date.now();
  });
  if (ok) render();
  else ideaInput.value = text;
}

/** An idea becomes the next step; the step it replaces goes back among the ideas. */
async function promoteIdea(project, idea) {
  await commitOrRollback(() => {
    const current = String(project.next ?? '').trim();
    project.ideas = ideasOf(project).filter((i) => i.id !== idea.id);
    if (current) project.ideas.push({ id: newId(), at: Date.now(), text: current });
    project.next = idea.text;
    project.updatedAt = Date.now();
  });
  render();
  detailNext.focus();
  flash(mode === 'panel' ? detailNext : rowOf(project.id)?.querySelector('.next'));
}

async function dropIdea(project, idea) {
  await commitOrRollback(() => {
    project.ideas = ideasOf(project).filter((i) => i.id !== idea.id);
    project.updatedAt = Date.now();
  });
  render();
  ideaInput.focus();
}

function renderIdeas(project) {
  const ideas = project ? ideasOf(project) : [];
  ideasSum.textContent = ideas.length ? `Ideas · ${ideas.length}` : 'Ideas';
  ideasList.textContent = '';
  for (const idea of ideas.slice().reverse()) {
    const li = document.createElement('li');

    const text = document.createElement('span');
    text.className = 'item-text';
    text.textContent = idea.text;

    li.append(
      text,
      miniButton('↑ next', 'Make this the next step', () => promoteIdea(project, idea)),
      miniButton('×', 'Delete idea', () => dropIdea(project, idea)),
    );
    ideasList.append(li);
  }
}

/* ── areas ─────────────────────────────────────────────────────────────── */

let areasKey = '';

/** Tabs only exist once a project has an area; rebuilt only when they would change. */
function renderAreas() {
  const names = areas();
  const key = `${names.join('\n')}|${currentArea()}`;
  if (key === areasKey) return;
  areasKey = key;

  areasNav.hidden = names.length === 0;
  areasNav.textContent = '';
  if (names.length) {
    for (const name of ['', ...names]) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.textContent = name || 'All';
      tab.setAttribute('aria-pressed', String(name === currentArea()));
      tab.addEventListener('click', () => {
        setArea(name);
        areasNav.querySelector('[aria-pressed="true"]')?.focus();
      });
      areasNav.append(tab);
    }
  }
  areasList.replaceChildren(...names.map((name) => new Option(name)));
}

/* ── whisper ───────────────────────────────────────────────────────────── */

let whisperOn = false;

/** The first project with a next step, shown beside the resting tile when the tray setting is on. */
function syncWhisper() {
  const project = doc.settings?.whisper
    ? ordered().find((p) => String(p.next ?? '').trim() !== '')
    : null;
  if (project) {
    whisperName.textContent = labelOf(project);
    whisperText.textContent = String(project.next).trim();
  }
  if (Boolean(project) === whisperOn) return;
  whisperOn = Boolean(project);
  // The window widens first, then the strip appears: the tile never stretches.
  invoke('panel_set_whisper', { on: whisperOn })
    .catch(() => {})
    .finally(() => document.documentElement.toggleAttribute('data-whisper', whisperOn));
}

/* ── recap ─────────────────────────────────────────────────────────────── */

const clock = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const dayLabel = (at) => {
  const d = new Date(at);
  const part = (opts) => d.toLocaleDateString(undefined, opts);
  return `${part({ weekday: 'short' })} ${d.getDate()} ${part({ month: 'short' })}`;
};

/** Markdown of what was logged, grouped by project, oldest first. Empty when nothing was. */
function recapOf(week) {
  const from = week ? Date.now() - 7 * 864e5 : new Date().setHours(0, 0, 0, 0);
  const when = week ? dayLabel : clock;
  return ordered().map((project) => {
    const lines = (project.entries || [])
      .filter((entry) => entry.at >= from)
      .sort((a, b) => a.at - b.at)
      .map((entry) => `- ${when(entry.at)} ${entry.text}`);
    return lines.length ? `## ${labelOf(project)}\n${lines.join('\n')}` : '';
  }).filter(Boolean).join('\n\n');
}

async function copyRecap(week) {
  const text = recapOf(week);
  if (!text) {
    recapMsg.textContent = 'Nothing logged';
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    recapMsg.textContent = 'Could not copy';
    return;
  }
  recapMsg.textContent = 'Copied';
  setTimeout(() => recapDialog.close(), 700);
}

function openRecap() {
  recapMsg.textContent = 'Copy your log as Markdown.';
  recapDialog.showModal();
}

/* ── rows ──────────────────────────────────────────────────────────────── */

function attachRow(project) {
  const row = document.createElement('li');
  row.className = 'row';
  row.dataset.id = project.id;
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
    if (project === selected() && !showInbox) detailName.textContent = labelOf(project);
    syncWhisper();
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
  detail.dataset.view = showInbox ? 'inbox' : 'project';
  if (showInbox) {
    detailName.textContent = 'Inbox';
    renderInbox();
    return;
  }

  log.textContent = '';
  detailName.textContent = project ? labelOf(project) : '';
  detailNext.disabled = !project;
  detailNext.value = project ? String(project.next ?? '') : '';
  detailDone.disabled = !project || detailNext.value.trim() === '';
  detailArea.disabled = detailNote.disabled = ideaInput.disabled = !project;
  detailArea.value = project ? String(project.area ?? '') : '';
  detailNote.value = project ? String(project.note ?? '') : '';
  renderIdeas(project);

  // After a few days away, say so once; the next step and the log below are the answer.
  const last = project && newest(project);
  const days = last ? Math.floor((Date.now() - last.at) / 864e5) : 0;
  welcome.hidden = days < 3;
  if (days >= 3) {
    welcome.textContent = `Back after ${days < 14 ? `${days} days` : `${Math.floor(days / 7)} weeks`}.`;
  }

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

/** The first Escape drops what is typed; with nothing left it closes the card. */
function dropOnEscape(event, input, onDrop) {
  if (event.key !== 'Escape') return false;
  if (input.value === '') {
    input.blur();
    return true;
  }
  event.stopPropagation();
  input.value = '';
  onDrop();
  return true;
}

function wireCapture() {
  capture.addEventListener('input', syncHold);
  capture.addEventListener('keydown', (event) => {
    if (dropOnEscape(event, capture, syncHold)) return;
    if (event.key !== 'Enter') return;
    event.preventDefault();
    captureThought();
  });
  inboxRow.addEventListener('click', openInbox);
}

/** Area, note and ideas of the project in the dashboard. */
function wireDetail() {
  detailArea.addEventListener('input', () => {
    const project = selected();
    if (!project) return;
    project.area = detailArea.value;
    project.updatedAt = Date.now();
    saveSoon();
  });
  // Tabs and the filter follow the edit once it is finished, not on every key.
  detailArea.addEventListener('change', () => {
    const project = selected();
    if (!project) return;
    if (currentArea() && areaOf(project).toLowerCase() !== currentArea().toLowerCase()) {
      setArea(areaOf(project));
    } else {
      renderAreas();
    }
  });

  detailNote.addEventListener('input', () => {
    const project = selected();
    if (!project) return;
    project.note = detailNote.value;
    project.updatedAt = Date.now();
    saveSoon();
  });

  ideaInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addIdea();
  });

  document.getElementById('recap-btn').addEventListener('click', openRecap);
  document.getElementById('recap-today').addEventListener('click', () => copyRecap(false));
  document.getElementById('recap-week').addEventListener('click', () => copyRecap(true));
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
    const dropped = () => {
      const project = selected();
      if (project) drafts.delete(project.id);
      syncHold();
    };
    if (dropOnEscape(event, quick, dropped)) return;
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
  const all = visible();
  if (!all.some((p) => p.id === selectedId)) selectedId = all[0] ? all[0].id : null;

  const scroll = list.scrollTop;
  list.textContent = '';
  for (const project of all) list.append(attachRow(project));
  list.scrollTop = scroll;

  const none = all.length === 0;
  empty.hidden = !none;
  list.hidden = none;

  renderAreas();
  markSelected();
  renderDetail();
  renderQuick();
  syncWhisper();
  fitCard();
}

async function addProject() {
  const project = {
    id: newId(),
    name: '',
    priority: doc.projects.length,
    entries: [],
    next: '',
    area: currentArea(), // joins the tab you are on, so it does not vanish from the list
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
  wireCapture();
  wireDetail();

  // The panel decides when it opens; this only mirrors the decision into CSS.
  await window.__TAURI__.event.listen('panel:state', (event) => {
    const changed = String(event.payload) !== mode; // setMode already rendered its own change
    mode = String(event.payload);
    document.documentElement.dataset.mode = mode;
    if (mode !== 'panel') leaveInbox();
    if (changed) render();
    else fitCard();
  });
  // Summoned by Alt+X or the tray: ready to type straight away, the log line or a thought.
  await window.__TAURI__.event.listen('panel:focus', (event) => {
    (event.payload === 'capture' ? capture : quick).focus();
  });
  // The tray's "next step beside the tile" switch.
  await window.__TAURI__.event.listen('settings:whisper', async (event) => {
    await commitOrRollback(() => {
      doc.settings = { ...doc.settings, whisper: Boolean(event.payload) };
    });
    syncWhisper();
  });

  await invoke('panel_set_reduced', { reduced: reduceMotion() });
  syncHold();
  // A pinned panel comes back open, because that is what pinning asked for.
  if (pinned) invoke('panel_set_mode', { mode: 'panel', instant: true }).catch(() => {});

  try {
    // The stamp first: a write landing in between only makes the next check reload once more.
    lastStamp = await invoke('data_stamp').catch(() => 0);
    doc = await invoke('data_load');
  } catch (err) {
    doc = { version: 3, projects: [] };
    alert('Could not load projects: ' + err);
  }
  render();
  setInterval(checkOutside, 2000);

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
      // Escape in a dialog only closes the dialog.
      if (document.querySelector('dialog[open]')) return;
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
