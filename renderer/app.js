let doc = { version: 2, projects: [] };
let saveFailed = false;

const list = document.getElementById('list');
const empty = document.getElementById('empty');
// Uncommitted text in a "what I did" box, so a re-render (move/delete/add) cannot eat it.
const drafts = new Map();

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

// Same id always gets the same colour, so a project is recognisable before you read it.
// Fixed hues rather than a free-running hash: neighbours must be told apart at a
// glance, and a hash alone can land two ids on the same purple.
const BADGE_HUES = [212, 268, 158, 30, 350, 190, 96, 300];
function badgeColor(id) {
  let n = 0;
  for (const ch of String(id)) n = (n * 31 + ch.codePointAt(0)) % 9973;
  return `hsl(${BADGE_HUES[n % BADGE_HUES.length]} 45% 42%)`;
}

async function save() {
  try {
    await window.taskx.save(doc);
    saveFailed = false;
    return true;
  } catch (err) {
    if (!saveFailed) alert('Could not save: ' + err.message);
    saveFailed = true;
    return false;
  }
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
    doc = await window.taskx.move(id, direction);
    render();
    focusAction(id, direction);
  } catch (err) {
    alert('Could not move project: ' + err.message);
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

function attachRow(project) {
  const row = document.createElement('li');
  row.className = 'row';
  row.dataset.id = project.id;

  const fields = document.createElement('div');
  fields.className = 'fields';

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.setAttribute('aria-hidden', 'true');
  badge.style.background = badgeColor(project.id);
  badge.textContent = initial(project.name);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.dataset.field = 'name';
  nameInput.placeholder = 'project name';
  nameInput.value = String(project.name ?? '');
  nameInput.addEventListener('input', () => {
    project.name = nameInput.value;
    project.updatedAt = Date.now();
    badge.textContent = initial(nameInput.value);
    save();
  });

  const nameRow = document.createElement('div');
  nameRow.className = 'name-row';
  nameRow.append(badge, nameInput);

  const nextInput = document.createElement('input');
  nextInput.type = 'text';
  nextInput.dataset.field = 'next';
  nextInput.placeholder = "what's next…";
  nextInput.value = String(project.next ?? '');
  nextInput.addEventListener('input', () => {
    project.next = nextInput.value;
    project.updatedAt = Date.now();
    save();
  });

  const nextMark = document.createElement('span');
  nextMark.className = 'marker';
  nextMark.setAttribute('aria-hidden', 'true');
  nextMark.textContent = '→';

  const nextRow = document.createElement('div');
  nextRow.className = 'field-line next-row';
  nextRow.append(nextMark, nextInput);

  const didInput = document.createElement('input');
  didInput.type = 'text';
  didInput.dataset.field = 'did';
  didInput.value = drafts.get(project.id) || '';
  didInput.addEventListener('input', () => {
    if (didInput.value === '') drafts.delete(project.id);
    else drafts.set(project.id, didInput.value);
  });
  // Committed only on Enter: a half-typed line is never logged.
  didInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (didInput.value === '') didInput.blur();
      else { didInput.value = ''; drafts.delete(project.id); }
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    logEntry();
  });

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'toggle';
  toggle.addEventListener('click', () => {
    history.hidden = !history.hidden;
    toggle.setAttribute('aria-expanded', String(!history.hidden));
    refresh();
  });

  const history = document.createElement('ol');
  history.className = 'history';
  history.hidden = true;

  const refresh = () => {
    const entries = project.entries || [];
    const newest = entries[entries.length - 1];
    const label = String(project.name ?? '').trim() || 'new project';
    didInput.placeholder = newest
      ? `what I did — last: ${newest.text}`
      : 'what I did — press Enter';
    didInput.setAttribute('aria-label', `Log what I did on ${label}`);
    nextInput.setAttribute('aria-label', `What's next for ${label}`);
    nameInput.setAttribute('aria-label', `Name of ${label}`);

    const older = Math.max(0, entries.length - 1);
    toggle.hidden = older < 1;
    toggle.textContent = `${older} earlier ▾`;
    toggle.setAttribute('aria-label', `Show ${older} earlier entries for ${label}`);

    if (history.hidden) return;
    history.textContent = '';
    for (const entry of entries.slice(0, -1).reverse()) {
      const item = document.createElement('li');

      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = stamp(entry.at);

      const what = document.createElement('span');
      what.className = 'what';
      what.textContent = entry.text;

      item.append(when, what);

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

  async function logEntry() {
    const text = didInput.value.trim();
    if (text === '') return;
    const entries = project.entries || [];
    const newest = entries[entries.length - 1];
    if (newest && newest.text === text) {
      didInput.value = '';
      drafts.delete(project.id);
      return;
    }

    const snapshot = entries.slice();
    // Keep the next step as it stood at this moment: history stays a narrative,
    // not just a list of things that happened.
    entries.push({ at: Date.now(), text, next: String(project.next ?? '').trim() });
    project.updatedAt = Date.now();
    didInput.value = '';
    drafts.delete(project.id);
    if (!(await save())) {
      project.entries = snapshot;
    }
    refresh();
  }

  const didMark = document.createElement('span');
  didMark.className = 'marker';
  didMark.setAttribute('aria-hidden', 'true');
  didMark.textContent = '✓';

  const didRow = document.createElement('div');
  didRow.className = 'field-line did-row';
  didRow.append(didMark, didInput, toggle);

  fields.append(nameRow, nextRow, didRow, history);

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(
    actionButton('↑', 'Move up', 'up', () => moveProject(project.id, 'up')),
    actionButton('↓', 'Move down', 'down', () => moveProject(project.id, 'down')),
    actionButton('×', 'Delete project', 'delete', () => deleteProject(project)),
  );

  row.append(fields, actions);
  refresh();
  return row;
}

function render() {
  const projects = doc.projects.slice().sort((a, b) => a.priority - b.priority);
  const scroll = list.scrollTop;
  list.textContent = '';
  for (const project of projects) list.append(attachRow(project));
  list.scrollTop = scroll;
  empty.hidden = projects.length > 0;
  list.hidden = projects.length === 0;
  // Empty state carries its own call to action; the toolbar would be a second, identical one.
  document.querySelector('.toolbar').hidden = projects.length === 0;
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
  render();
  const row = Array.from(list.children).find((li) => li.dataset.id === project.id);
  if (row) row.querySelector('input').focus();
}

async function init() {
  try {
    doc = await window.taskx.load();
  } catch (err) {
    doc = { version: 2, projects: [] };
    alert('Could not load projects: ' + err.message);
  }
  render();
  document.getElementById('add').addEventListener('click', addProject);
  document.getElementById('add-empty').addEventListener('click', addProject);
  document.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || event.altKey || event.shiftKey) return;
    if (event.key.toLowerCase() !== 'n') return;
    event.preventDefault();
    addProject();
  });
}

document.addEventListener('DOMContentLoaded', init);
