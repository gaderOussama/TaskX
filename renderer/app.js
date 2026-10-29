let doc = { version: 1, projects: [] };
let saveTimer = null;

const list = document.getElementById('list');
const empty = document.getElementById('empty');

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function save() {
  try {
    await window.taskx.save(doc);
    return true;
  } catch (err) {
    alert('Could not save: ' + err.message);
    return false;
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 300);
}

function actionButton(label, ariaLabel, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.setAttribute('aria-label', ariaLabel);
  button.addEventListener('click', onClick);
  return button;
}

async function moveProject(id, direction) {
  try {
    doc = await window.taskx.move(id, direction);
    render();
  } catch (err) {
    alert('Could not move project: ' + err.message);
  }
}

async function deleteProject(project) {
  const blank = project.name.trim() === '';
  if (!blank && !confirm('Delete this project?')) return;

  const snapshot = doc.projects.map((p) => [p, p.priority]);
  doc.projects = doc.projects
    .filter((p) => p.id !== project.id)
    .sort((a, b) => a.priority - b.priority);
  doc.projects.forEach((p, i) => { p.priority = i; });

  if (!(await save())) {
    doc.projects = snapshot.map(([p]) => p);
    snapshot.forEach(([p, priority]) => { p.priority = priority; });
  }
  render();
}

function attachRow(project) {
  const row = document.createElement('li');
  row.className = 'row';
  row.dataset.id = project.id;

  const fields = document.createElement('div');
  fields.className = 'fields';
  for (const [field, placeholder] of [
    ['name', 'project name'],
    ['last', 'what I did last…'],
    ['next', "what's next…"],
  ]) {
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.field = field;
    input.placeholder = placeholder;
    input.value = project[field] ?? '';
    input.addEventListener('input', () => {
      project[field] = input.value;
      project.updatedAt = Date.now();
      scheduleSave();
    });
    input.addEventListener('blur', async () => {
      clearTimeout(saveTimer);
      await save();
    });
    fields.append(input);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(
    actionButton('↑', 'Move up', () => moveProject(project.id, 'up')),
    actionButton('↓', 'Move down', () => moveProject(project.id, 'down')),
    actionButton('×', 'Delete project', () => deleteProject(project)),
  );

  row.append(fields, actions);
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
}

async function addProject() {
  const project = {
    id: newId(),
    name: '',
    priority: doc.projects.length,
    last: '',
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
    doc = { version: 1, projects: [] };
    alert('Could not load projects: ' + err.message);
  }
  render();
  document.getElementById('add').addEventListener('click', addProject);
}

document.addEventListener('DOMContentLoaded', init);
