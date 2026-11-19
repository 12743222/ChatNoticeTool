'use strict';

const $ = (sel) => document.querySelector(sel);
const state = {
  view: 'active', tasks: [], current: null, base: '', token: '',
  signature: null, syncSeq: 0,
};
let syncTimer = null;
let syncLoopStarted = false;

/* ---------- storage ---------- */

const pairStore = {
  get() {
    return {
      base: localStorage.getItem('cn_server') || '',
      token: localStorage.getItem('cn_token') || '',
    };
  },
  save(base, token) {
    localStorage.setItem('cn_server', base);
    localStorage.setItem('cn_token', token);
  },
  clear() {
    localStorage.removeItem('cn_server');
    localStorage.removeItem('cn_token');
  },
};

/* ---------- helpers ---------- */

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2400);
}

function normalizeBase(value) {
  let base = value.trim();
  if (!base) return '';
  if (!/^https?:\/\//i.test(base)) base = 'http://' + base;
  return base.replace(/\/+$/, '');
}

async function api(path, options = {}) {
  const res = await fetch(state.base + '/api' + path, {
    cache: 'no-store',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Token': state.token,
      ...(options.headers || {}),
    },
  });
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok || data.ok === false) {
    throw new Error(data.detail || data.error || `请求失败 (${res.status})`);
  }
  return data;
}

function dueLabel(task) {
  if (!task.due) return task.due_label || '无截止时间';
  const [datePart, timePart] = task.due.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(y, m - 1, d);
  const diff = Math.round((target - today) / 86400000);
  let day;
  if (diff === 0) day = '今天';
  else if (diff === 1) day = '明天';
  else if (diff === -1) day = '昨天';
  else day = `${m}/${d}`;
  return day + (timePart ? ' ' + timePart : '') + (task.due_label ? ' · ' + task.due_label : '');
}

function dueClass(task) {
  if (!task.due) return '';
  const [datePart] = task.due.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(y, m - 1, d);
  if (target < today) return 'overdue';
  if (target.getTime() === today.getTime()) return 'today';
  return '';
}

/* ---------- connection ---------- */

function showPairError(text) {
  const el = $('#pair-err');
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}

async function connect() {
  const base = normalizeBase($('#pair-url').value);
  const token = $('#pair-token').value.trim();
  if (!base || !token) {
    showPairError('请填写服务器地址和访问令牌');
    return;
  }
  const btn = $('#btn-connect');
  btn.disabled = true;
  btn.textContent = '连接中…';
  showPairError('');
  try {
    const res = await fetch(base + '/api/status', {
      cache: 'no-store',
      headers: { 'X-Api-Token': token },
    });
    if (res.status === 401) throw new Error('令牌不正确');
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok !== true) throw new Error('服务未响应');
    state.base = base;
    state.token = token;
    pairStore.save(base, token);
    enterMain();
  } catch (error) {
    showPairError('连接失败：' + error.message + '。请确认手机和电脑在同一 Wi-Fi，地址与令牌填写正确。');
  } finally {
    btn.disabled = false;
    btn.textContent = '连接';
  }
}

function enterMain() {
  state.signature = null;
  $('#pair-view').classList.add('hidden');
  $('#main-view').classList.remove('hidden');
  startSyncLoop();
  refreshAll();
}

function showPairing() {
  $('#main-view').classList.add('hidden');
  $('#pair-view').classList.remove('hidden');
  const saved = pairStore.get();
  $('#pair-url').value = saved.base;
  $('#pair-token').value = saved.token;
}

/* ---------- data ---------- */

function taskSignature(tasks) {
  return JSON.stringify(tasks.map((t) => [
    t.id, t.title, t.note || '', t.due || '', t.due_label || '',
    Boolean(t.optional), Boolean(t.done), Boolean(t.removed), t.updated_at || '',
  ]));
}

function setSyncState(kind) {
  const el = $('#sync-state');
  if (kind === 'offline') {
    el.textContent = '离线';
    el.classList.add('error');
    return;
  }
  if (kind === 'syncing') {
    el.textContent = '同步中…';
    el.classList.remove('error');
    return;
  }
  el.textContent = '已同步 ' + new Date().toTimeString().slice(0, 8);
  el.classList.remove('error');
}

async function refreshAll({ silent = false, notify = false } = {}) {
  if (!state.base || !state.token) return;
  const seq = ++state.syncSeq;
  if (!silent) setSyncState('syncing');
  try {
    const [status, list] = await Promise.all([
      api('/status'),
      api('/todos?view=' + state.view),
    ]);
    if (seq !== state.syncSeq) return;
    state.tasks = list.tasks;
    $('#tab-active-count').textContent = status.counts.active;
    $('#tab-done-count').textContent = status.counts.done;
    const signature = [state.view, taskSignature(list.tasks)].join('|');
    if (signature !== state.signature) {
      state.signature = signature;
      renderList();
    }
    syncOpenDetail();
    setSyncState('synced');
    if (notify) toast('已同步');
  } catch (error) {
    if (seq !== state.syncSeq) return;
    setSyncState('offline');
    if (!silent) toast(error.message);
  }
}

function startSyncLoop() {
  clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && state.base && state.token) {
      refreshAll({ silent: true });
    }
  }, 5000);
  if (syncLoopStarted) return;
  syncLoopStarted = true;
  window.addEventListener('focus', () => refreshAll({ silent: true }));
  window.addEventListener('online', () => refreshAll({ silent: true }));
  window.addEventListener('offline', () => setSyncState('offline'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshAll({ silent: true });
  });
}

function renderList() {
  const list = $('#list');
  list.innerHTML = '';
  if (!state.tasks.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = state.view === 'active' ? '没有待办事项 🌿' : '这里还是空的';
    list.append(empty);
    return;
  }
  for (const task of state.tasks) {
    list.append(renderTask(task));
  }
}

function renderTask(task) {
  const card = document.createElement('div');
  card.className = 'task' + (task.done ? ' completed' : '');

  const check = document.createElement('button');
  check.className = 'check' + (task.done ? ' done' : '');
  check.setAttribute('aria-label', task.done ? '标为未完成' : '标为完成');
  check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>';
  check.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleDone(task);
  });
  card.append(check);

  const main = document.createElement('div');
  main.className = 'main';
  main.addEventListener('click', () => openDetail(task));

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = task.title;
  main.append(title);

  if (task.note) {
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = task.note;
    main.append(note);
  }

  const meta = document.createElement('div');
  meta.className = 'meta ' + dueClass(task);
  meta.textContent = '⏰ ' + dueLabel(task);
  main.append(meta);
  card.append(main);

  const status = document.createElement('span');
  const isDoing = !task.done && (dueClass(task) === 'overdue' || dueClass(task) === 'today');
  status.className = 'status' + (task.done ? ' done' : isDoing ? ' doing' : '');
  status.textContent = task.done ? '已完成' : isDoing ? '进行中' : '待处理';
  card.append(status);

  return card;
}

/* ---------- actions ---------- */

async function toggleDone(task) {
  try {
    await api(`/todos/${encodeURIComponent(task.id)}/done`, {
      method: 'POST',
      body: JSON.stringify({ value: !task.done }),
    });
    closeSheet();
    await refreshAll();
  } catch (error) {
    toast(error.message);
  }
}

async function removeTask(task) {
  if (!confirm('把这条待办移到「已移除」吗？')) return;
  try {
    await api(`/todos/${encodeURIComponent(task.id)}/removed`, {
      method: 'POST',
      body: JSON.stringify({ value: true }),
    });
    closeSheet();
    toast('已移除');
    await refreshAll();
  } catch (error) {
    toast(error.message);
  }
}

async function createTask() {
  const title = $('#a-title').value.trim();
  if (!title) { toast('请填写标题'); return; }
  const btn = $('#a-create');
  btn.disabled = true;
  try {
    await api('/todos', {
      method: 'POST',
      body: JSON.stringify({
        title,
        due: $('#a-due').value || null,
        due_label: '',
        note: $('#a-note').value,
        optional: false,
      }),
    });
    closeSheet();
    toast('已创建');
    await refreshAll();
  } catch (error) {
    toast(error.message);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- sheets ---------- */

function openSheet(which) {
  $('#sheet-mask').classList.remove('hidden');
  $('#sheet').classList.remove('hidden');
  $('#sheet-detail').classList.toggle('hidden', which !== 'detail');
  $('#sheet-add').classList.toggle('hidden', which !== 'add');
}

function closeSheet() {
  $('#sheet-mask').classList.add('hidden');
  $('#sheet').classList.add('hidden');
  state.current = null;
}

function updateDetail(task) {
  state.current = task;
  $('#s-title').textContent = task.title;
  $('#s-note').textContent = task.note || '';
  $('#s-note').classList.toggle('hidden', !task.note);
  $('#s-meta').textContent = dueLabel(task) + (task.optional ? ' · 可选' : '');
  $('#s-toggle').textContent = task.done ? '标为未完成' : '完成';
  $('#s-remove').textContent = '移除';
}

function syncOpenDetail() {
  if ($('#sheet').classList.contains('hidden')) return;
  if ($('#sheet-detail').classList.contains('hidden')) return;
  if (!state.current) return;
  const fresh = state.tasks.find((task) => task.id === state.current.id);
  if (fresh) {
    updateDetail(fresh);
    return;
  }
  closeSheet();
  toast('该事项已在别处更新');
}

function openDetail(task) {
  updateDetail(task);
  openSheet('detail');
}

function openAdd() {
  $('#a-title').value = '';
  $('#a-due').value = '';
  $('#a-note').value = '';
  openSheet('add');
  setTimeout(() => $('#a-title').focus(), 120);
}

/* ---------- events ---------- */

$('#btn-connect').addEventListener('click', connect);
$('#pair-token').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') connect();
});

$('#btn-refresh').addEventListener('click', () => refreshAll({ notify: true }));
$('#btn-settings').addEventListener('click', () => {
  if (confirm('要断开与电脑的连接吗？下次打开需重新配对。')) {
    pairStore.clear();
    state.base = '';
    state.token = '';
    state.signature = null;
    clearInterval(syncTimer);
    syncTimer = null;
    showPairing();
  }
});

document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.view = btn.dataset.view;
    refreshAll();
  });
});

$('#btn-add').addEventListener('click', openAdd);
$('#sheet-mask').addEventListener('click', closeSheet);
$('#s-toggle').addEventListener('click', () => {
  if (state.current) toggleDone(state.current);
});
$('#s-remove').addEventListener('click', () => {
  if (state.current) removeTask(state.current);
});
$('#a-create').addEventListener('click', createTask);
$('#a-cancel').addEventListener('click', closeSheet);

/* ---------- boot ---------- */

const saved = pairStore.get();
if (saved.base && saved.token) {
  state.base = saved.base;
  state.token = saved.token;
  enterMain();
} else {
  showPairing();
}