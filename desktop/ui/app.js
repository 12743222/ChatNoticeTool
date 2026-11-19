'use strict';

const state = {
  view: 'active',
  q: '',
  tasks: [],
  current: null,
  original: null,
  signature: null,
  syncSeq: 0,
};

const $ = (sel) => document.querySelector(sel);
const listEl = $('#task-list');
const syncEl = $('#sync-state');
let syncTimer = null;

async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok || data.ok === false) {
    throw new Error(data.detail || data.error || `请求失败 (${res.status})`);
  }
  return data;
}

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2400);
}

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/* ---------- time formatting ---------- */

function toInputValue(due) {
  if (!due) return '';
  return due.includes('T') ? due : due + 'T23:59';
}

function dueInfo(due) {
  if (!due) return null;
  const [datePart, timePart] = due.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(y, m - 1, d);
  const diffDays = Math.round((target - today) / 86400000);
  let cls = '';
  if (target < today) cls = 'overdue';
  else if (diffDays === 0) cls = 'today';
  let day;
  if (diffDays === 0) day = '今天';
  else if (diffDays === 1) day = '明天';
  else if (diffDays === -1) day = '昨天';
  else day = `${m}/${d}`;
  let label = day + (timePart ? ' ' + timePart : '');
  return { label, cls, overdue: cls === 'overdue', today: cls === 'today' };
}

function timeLabel(task) {
  if (!task.due) return task.due_label || '无截止时间';
  const info = dueInfo(task.due);
  let text = info.label;
  if (task.due_label) text += ' · ' + task.due_label;
  return text;
}

function timeClass(task) {
  if (!task.due) return '';
  const info = dueInfo(task.due);
  return info.cls;
}

function statusOf(task) {
  if (task.removed) return { text: '已移除', cls: 'st-removed' };
  if (task.done) return { text: '已完成', cls: 'st-done' };
  const cls = timeClass(task);
  if (cls === 'overdue' || cls === 'today') return { text: '进行中', cls: 'st-doing' };
  return { text: '待处理', cls: 'st-todo' };
}

/* ---------- loading ---------- */

function taskSignature(tasks) {
  return JSON.stringify(tasks.map((t) => [
    t.id, t.title, t.due || '', t.due_label || '', t.note || '',
    Boolean(t.optional), Boolean(t.done), Boolean(t.removed), t.updated_at || '',
  ]));
}

function applyTasks(tasks) {
  const signature = [state.view, state.q, taskSignature(tasks)].join('|');
  state.tasks = tasks;
  if (signature === state.signature) return false;
  state.signature = signature;
  renderTasks();
  return true;
}

function setSyncState(kind) {
  if (!syncEl) return;
  if (kind === 'offline') {
    syncEl.textContent = '离线';
    syncEl.classList.add('error');
    syncEl.title = '无法连接本地服务，正在重试';
    return;
  }
  if (kind === 'syncing') {
    syncEl.textContent = '同步中…';
    syncEl.classList.remove('error');
    return;
  }
  syncEl.textContent = '已同步 ' + new Date().toTimeString().slice(0, 8);
  syncEl.classList.remove('error');
  syncEl.title = '每 4 秒自动同步，窗口回到前台时立即刷新';
}

function isEditing() {
  return !$('#drawer').classList.contains('hidden')
    || !$('#modal').classList.contains('hidden');
}

async function syncTasks({ silent = false } = {}) {
  if (silent && isEditing()) return;
  const seq = ++state.syncSeq;
  if (!silent) setSyncState('syncing');
  try {
    const params = new URLSearchParams({ view: state.view, q: state.q });
    const data = await api('/todos?' + params.toString());
    if (seq !== state.syncSeq) return;
    applyTasks(data.tasks);
    setSyncState('synced');
  } catch (error) {
    if (seq !== state.syncSeq) return;
    setSyncState('offline');
    if (!silent) toast(error.message);
  }
}

function startSyncLoop() {
  clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && !isEditing()) {
      syncTasks({ silent: true });
    }
  }, 4000);
  window.addEventListener('focus', () => syncTasks({ silent: true }));
  window.addEventListener('online', () => syncTasks({ silent: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncTasks({ silent: true });
  });
}

/* ---------- rendering ---------- */

function svgEl(pathData, viewBox = '0 0 24 24') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', pathData);
  svg.append(path);
  return svg;
}

function renderTasks() {
  listEl.innerHTML = '';
  if (!state.tasks.length) {
    const empty = document.createElement('div');
    empty.className = 'wb-empty';
    empty.append(svgEl('M9 12h6M9 16h4M7 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h1z'));
    empty.append(state.view === 'active' ? '没有待办事项，气泡里拖点东西试试' : '这里还是空的');
    listEl.append(empty);
    return;
  }
  for (const task of state.tasks) {
    listEl.append(renderCard(task));
  }
}

function renderCard(task) {
  const card = document.createElement('div');
  card.className = 'wb-card' + (task.done && !task.removed ? ' completed' : '');

  const check = document.createElement('button');
  check.className = 'wb-check' + (task.done ? ' checked' : '');
  check.setAttribute('aria-label', task.done ? '标为未完成' : '标为完成');
  check.append(svgEl('m5 12 5 5L20 7', '0 0 24 24'));
  if (task.removed) check.disabled = true;
  check.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleDone(task);
  });
  card.append(check);

  const main = document.createElement('div');
  main.className = 'wb-main';
  main.addEventListener('click', () => openDrawer(task));

  const title = document.createElement('div');
  title.className = 'wb-title';
  title.textContent = task.title;
  main.append(title);

  if (task.note) {
    const note = document.createElement('div');
    note.className = 'wb-note';
    note.textContent = task.note;
    main.append(note);
  }

  const time = document.createElement('div');
  time.className = 'wb-time ' + timeClass(task);
  const clock = document.createElement('svg');
  clock.setAttribute('viewBox', '0 0 24 24');
  clock.setAttribute('fill', 'none');
  clock.setAttribute('stroke', 'currentColor');
  clock.setAttribute('stroke-width', '1.8');
  clock.setAttribute('stroke-linecap', 'round');
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '12'); circle.setAttribute('cy', '12'); circle.setAttribute('r', '8.5');
  const hands = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  hands.setAttribute('d', 'M12 7.5V12l3 2');
  clock.append(circle, hands);
  const label = document.createElement('span');
  label.textContent = timeLabel(task);
  time.append(clock, label);
  main.append(time);
  card.append(main);

  const status = statusOf(task);
  const chip = document.createElement('span');
  chip.className = 'wb-status ' + status.cls;
  chip.textContent = status.text;
  card.append(chip);

  return card;
}

/* ---------- task actions ---------- */

async function toggleDone(task) {
  try {
    await api(`/todos/${encodeURIComponent(task.id)}/done`, {
      method: 'POST',
      body: JSON.stringify({ value: !task.done }),
    });
    await syncTasks();
  } catch (error) {
    toast(error.message);
  }
}

async function setRemoved(task, removed) {
  try {
    await api(`/todos/${encodeURIComponent(task.id)}/removed`, {
      method: 'POST',
      body: JSON.stringify({ value: removed }),
    });
    toast(removed ? '已移除' : '已恢复');
    closeDrawer(false);
    await syncTasks();
  } catch (error) {
    toast(error.message);
  }
}

/* ---------- drawer ---------- */

function openDrawer(task) {
  state.current = task;
  state.original = { ...task };
  $('#f-title').value = task.title;
  $('#f-due').value = toInputValue(task.due);
  $('#f-due-label').value = task.due_label || '';
  $('#f-note').value = task.note || '';
  $('#f-optional').checked = Boolean(task.optional);
  $('#draft-warn').classList.add('hidden');
  $('#btn-delete').textContent = task.removed ? '恢复' : '移除';
  $('#btn-save').classList.toggle('hidden', Boolean(task.removed));
  $('#drawer').classList.remove('hidden');
  $('#drawer-mask').classList.remove('hidden');
}

function closeDrawer(refresh = true) {
  const wasOpen = !$('#drawer').classList.contains('hidden');
  state.current = null;
  state.original = null;
  $('#drawer').classList.add('hidden');
  $('#drawer-mask').classList.add('hidden');
  if (wasOpen && refresh) syncTasks({ silent: true });
}

async function saveDrawer() {
  if (!state.current || !state.original) return;
  const task = state.original;
  const changes = {};
  const baseline = {};

  const title = $('#f-title').value.trim();
  if (title !== task.title) { changes.title = title; baseline.title = task.title; }
  const dueInput = $('#f-due').value;
  if (dueInput !== toInputValue(task.due)) { changes.due = dueInput || null; baseline.due = task.due || null; }
  const dueLabel = $('#f-due-label').value;
  if (dueLabel !== (task.due_label || '')) { changes.due_label = dueLabel; baseline.due_label = task.due_label || ''; }
  const note = $('#f-note').value;
  if (note !== (task.note || '')) { changes.note = note; baseline.note = task.note || ''; }
  const optional = $('#f-optional').checked;
  if (optional !== Boolean(task.optional)) { changes.optional = optional; baseline.optional = task.optional; }

  if (!Object.keys(changes).length) {
    toast('没有修改');
    closeDrawer();
    return;
  }

  try {
    await api(`/todos/${encodeURIComponent(task.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ changes, baseline }),
    });
    toast('已保存');
    closeDrawer(false);
    await syncTasks();
  } catch (error) {
    const warn = $('#draft-warn');
    warn.textContent = error.message;
    warn.classList.remove('hidden');
  }
}

/* ---------- new task ---------- */

function openModal() {
  $('#n-title').value = '';
  $('#n-due').value = '';
  $('#n-due-label').value = '';
  $('#n-note').value = '';
  $('#modal').classList.remove('hidden');
  $('#modal-mask').classList.remove('hidden');
  $('#n-title').focus();
}

function closeModal(refresh = true) {
  const wasOpen = !$('#modal').classList.contains('hidden');
  $('#modal').classList.add('hidden');
  $('#modal-mask').classList.add('hidden');
  if (wasOpen && refresh) syncTasks({ silent: true });
}

async function createTask() {
  const title = $('#n-title').value.trim();
  if (!title) {
    toast('请填写标题');
    $('#n-title').focus();
    return;
  }
  try {
    await api('/todos', {
      method: 'POST',
      body: JSON.stringify({
        title,
        due: $('#n-due').value || null,
        due_label: $('#n-due-label').value,
        note: $('#n-note').value,
        optional: false,
      }),
    });
    toast('已创建');
    closeModal(false);
    await syncTasks();
  } catch (error) {
    toast(error.message);
  }
}

/* ---------- filter ---------- */

function setView(view) {
  state.view = view;
  document.querySelectorAll('#filter-pop button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  $('#filter-pop').classList.add('hidden');
  syncTasks();
}

/* ---------- overview ---------- */

async function openOverview() {
  $('#overview-mask').classList.remove('hidden');
  $('#overview').classList.remove('hidden');
  const body = $('#overview-body');
  body.innerHTML = '<div class="ov-line">统计加载中…</div>';
  try {
    const [status, groups] = await Promise.all([api('/status'), api('/groups')]);
    body.innerHTML = '';
    const stats = [
      ['待办', status.counts.active],
      ['已完成', status.counts.done],
      ['已移除', status.counts.removed],
    ];
    for (const [label, num] of stats) {
      const box = document.createElement('div');
      box.className = 'ov-stat';
      const n = document.createElement('div'); n.className = 'num'; n.textContent = num;
      const l = document.createElement('div'); l.className = 'lbl'; l.textContent = label;
      box.append(n, l);
      body.append(box);
    }
    const line = document.createElement('div');
    line.className = 'ov-line';
    line.textContent = `消息来源 ${groups.groups.length} 个群 · ChatNotice v${status.version} · 本地运行`;
    body.append(line);
  } catch (error) {
    body.innerHTML = '';
    const line = document.createElement('div');
    line.className = 'ov-line';
    line.textContent = '统计加载失败：' + error.message;
    body.append(line);
  }
}

function closeOverview() {
  $('#overview-mask').classList.add('hidden');
  $('#overview').classList.add('hidden');
}

/* ---------- pairing ---------- */

async function openPairing() {
  $('#pair-mask').classList.remove('hidden');
  $('#pair').classList.remove('hidden');
  $('#pair-qr').removeAttribute('src');
  $('#pair-url').value = '';
  $('#pair-token').value = '';
  try {
    const data = await api('/pairing');
    $('#pair-qr').src = data.qr_png;
    $('#pair-url').value = data.urls[0] || '';
    $('#pair-token').value = data.token;
  } catch (error) {
    toast(error.message);
  }
}

function closePairing() {
  $('#pair-mask').classList.add('hidden');
  $('#pair').classList.add('hidden');
}

/* ---------- bubbles ---------- */

const bubbles = [];

function chipType(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (ext === 'pdf' || ext === 'doc' || ext === 'docx' || ext === 'xls' || ext === 'xlsx') {
    return { text: ext.toUpperCase(), cls: 'pdf' };
  }
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext)) {
    return { text: 'IMG', cls: 'img' };
  }
  return { text: ext.slice(0, 4).toUpperCase() || 'FILE', cls: '' };
}

function renderChips(bubble) {
  bubble.chipsEl.innerHTML = '';
  for (const file of bubble.files) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const type = chipType(file.name);
    const tag = document.createElement('span');
    tag.className = 'ftype ' + type.cls;
    tag.textContent = type.text;
    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = file.name;
    name.title = `${file.name} · ${formatSize(file.size)}`;
    const remove = document.createElement('button');
    remove.textContent = '×';
    remove.setAttribute('aria-label', '移除附件');
    remove.addEventListener('click', () => {
      bubble.files = bubble.files.filter((f) => f !== file);
      renderChips(bubble);
    });
    chip.append(tag, name, remove);
    bubble.chipsEl.append(chip);
  }
  updateBubbleState(bubble);
}

function updateBubbleState(bubble) {
  bubble.submit.disabled = bubble.uploading > 0;
  bubble.submit.textContent = bubble.uploading > 0 ? '上传中…' : '加入待办';
}

async function uploadFiles(fileList, bubble) {
  const room = 10 - bubble.files.length;
  if (room <= 0) { toast('一个气泡最多放 10 个附件'); return; }
  const files = [...fileList].slice(0, room);
  if (!files.length) return;
  const form = new FormData();
  files.forEach((file) => form.append('files', file));
  bubble.uploading += 1;
  updateBubbleState(bubble);
  try {
    const res = await fetch('/api/inbox', { method: 'POST', body: form });
    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    if (!res.ok || data.ok === false) throw new Error(data.detail || '上传失败');
    bubble.files.push(...data.files);
    renderChips(bubble);
    toast(`已放入 ${data.files.length} 个文件`);
  } catch (error) {
    toast(error.message);
  } finally {
    bubble.uploading -= 1;
    updateBubbleState(bubble);
  }
}

async function submitBubble(bubble) {
  const text = bubble.textEl.value.trim();
  if (!text && !bubble.files.length) { toast('先写点描述，或放入文件'); return; }
  if (bubble.uploading > 0) { toast('还有文件在上传中…'); return; }
  const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean);
  const title = (firstLine || bubble.files[0].name || '新任务').slice(0, 80);
  const parts = [];
  if (text) parts.push(text);
  if (bubble.files.length) {
    parts.push('附件：\n' + bubble.files
      .map((f) => `- ${f.name}（${formatSize(f.size)}）→ ${f.stored}`)
      .join('\n'));
  }
  bubble.submit.disabled = true;
  try {
    await api('/todos', {
      method: 'POST',
      body: JSON.stringify({ title, due: null, due_label: '', note: parts.join('\n\n'), optional: false }),
    });
    bubble.textEl.value = '';
    bubble.files = [];
    renderChips(bubble);
    toast('已加入右侧待办');
    await syncTasks();
  } catch (error) {
    toast(error.message);
  } finally {
    updateBubbleState(bubble);
  }
}

function initBubbles() {
  document.querySelectorAll('.bubble').forEach((el) => {
    const bubble = {
      el,
      files: [],
      uploading: 0,
      textEl: el.querySelector('.bubble-text'),
      chipsEl: el.querySelector('.chips'),
      submit: el.querySelector('.bubble-submit'),
    };
    el.querySelectorAll('input[type=file]').forEach((input) => {
      input.addEventListener('change', () => {
        if (input.files && input.files.length) uploadFiles(input.files, bubble);
        input.value = '';
      });
    });
    el.addEventListener('dragenter', (event) => {
      event.preventDefault();
      el.classList.add('dragover');
    });
    el.addEventListener('dragover', (event) => {
      event.preventDefault();
      el.classList.add('dragover');
    });
    el.addEventListener('dragleave', (event) => {
      if (el.contains(event.relatedTarget)) return;
      el.classList.remove('dragover');
    });
    el.addEventListener('drop', (event) => {
      event.preventDefault();
      el.classList.remove('dragover');
      if (event.dataTransfer && event.dataTransfer.files.length) {
        uploadFiles(event.dataTransfer.files, bubble);
      }
    });
    el.querySelector('.bubble-clear').addEventListener('click', () => {
      bubble.textEl.value = '';
      bubble.files = [];
      renderChips(bubble);
    });
    bubble.submit.addEventListener('click', () => submitBubble(bubble));
    renderChips(bubble);
    bubbles.push(bubble);
  });
}

/* ---------- events ---------- */

$('#btn-new-task').addEventListener('click', openModal);
$('#btn-add').addEventListener('click', openModal);
$('#modal-cancel').addEventListener('click', closeModal);
$('#modal-mask').addEventListener('click', closeModal);
$('#modal-create').addEventListener('click', createTask);
$('#n-title').addEventListener('keydown', (event) => { if (event.key === 'Enter') createTask(); });

$('#drawer-close').addEventListener('click', closeDrawer);
$('#drawer-mask').addEventListener('click', closeDrawer);
$('#btn-save').addEventListener('click', saveDrawer);
$('#btn-delete').addEventListener('click', () => {
  if (state.current) setRemoved(state.current, !state.current.removed);
});

$('#btn-filter').addEventListener('click', (event) => {
  event.stopPropagation();
  $('#filter-pop').classList.toggle('hidden');
});
document.querySelectorAll('#filter-pop button').forEach((btn) => {
  btn.addEventListener('click', () => setView(btn.dataset.view));
});
document.addEventListener('click', (event) => {
  if (!$('#filter-pop').contains(event.target) && event.target !== $('#btn-filter')) {
    $('#filter-pop').classList.add('hidden');
  }
});

let searchTimer = null;
$('#search').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = event.target.value.trim();
    syncTasks();
  }, 200);
});

$('#btn-overview').addEventListener('click', openOverview);
$('#overview-close').addEventListener('click', closeOverview);
$('#overview-mask').addEventListener('click', closeOverview);

$('#btn-pair').addEventListener('click', openPairing);
$('#pair-close').addEventListener('click', closePairing);
$('#pair-mask').addEventListener('click', closePairing);
$('#pair-copy').addEventListener('click', async () => {
  const text = `地址：${$('#pair-url').value}\n令牌：${$('#pair-token').value}`;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板');
  } catch {
    toast('复制失败，请手动选择文本');
  }
});

$('#btn-upload').addEventListener('click', () => $('#quick-upload').click());
$('#quick-upload').addEventListener('change', (event) => {
  if (event.target.files.length) uploadFiles(event.target.files, bubbles[0]);
  event.target.value = '';
});

$('#btn-bell').addEventListener('click', () => toast('通知中心开发中'));
$('#btn-avatar').addEventListener('click', () => toast('ChatNotice · 本地运行 · v2.0.0-dev'));

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeDrawer();
    closeModal();
    closeOverview();
    closePairing();
    $('#filter-pop').classList.add('hidden');
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    openModal();
  }
});

/* ---------- boot ---------- */

initBubbles();
syncTasks();
startSyncLoop();