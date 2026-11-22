'use strict';

const $ = (sel) => document.querySelector(sel);
const state = {
  view: 'active', tasks: [], current: null, base: '', token: '',
  signature: null, syncSeq: 0,
  pairMode: localStorage.getItem('cn_mode') === 'remote' ? 'remote' : 'lan',
  cache: { active: [], done: [] },
  cacheAt: { active: 0, done: 0 },
};
let syncTimer = null;
let syncLoopStarted = false;
let scanStream = null;
let scanTimer = null;
const scanCanvas = document.createElement('canvas');

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

function setScanState(text) {
  const el = $('#scan-state');
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
}

function setPairMode(mode) {
  state.pairMode = mode === 'remote' ? 'remote' : 'lan';
  localStorage.setItem('cn_mode', state.pairMode);
  $('#pair-mode-lan').classList.toggle('active', state.pairMode === 'lan');
  $('#pair-mode-remote').classList.toggle('active', state.pairMode === 'remote');
  $('#pair-hint').textContent = state.pairMode === 'remote'
    ? '公网：手机可在任意网络；扫码后请确认电脑端已开启公网访问。'
    : '局域网：手机和电脑需在同一 Wi-Fi；首次连接时请在电脑上允许防火墙访问。';
}

function parsePairPayload(text) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (!data || typeof data.token !== 'string' || !data.token) return null;
  const lan = Array.isArray(data.lan)
    ? data.lan.filter((value) => typeof value === 'string')
    : (typeof data.url === 'string' ? [data.url] : []);
  return {
    token: data.token,
    lan,
    remote: typeof data.remote === 'string' ? data.remote : null,
    preferred: data.preferred === 'remote' ? 'remote' : 'lan',
  };
}

async function decodeQrImage(dataUrl) {
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('图片无法读取'));
    image.src = dataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const code = window.jsQR
    ? window.jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' })
    : null;
  return code ? code.data : null;
}

async function probeServer(base, token) {
  try {
    const res = await fetch(base + '/api/status', {
      cache: 'no-store',
      headers: { 'X-Api-Token': token },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function connectFromQr(text) {
  const payload = parsePairPayload(text);
  if (!payload) {
    setScanState('二维码不是 ChatNotice 配对码');
    return;
  }
  const candidates = state.pairMode === 'remote'
    ? (payload.remote ? [payload.remote] : [])
    : payload.lan;
  if (!candidates.length) {
    setScanState(state.pairMode === 'remote'
      ? '该二维码没有公网地址，请先在电脑端开启公网访问'
      : '该二维码没有局域网地址');
    return;
  }
  setScanState('识别成功，正在连接…');
  for (const candidate of candidates) {
    const base = normalizeBase(candidate);
    if (base && await probeServer(base, payload.token)) {
      $('#pair-url').value = base;
      $('#pair-token').value = payload.token;
      await connect();
      return;
    }
  }
  setScanState('二维码中的地址都连接失败，请检查网络或重新扫码');
}

async function handleQrImage(dataUrl) {
  try {
    const text = await decodeQrImage(dataUrl);
    if (!text) {
      setScanState('没有识别到二维码，请靠近并重试');
      return;
    }
    await connectFromQr(text);
  } catch (error) {
    setScanState('二维码识别失败：' + (error.message || '图片无法读取'));
  }
}

function stopLiveScan() {
  clearInterval(scanTimer);
  scanTimer = null;
  if (scanStream) {
    scanStream.getTracks().forEach((track) => track.stop());
    scanStream = null;
  }
  const video = $('#scan-video');
  video.srcObject = null;
  $('#scan-view').classList.add('hidden');
}

function scanFrame() {
  const video = $('#scan-video');
  if (!scanStream || video.readyState < 2) return;
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return;
  const scale = Math.min(1, 720 / Math.max(width, height));
  scanCanvas.width = Math.round(width * scale);
  scanCanvas.height = Math.round(height * scale);
  const context = scanCanvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(video, 0, 0, scanCanvas.width, scanCanvas.height);
  const pixels = context.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
  const code = window.jsQR
    ? window.jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'dontInvert' })
    : null;
  if (code) {
    const text = code.data;
    stopLiveScan();
    connectFromQr(text);
  }
}

async function scanPair() {
  setScanState('');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setScanState('当前环境不支持相机，请从相册选择二维码图片');
    $('#qr-file').click();
    return;
  }
  $('#scan-view').classList.remove('hidden');
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
    const video = $('#scan-video');
    video.srcObject = scanStream;
    await video.play();
    clearInterval(scanTimer);
    scanTimer = setInterval(scanFrame, 180);
  } catch (error) {
    stopLiveScan();
    setScanState('无法打开相机：' + (error.message || '权限被拒绝') + '，可从相册选择二维码');
  }
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
    localStorage.setItem('cn_mode', state.pairMode);
    setScanState('');
    enterMain();
  } catch (error) {
    const hintText = state.pairMode === 'remote'
      ? '请确认电脑端已开启公网访问，且二维码未过期。'
      : '请确认手机和电脑在同一 Wi-Fi，地址与令牌填写正确。';
    showPairError('连接失败：' + error.message + '。' + hintText);
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
  api('/todos?view=done')
    .then((list) => {
      state.cache.done = list.tasks;
      state.cacheAt.done = Date.now();
    })
    .catch(() => {});
}

function showPairing() {
  $('#main-view').classList.add('hidden');
  $('#pair-view').classList.remove('hidden');
  const saved = pairStore.get();
  $('#pair-url').value = saved.base;
  $('#pair-token').value = saved.token;
  setPairMode(state.pairMode);
  setScanState('');
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
    state.cache[state.view] = list.tasks;
    state.cacheAt[state.view] = Date.now();
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
    else stopLiveScan();
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
$('#btn-scan').addEventListener('click', scanPair);
$('#pair-mode-lan').addEventListener('click', () => setPairMode('lan'));
$('#pair-mode-remote').addEventListener('click', () => setPairMode('remote'));
$('#scan-close').addEventListener('click', stopLiveScan);
$('#scan-file').addEventListener('click', () => {
  stopLiveScan();
  $('#qr-file').click();
});
$('#qr-file').addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  setScanState('正在识别二维码…');
  const reader = new FileReader();
  reader.onload = () => handleQrImage(reader.result);
  reader.onerror = () => setScanState('无法读取图片');
  reader.readAsDataURL(file);
});
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
    state.cache = { active: [], done: [] };
    state.cacheAt = { active: 0, done: 0 };
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
    if (state.cacheAt[state.view]) {
      state.tasks = state.cache[state.view];
      state.signature = [state.view, taskSignature(state.tasks)].join('|');
      renderList();
    } else {
      $('#list').innerHTML = '<div class="empty">加载中…</div>';
    }
    refreshAll({ silent: true });
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