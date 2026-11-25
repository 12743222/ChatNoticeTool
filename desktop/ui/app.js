'use strict';

const state = {
  view: 'active',
  q: '',
  tasks: [],
  current: null,
  original: null,
  signature: null,
  syncSeq: 0,
  animating: false,
  readPlatform: 'all',
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

function isImageFile(name) {
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(
    String(name || '').split('.').pop().toLowerCase());
}

function inboxUrl(stored) {
  const rel = String(stored || '').replace(/\\/g, '/').replace(/^state\/inbox\//, '');
  return '/api/inbox/' + rel.split('/').map(encodeURIComponent).join('/');
}

function openLightbox(url, alt) {
  $('#lightbox-img').src = url;
  $('#lightbox-img').alt = alt || '附件预览';
  $('#lightbox').classList.remove('hidden');
  $('#lightbox-mask').classList.remove('hidden');
}

function closeLightbox() {
  $('#lightbox').classList.add('hidden');
  $('#lightbox-mask').classList.add('hidden');
  $('#lightbox-img').removeAttribute('src');
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
  if (task.due_label && task.due_label !== info.label) text += ' · ' + task.due_label;
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
  if (state.animating) return;
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
  card.dataset.taskId = task.id;

  const side = document.createElement('div');
  side.className = 'wb-side';

  const check = document.createElement('button');
  check.className = 'wb-check' + (task.done ? ' checked' : '');
  check.setAttribute('aria-label', task.done ? '标为未完成' : '标为完成');
  check.append(svgEl('m5 12 5 5L20 7', '0 0 24 24'));
  if (task.removed) check.disabled = true;
  check.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleDone(task, card);
  });
  side.append(check);

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
  side.append(time);
  card.append(side);

  const main = document.createElement('div');
  main.className = 'wb-main';
  main.addEventListener('click', () => openDrawer(task));
  const title = document.createElement('div');
  title.className = 'wb-title';
  title.textContent = task.title;
  main.append(title);
  card.append(main);

  const status = statusOf(task);
  const chip = document.createElement('span');
  chip.className = 'wb-status ' + status.cls;
  chip.textContent = status.text;
  card.append(chip);

  return card;
}

/* ---------- task actions ---------- */

function dissolveCard(card) {
  return new Promise((resolve) => {
    if (!card || !card.isConnected) {
      resolve();
      return;
    }
    const rect = card.getBoundingClientRect();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || rect.width < 8 || rect.height < 8) {
      card.classList.add('dissolving');
      setTimeout(resolve, 300);
      return;
    }
    const titleEl = card.querySelector('.wb-title');
    const noteEl = card.querySelector('.wb-note');
    const statusEl = card.querySelector('.wb-status');
    const colors = [
      titleEl ? getComputedStyle(titleEl).color : '#17335a',
      noteEl ? getComputedStyle(noteEl).color : '#5d7899',
      statusEl ? getComputedStyle(statusEl).backgroundColor : '#eef3fa',
      '#ffffff', '#4b8df8', '#b9d7fb',
    ].filter((color) => color && color !== 'rgba(0, 0, 0, 0)');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement('canvas');
    canvas.className = 'dissolve-canvas';
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    canvas.style.left = rect.left + 'px';
    canvas.style.top = rect.top + 'px';
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    document.body.append(canvas);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const count = Math.min(150, Math.max(60, Math.round(rect.width * rect.height / 800)));
    const particles = [];
    for (let index = 0; index < count; index += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 30 + Math.random() * 110;
      particles.push({
        x: Math.random() * rect.width,
        y: Math.random() * rect.height,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 18,
        size: 1.3 + Math.random() * 2.8,
        life: 0.55 + Math.random() * 0.35,
        age: 0,
        color: colors[Math.floor(Math.random() * colors.length)],
      });
    }
    card.classList.add('dissolving');
    let previous = performance.now();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      canvas.remove();
      resolve();
    };
    const frame = (now) => {
      const delta = Math.min(0.05, (now - previous) / 1000);
      previous = now;
      ctx.clearRect(0, 0, rect.width, rect.height);
      let alive = false;
      for (const particle of particles) {
        particle.age += delta;
        const progress = particle.age / particle.life;
        if (progress >= 1) continue;
        alive = true;
        particle.vy += 110 * delta;
        particle.vx *= 0.992;
        particle.vy *= 0.992;
        particle.x += particle.vx * delta;
        particle.y += particle.vy * delta;
        ctx.globalAlpha = Math.max(0, 1 - progress);
        ctx.fillStyle = particle.color;
        ctx.beginPath();
        ctx.arc(particle.x, particle.y,
          Math.max(0.35, particle.size * (1 - progress * 0.75)), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (alive) requestAnimationFrame(frame);
      else finish();
    };
    requestAnimationFrame(frame);
    setTimeout(finish, 1100);
  });
}

async function toggleDone(task, card) {
  const markingDone = !task.done;
  const check = card ? card.querySelector('.wb-check') : null;
  if (check) check.disabled = true;
  if (markingDone) state.animating = true;
  try {
    await api(`/todos/${encodeURIComponent(task.id)}/done`, {
      method: 'POST',
      body: JSON.stringify({ value: !task.done }),
    });
    if (markingDone) await dissolveCard(card);
    state.animating = false;
    await syncTasks();
    if (card && card.isConnected) {
      card.classList.remove('dissolving');
      if (check) check.disabled = false;
    }
  } catch (error) {
    state.animating = false;
    if (card) card.classList.remove('dissolving');
    if (check) check.disabled = false;
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

function noteAttachments(note) {
  const items = [];
  for (const line of String(note || '').split('\n')) {
    const match = line.trim().match(/^- (.+?)（([^（）]*)）→ (state\/inbox\/.+)$/);
    if (match) items.push({ name: match[1], size: match[2], stored: match[3] });
  }
  return items;
}

function renderAttachments(note) {
  const block = $('#f-attachments');
  const list = $('#f-attach-list');
  list.innerHTML = '';
  const items = noteAttachments(note);
  block.classList.toggle('hidden', !items.length);
  for (const item of items) {
    const url = inboxUrl(item.stored);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'attach-item';
    row.title = isImageFile(item.name) ? '查看图片' : '打开文件';
    if (isImageFile(item.name)) {
      const img = document.createElement('img');
      img.className = 'attach-thumb';
      img.src = url;
      img.alt = item.name;
      row.append(img);
    } else {
      const icon = document.createElement('span');
      icon.className = 'attach-icon';
      icon.textContent = chipType(item.name).text;
      row.append(icon);
    }
    const text = document.createElement('span');
    text.className = 'attach-text';
    const name = document.createElement('span');
    name.className = 'attach-name';
    name.textContent = item.name;
    const size = document.createElement('span');
    size.className = 'attach-size';
    size.textContent = item.size || '附件';
    text.append(name, size);
    row.append(text);
    row.addEventListener('click', () => {
      if (isImageFile(item.name)) openLightbox(url, item.name);
      else window.open(url, '_blank', 'noopener');
    });
    list.append(row);
  }
}

function openDrawer(task) {
  state.current = task;
  state.original = { ...task };
  $('#f-title').value = task.title;
  $('#f-due').value = toInputValue(task.due);
  $('#f-due-label').value = task.due_label || '';
  $('#f-note').value = task.note || '';
  renderAttachments(task.note);
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

/* ---------- completed ---------- */

function formatDoneAt(value) {
  if (!value) return '已完成';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '已完成';
  return date.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

async function openCompleted() {
  $('#completed-mask').classList.remove('hidden');
  $('#completed').classList.remove('hidden');
  await loadCompleted();
}

function closeCompleted() {
  $('#completed-mask').classList.add('hidden');
  $('#completed').classList.add('hidden');
}

async function loadCompleted() {
  const body = $('#completed-list');
  body.innerHTML = '<div class="completed-empty">加载中…</div>';
  try {
    const data = await api('/todos?view=done');
    body.innerHTML = '';
    if (!data.tasks.length) {
      const empty = document.createElement('div');
      empty.className = 'completed-empty';
      empty.textContent = '还没有已完成的待办';
      body.append(empty);
      return;
    }
    for (const task of data.tasks) body.append(renderCompletedItem(task));
  } catch (error) {
    body.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'completed-empty';
    empty.textContent = '加载失败：' + error.message;
    body.append(empty);
  }
}

function renderCompletedItem(task) {
  const item = document.createElement('div');
  item.className = 'completed-item';
  const main = document.createElement('div');
  main.className = 'completed-main';
  const title = document.createElement('div');
  title.className = 'completed-title';
  title.textContent = task.title;
  const meta = document.createElement('div');
  meta.className = 'completed-meta';
  meta.textContent = '完成于 ' + formatDoneAt(task.done_at)
    + (task.due_label ? ' · ' + task.due_label : '');
  main.append(title, meta);
  const undo = document.createElement('button');
  undo.className = 'undo-btn';
  undo.textContent = '撤销';
  undo.addEventListener('click', () => undoCompleted(task, undo));
  item.append(main, undo);
  return item;
}

async function undoCompleted(task, button) {
  button.disabled = true;
  button.textContent = '撤销中…';
  try {
    await api(`/todos/${encodeURIComponent(task.id)}/done`, {
      method: 'POST',
      body: JSON.stringify({ value: false }),
    });
    toast('已撤销完成');
    await Promise.all([syncTasks(), loadCompleted()]);
  } catch (error) {
    button.disabled = false;
    button.textContent = '撤销';
    toast(error.message);
  }
}

/* ---------- group setup ---------- */

const setupState = { data: null, groups: [], sourcesOk: [], wechatPaths: null, qqSource: null };

function setupStep(step) {
  for (let index = 1; index <= 4; index += 1) {
    $(`#setup-step-${index}`).classList.toggle('hidden', index !== step);
  }
  document.querySelectorAll('.setup-steps span').forEach((span) => {
    span.classList.toggle('active', Number(span.dataset.step) === step);
  });
}

function setupPlatformCard(title, info) {
  const card = document.createElement('div');
  card.className = 'setup-platform';
  const strong = document.createElement('strong');
  strong.textContent = title;
  card.append(strong);
  const lines = [
    info.source ? `已配置来源：${info.source}` : '尚未配置来源',
    info.path ? `数据目录：${info.path}` : '未找到数据目录',
    `已登录客户端进程：${info.processes} 个`,
  ];
  for (const line of lines) {
    const div = document.createElement('div');
    div.textContent = line;
    card.append(div);
  }
  return card;
}

async function scanSources() {
  const box = $('#setup-detect');
  box.textContent = '检测中…';
  try {
    const data = await api('/setup/scan');
    setupState.data = data;
    const qqSource = (data.sources || []).find((item) => item.platform === 'qq');
    const wxSource = (data.sources || []).find((item) => item.platform === 'wechat');
    const qqPath = qqSource?.paths?.database_dir || data.candidates.qq?.[0]?.paths?.database_dir || '';
    const wxPaths = wxSource?.paths || data.candidates.wechat?.[0]?.paths || null;
    setupState.wechatPaths = wxPaths || null;
    box.innerHTML = '';
    box.append(
      setupPlatformCard('QQ', {source: qqSource?.name, path: qqPath, processes: data.processes.qq.length}),
      setupPlatformCard('微信', {source: wxSource?.name, path: wxPaths?.database_dir, processes: data.processes.wechat.length}),
    );
    const wxCount = (data.candidates.wechat || []).length;
    $('#setup-wechat-path').textContent =
      (wxPaths?.database_dir || '未找到') + (wxCount > 1 ? '（检测到多个账号，请选择当前登录的账号）' : '');
  } catch (error) {
    box.textContent = error.message;
  }
}

function syncSetupPlatformUI() {
  $('#setup-wechat-row').classList.toggle('hidden', !$('#setup-platform-wechat').checked);
}

async function openGroupSetup() {
  $('#setup-mask').classList.remove('hidden');
  $('#setup').classList.remove('hidden');
  setupState.groups = [];
  setupState.sourcesOk = [];
  setupState.qqSource = null;
  $('#setup-consent').checked = false;
  $('#setup-platform-qq').checked = true;
  $('#setup-platform-wechat').checked = true;
  syncSetupPlatformUI();
  $('#setup-auth-status').classList.add('hidden');
  setupStep(1);
  await scanSources();
}

function closeGroupSetup() {
  $('#setup-mask').classList.add('hidden');
  $('#setup').classList.add('hidden');
}

async function authorizeSources() {
  if (!$('#setup-consent').checked) {
    toast('请先勾选授权说明');
    return;
  }
  const button = $('#setup-authorize');
  button.disabled = true;
  const status = $('#setup-auth-status');
  status.className = 'setup-status';
  status.textContent = '正在配置来源并获取本机凭据…';
  status.classList.remove('hidden');
  try {
    const platforms = [];
    if ($('#setup-platform-qq').checked) platforms.push('qq');
    if ($('#setup-platform-wechat').checked) platforms.push('wechat');
    if (!platforms.length) throw new Error('请至少勾选 QQ 或微信');
    const paths = {};
    if (platforms.includes('wechat') && setupState.wechatPaths) {
      paths.wechat = setupState.wechatPaths;
    }
    const result = await api('/setup/authorize', {
      method: 'POST',
      body: JSON.stringify({platforms, confirmed: true, paths}),
    });
    const failures = [];
    setupState.sourcesOk = [];
    setupState.qqSource = null;
    for (const [platform, value] of Object.entries(result.results || {})) {
      if (value.ok) {
        setupState.sourcesOk.push(value.source_id);
        if (platform === 'qq') setupState.qqSource = value.source_id;
      } else {
        const hint = /凭据|密钥|key|内存/i.test(value.error)
          ? '（请确认客户端已登录，且 ChatNotice 与客户端权限级别一致）'
          : '';
        failures.push(`${platform === 'qq' ? 'QQ' : '微信'}：${value.error}${hint}`);
      }
    }
    if (!setupState.sourcesOk.length) throw new Error(failures.join('；') || '授权失败');
    status.textContent = '凭据已就绪，正在读取群列表…' + (failures.length ? `（${failures.join('；')}）` : '');
    const groups = [];
    for (const sourceId of setupState.sourcesOk) {
      const dataGroups = await api('/setup/groups?source_id=' + encodeURIComponent(sourceId));
      groups.push(...(dataGroups.groups || []));
    }
    for (const group of groups) group._selected = Boolean(group.enabled);
    setupState.groups = groups;
    $('#setup-manual').classList.toggle('hidden', !setupState.qqSource);
    renderSetupGroups();
    setupStep(3);
  } catch (error) {
    status.classList.add('error');
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function setupVisibleGroups() {
  const query = $('#setup-search').value.trim().toLowerCase();
  return setupState.groups.filter((group) =>
    !query || group.name.toLowerCase().includes(query) || group.group_id.includes(query));
}

function renderSetupGroups() {
  const list = $('#setup-groups');
  list.innerHTML = '';
  const visible = setupVisibleGroups();
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'sync-empty';
    empty.textContent = setupState.groups.length
      ? '没有匹配的群。'
      : '没有自动读取到群列表。可在上方手动输入 QQ 群号后保存。';
    list.append(empty);
  }
  for (const group of visible) {
    const row = document.createElement('label');
    row.className = 'setup-group';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(group._selected);
    input.dataset.key = group.source_id + '/' + group.group_id;
    input.addEventListener('change', () => {
      group._selected = input.checked;
    });
    const main = document.createElement('span');
    main.className = 'setup-group-main';
    const name = document.createElement('span');
    name.className = 'setup-group-name';
    name.textContent = group.name;
    const meta = document.createElement('span');
    meta.className = 'setup-group-meta';
    meta.textContent = `${group.platform === 'qq' ? 'QQ' : '微信'} · ${group.group_id}`;
    main.append(name, meta);
    const badge = document.createElement('span');
    badge.className = 'setup-badge' + (group.enabled ? ' enabled' : '');
    badge.textContent = group.configured ? (group.enabled ? '已启用' : '已停用') : '未标定';
    row.append(input, main, badge);
    list.append(row);
  }
  $('#setup-group-count').textContent = `${visible.length} / ${setupState.groups.length} 个群`;
  const visibleBoxes = [...list.querySelectorAll('input[type=checkbox]')];
  $('#setup-check-all').checked = visibleBoxes.length > 0 && visibleBoxes.every((box) => box.checked);
}

function addManualQqGroup() {
  if (!setupState.qqSource) { toast('请先完成 QQ 授权'); return; }
  const groupId = $('#setup-manual-id').value.trim();
  if (!/^\d{5,12}$/.test(groupId)) { toast('请输入正确的 QQ 群号'); return; }
  if (setupState.groups.some((group) => group.platform === 'qq' && group.group_id === groupId)) {
    toast('这个群已经在列表里');
    return;
  }
  const name = $('#setup-manual-name').value.trim() || groupId;
  setupState.groups.push({
    source_id: setupState.qqSource,
    group_id: groupId,
    name,
    platform: 'qq',
    configured: false,
    enabled: false,
    _selected: true,
  });
  $('#setup-manual-id').value = '';
  $('#setup-manual-name').value = '';
  renderSetupGroups();
  toast('已添加，保存标定后生效');
}

async function saveSetupGroups() {
  const button = $('#setup-save-groups');
  button.disabled = true;
  try {
    const updates = setupState.groups.map((group) => ({
      source_id: group.source_id,
      group_id: group.group_id,
      name: group.name,
      enabled: Boolean(group._selected),
    }));
    await api('/setup/groups', {
      method: 'POST',
      body: JSON.stringify({groups: updates}),
    });
    toast('群聊标定已保存');
    await refreshGroupSummary();
    setupStep(4);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function refreshGroupSummary() {
  try {
    const data = await api('/setup/status');
    $('#group-summary').textContent =
      `已启用 ${data.configured_groups} 个群 · 共 ${data.total_groups} 个`;
  } catch { /* keep previous */ }
}

/* ---------- manual sync ---------- */

const syncState = { batch: '', items: [], selected: new Set(), busy: false };

function syncVisibleItems() {
  return syncState.items.filter((item) => !$('#sync-likely').checked || item.likely);
}

function syncUpdateSummary() {
  const visible = syncVisibleItems().length;
  const selected = syncState.selected.size;
  $('#sync-summary').textContent = `共 ${syncState.items.length} 条 · 当前 ${visible} 条 · 已选 ${selected} 条`;
  const visibleBoxes = [...document.querySelectorAll('#sync-list input[data-key]')];
  $('#sync-all').checked = visibleBoxes.length > 0 && visibleBoxes.every((box) => box.checked);
}

function renderSyncList() {
  const list = $('#sync-list');
  list.innerHTML = '';
  const visible = syncVisibleItems();
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'sync-empty';
    empty.textContent = syncState.items.length
      ? '没有“可能相关”的消息，取消勾选“只看可能相关”可查看全部。'
      : '没有读取到新消息。';
    list.append(empty);
  }
  for (const item of visible) {
    const row = document.createElement('label');
    row.className = 'sync-item';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.key = item.message_key;
    box.checked = syncState.selected.has(item.message_key);
    box.addEventListener('change', () => {
      if (box.checked) syncState.selected.add(item.message_key);
      else syncState.selected.delete(item.message_key);
      syncUpdateSummary();
    });
    const main = document.createElement('span');
    main.className = 'sync-item-main';
    const meta = document.createElement('span');
    meta.className = 'sync-meta';
    meta.textContent = [item.group, item.time.slice(5, 16), item.sender].filter(Boolean).join(' · ');
    const text = document.createElement('span');
    text.className = 'sync-text';
    text.textContent = item.text || '[无文本消息]';
    text.title = item.text || '';
    main.append(meta, text);
    if (item.reasons.length) {
      const reasons = document.createElement('span');
      reasons.className = 'sync-reasons';
      reasons.textContent = item.reasons.join(' · ');
      main.append(reasons);
    }
    row.append(box, main);
    list.append(row);
  }
  syncUpdateSummary();
}

async function syncGroupKeys() {
  const scope = $('#sync-scope').value;
  if (!syncGroupKeys._cache) {
    syncGroupKeys._cache = (await api('/groups')).groups || [];
  }
  return syncGroupKeys._cache
    .filter((group) => group.enabled && (scope === 'all' || group.platform === scope))
    .map((group) => group.key);
}

async function readSync() {
  if (syncState.busy) return;
  syncState.busy = true;
  const list = $('#sync-list');
  list.innerHTML = '<div class="sync-empty">正在本地读取群消息…</div>';
  $('#sync-summary').textContent = '';
  try {
    const groupKeys = await syncGroupKeys();
    if (!groupKeys.length) throw new Error('没有已启用的群，请先完成群聊标定');
    const data = await api('/sync/read', {
      method: 'POST',
      body: JSON.stringify({group_keys: groupKeys,
        since_days: Number($('#sync-range').value), limit: 50}),
    });
    syncState.batch = data.batch_id;
    syncState.items = data.items || [];
    syncState.selected.clear();
    renderSyncList();
    if (data.truncated) toast('消息较多，已显示最近一批；可继续读取或缩短时间范围');
  } catch (error) {
    list.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'sync-empty';
    empty.textContent = error.message;
    list.append(empty);
    toast(error.message);
  } finally {
    syncState.busy = false;
  }
}

function openSync() {
  $('#sync-mask').classList.remove('hidden');
  $('#sync-modal').classList.remove('hidden');
  syncState.items = [];
  syncState.selected.clear();
  syncState.batch = '';
  $('#sync-scope').value = state.readPlatform === 'all' ? 'all' : state.readPlatform;
  const list = $('#sync-list');
  list.innerHTML = '<div class="sync-empty">选择范围和时间后，点击“读取”获取群消息。微信首次读取可能较慢。</div>';
  $('#sync-summary').textContent = '';
}

function closeSync() {
  $('#sync-mask').classList.add('hidden');
  $('#sync-modal').classList.add('hidden');
}

async function syncCommit(items, mode) {
  if (!items.length) { toast('请先勾选消息'); return; }
  if (syncState.busy) return;
  syncState.busy = true;
  try {
    const payload = items.map((item) => ({
      message_key: item.message_key,
      content_hash: item.content_hash,
      action: 'create',
      text: item.text,
      group: item.group,
      time: item.time,
    }));
    const data = await api('/sync/commit', {
      method: 'POST',
      body: JSON.stringify({batch_id: syncState.batch, items: payload, mode}),
    });
    if (data.has_failures) throw new Error('部分消息写入失败，已保留待重试');
    const keys = new Set(items.map((item) => item.message_key));
    syncState.items = syncState.items.filter((item) => !keys.has(item.message_key));
    keys.forEach((key) => syncState.selected.delete(key));
    renderSyncList();
    toast(`已生成 ${data.created} 条待办`);
    await syncTasks();
  } catch (error) {
    toast(error.message);
  } finally {
    syncState.busy = false;
  }
}

async function syncIgnore(items) {
  if (!items.length) { toast('请先勾选消息'); return; }
  if (syncState.busy) return;
  syncState.busy = true;
  try {
    const payload = items.map((item) => ({
      message_key: item.message_key,
      content_hash: item.content_hash,
      action: 'ignore',
    }));
    await api('/sync/commit', {
      method: 'POST',
      body: JSON.stringify({batch_id: syncState.batch, items: payload, mode: 'plain'}),
    });
    const keys = new Set(items.map((item) => item.message_key));
    syncState.items = syncState.items.filter((item) => !keys.has(item.message_key));
    keys.forEach((key) => syncState.selected.delete(key));
    renderSyncList();
    toast('已忽略并标记处理');
  } catch (error) {
    toast(error.message);
  } finally {
    syncState.busy = false;
  }
}

/* ---------- pairing ---------- */

let pairMode = 'lan';
let pairData = null;
let pairPoll = null;

function renderPairing() {
  if (!pairData) return;
  const tunnelState = pairData.tunnel || {};
  const enabled = Boolean(tunnelState.enabled);
  const ready = Boolean(pairData.remote_url);
  $('#pair-remote-toggle').checked = enabled;
  const states = {
    disabled: '未开启',
    downloading: '正在下载 cloudflared…',
    starting: '正在建立外网通道…',
    ready: '已就绪',
    error: tunnelState.error || '连接失败',
  };
  const status = $('#pair-remote-status');
  status.textContent = enabled
    ? (states[tunnelState.state] || tunnelState.state || '连接中…')
    : '未开启';
  status.classList.toggle('ready', ready);
  status.classList.toggle('error', enabled && tunnelState.state === 'error');
  const remoteReady = pairMode !== 'remote' || ready;
  const url = pairMode === 'remote'
    ? (pairData.remote_url || '')
    : (pairData.urls[0] || '');
  $('#pair-url').value = url;
  $('#pair-token').value = pairData.token || '';
  $('#pair-qr').classList.toggle('hidden', !remoteReady);
  $('#pair-qr-placeholder').classList.toggle('hidden', remoteReady);
  if (remoteReady && pairData.qr_png && $('#pair-qr').getAttribute('src') !== pairData.qr_png) {
    $('#pair-qr').src = pairData.qr_png;
  }
}

async function refreshPairing() {
  try {
    pairData = await api('/pairing?mode=' + pairMode);
    renderPairing();
  } catch (error) {
    toast(error.message);
  }
}

async function setPairMode(mode) {
  pairMode = mode;
  $('#pair-mode-lan').classList.toggle('active', mode === 'lan');
  $('#pair-mode-remote').classList.toggle('active', mode === 'remote');
  $('#pair-remote-box').classList.toggle('hidden', mode !== 'remote');
  $('#pair-desc').textContent = mode === 'remote'
    ? '手机在任意网络时使用公网；扫码后由手机选择连接方式。'
    : '手机与电脑在同一 Wi-Fi 时使用局域网；扫描二维码自动配对。';
  await refreshPairing();
}

async function openPairing() {
  $('#pair-mask').classList.remove('hidden');
  $('#pair').classList.remove('hidden');
  clearInterval(pairPoll);
  await setPairMode(pairMode);
  pairPoll = setInterval(refreshPairing, 3000);
}

function closePairing() {
  $('#pair-mask').classList.add('hidden');
  $('#pair').classList.add('hidden');
  clearInterval(pairPoll);
  pairPoll = null;
}

/* ---------- settings ---------- */

let settingsPoll = null;
let pendingClearKey = false;

function updateAutoStatus(data) {
  const parts = [];
  if (data.running) parts.push('读取中…');
  parts.push(`今日调用 ${data.model_calls_today}/${data.daily_model_call_limit}`);
  const labels = { ok: '成功', empty: '无新消息', limited: '已达上限', error: '异常' };
  if (data.last_result) {
    const run = data.last_result;
    parts.push('上次：' + (labels[run.status] || run.status || '未知'));
    if (run.status === 'ok') {
      parts.push(`新增 ${run.created} 条`);
    }
    if (run.error) parts.push(run.error);
  } else {
    parts.push('尚未运行');
  }
  if (data.next_check_at) {
    parts.push('下次检查 ' + data.next_check_at.slice(11, 16));
  }
  $('#auto-status-line').textContent = parts.join(' · ');
  $('#btn-run-now').disabled = Boolean(data.running);
}

async function refreshAutomationStatus() {
  try {
    const data = await api('/settings/automation');
    updateAutoStatus(data);
  } catch { /* keep last status */ }
}

async function loadSettings() {
  try {
    const [data, status] = await Promise.all([api('/settings/automation'), api('/status')]);
    $('#settings-version').textContent = 'ChatNotice v' + (status.version || '');
    $('#s-window-start').value = data.window_start;
    $('#s-window-end').value = data.window_end;
    $('#s-check-interval').value = String(data.check_interval_seconds);
    $('#s-min-read').value = String(data.min_read_interval_minutes);
    $('#s-auto-start').checked = Boolean(data.auto_start);
    $('#s-enabled').checked = Boolean(data.enabled);
    $('#s-privacy').checked = Boolean(data.privacy_confirmed);
    $('#s-model').value = data.model;
    $('#s-call-limit').value = data.daily_model_call_limit;
    $('#s-read-platform').value = data.read_platform || 'all';
    state.readPlatform = data.read_platform || 'all';
    $('#s-api-key').value = '';
    $('#key-state').textContent = data.api_key_set ? '已保存' : '未保存';
    $('#s-api-key').placeholder = data.api_key_set ? '已保存，留空不修改' : 'sk-…';
    pendingClearKey = false;
    updateAutoStatus(data);
    refreshGroupSummary();
  } catch (error) {
    toast(error.message);
  }
}

function openSettings() {
  $('#settings').classList.remove('hidden');
  $('#settings-mask').classList.remove('hidden');
  loadSettings();
  clearInterval(settingsPoll);
  settingsPoll = setInterval(refreshAutomationStatus, 4000);
}

function closeSettings() {
  $('#settings').classList.add('hidden');
  $('#settings-mask').classList.add('hidden');
  clearInterval(settingsPoll);
  settingsPoll = null;
}

async function saveSettings() {
  const windowStart = $('#s-window-start').value;
  const windowEnd = $('#s-window-end').value;
  if (!windowStart || !windowEnd) { toast('请填写完整的允许读取时间段'); return; }
  if (windowStart === windowEnd) { toast('开始时间和结束时间不能相同'); return; }
  if ($('#s-enabled').checked && !$('#s-privacy').checked) {
    toast('开启自动读取前请先确认隐私提示');
    return;
  }
  const button = $('#settings-save');
  button.disabled = true;
  try {
    const body = {
      window_start: windowStart,
      window_end: windowEnd,
      check_interval_seconds: Number($('#s-check-interval').value),
      min_read_interval_minutes: Number($('#s-min-read').value),
      auto_start: $('#s-auto-start').checked,
      enabled: $('#s-enabled').checked,
      privacy_confirmed: $('#s-privacy').checked,
      model: $('#s-model').value,
      daily_model_call_limit: Number($('#s-call-limit').value),
      read_platform: $('#s-read-platform').value,
    };
    const apiKey = $('#s-api-key').value.trim();
    if (apiKey) body.api_key = apiKey;
    if (pendingClearKey) body.clear_api_key = true;
    const data = await api('/settings/automation', {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    toast(data.auto_start_warning || '设置已保存');
    closeSettings();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function runAutomationNow() {
  if (!$('#s-api-key').value.trim() && $('#key-state').textContent !== '已保存') {
    toast('请先保存 DeepSeek API Key');
    return;
  }
  try {
    await api('/automation/run', { method: 'POST', body: '{}' });
    toast('已开始读取，完成后会自动刷新待办');
    $('#btn-run-now').disabled = true;
    setTimeout(refreshAutomationStatus, 1500);
  } catch (error) {
    toast(error.message);
  }
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

function bubbleText(bubble) {
  return [bubble.capturedText, bubble.textEl.value]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n');
}

function updateTextLine(bubble) {
  const captured = bubble.capturedText.trim();
  if (!captured) {
    bubble.captureEl.classList.add('hidden');
    bubble.textEl.classList.remove('has-captured');
    return;
  }
  const firstLine = captured.split('\n').map((line) => line.trim()).find(Boolean) || '';
  bubble.captureEl.classList.remove('hidden');
  bubble.textEl.classList.add('has-captured');
  const line = bubble.captureEl.querySelector('.tp-line');
  line.textContent = firstLine;
  line.title = captured;
}

function renderChips(bubble) {
  bubble.chipsEl.innerHTML = '';
  updateTextLine(bubble);
  for (const file of bubble.files) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const image = isImageFile(file.name);
    if (image) {
      chip.classList.add('image-chip');
      const img = document.createElement('img');
      img.className = 'thumb';
      img.src = inboxUrl(file.stored);
      img.alt = file.name;
      img.title = '点击查看大图';
      img.addEventListener('click', () => openLightbox(img.src, file.name));
      img.addEventListener('error', () => img.remove());
      chip.append(img);
    } else {
      const type = chipType(file.name);
      chip.classList.add('file-chip');
      const tile = document.createElement('span');
      tile.className = 'file-thumb ' + type.cls;
      tile.title = `${file.name} · ${formatSize(file.size)}`;
      tile.append(svgEl('M6 3h9l4 4v14H6z M14 3v5h5', '0 0 24 24'));
      const ext = document.createElement('span');
      ext.className = 'file-ext';
      ext.textContent = type.text;
      tile.append(ext);
      chip.append(tile);
    }
    const remove = document.createElement('button');
    remove.textContent = '×';
    remove.className = 'chip-clear';
    remove.setAttribute('aria-label', '移除附件');
    remove.addEventListener('click', () => {
      bubble.files = bubble.files.filter((f) => f !== file);
      renderChips(bubble);
    });
    chip.append(remove);
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
  const text = bubbleText(bubble);
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
    bubble.capturedText = '';
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

function appendCapturedText(bubble, text) {
  const clean = String(text || '').trim();
  if (!clean) return;
  bubble.capturedText = bubble.capturedText
    ? bubble.capturedText + '\n' + clean
    : clean;
  renderChips(bubble);
  toast('已放入文字');
}

function initBubbles() {
  document.querySelectorAll('.bubble').forEach((el) => {
    const bubble = {
      el,
      files: [],
      uploading: 0,
      capturedText: '',
      textEl: el.querySelector('.bubble-text'),
      chipsEl: el.querySelector('.chips'),
      submit: el.querySelector('.bubble-submit'),
    };
    const inner = el.querySelector('.bubble-inner');
    const hint = document.createElement('div');
    hint.className = 'drop-hint';
    hint.textContent = '松开，文字或文件放进气泡';
    inner.append(hint);
    const captureLine = document.createElement('div');
    captureLine.className = 'capture-line hidden';
    const lineText = document.createElement('span');
    lineText.className = 'tp-line';
    const lineClear = document.createElement('button');
    lineClear.type = 'button';
    lineClear.className = 'tp-clear';
    lineClear.textContent = '×';
    lineClear.setAttribute('aria-label', '清空气泡文字');
    lineClear.addEventListener('click', (event) => {
      event.stopPropagation();
      bubble.capturedText = '';
      bubble.textEl.value = '';
      renderChips(bubble);
    });
    captureLine.append(lineText, lineClear);
    captureLine.addEventListener('click', () => bubble.textEl.focus());
    inner.append(captureLine);
    bubble.captureEl = captureLine;
    el.querySelectorAll('input[type=file]').forEach((input) => {
      input.addEventListener('change', () => {
        if (input.files && input.files.length) uploadFiles(input.files, bubble);
        input.value = '';
      });
    });
    bubble.textEl.addEventListener('input', () => renderChips(bubble));
    bubble.textEl.addEventListener('paste', (event) => {
      const files = [...(event.clipboardData?.files || [])];
      if (files.length) {
        event.preventDefault();
        uploadFiles(files, bubble);
        return;
      }
      const text = event.clipboardData?.getData('text/plain');
      if (text && text.trim()) {
        event.preventDefault();
        appendCapturedText(bubble, text);
      }
    });
    el.addEventListener('dragenter', (event) => {
      event.preventDefault();
      el.classList.add('dragover');
    });
    el.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      el.classList.add('dragover');
    });
    el.addEventListener('dragleave', (event) => {
      if (el.contains(event.relatedTarget)) return;
      el.classList.remove('dragover');
    });
    el.addEventListener('drop', (event) => {
      event.preventDefault();
      el.classList.remove('dragover');
      const data = event.dataTransfer;
      if (!data) return;
      if (data.files && data.files.length) {
        uploadFiles(data.files, bubble);
        return;
      }
      const text = data.getData('text/plain') || data.getData('text');
      appendCapturedText(bubble, text);
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

$('#btn-completed').addEventListener('click', openCompleted);
$('#completed-close').addEventListener('click', closeCompleted);
$('#completed-mask').addEventListener('click', closeCompleted);

$('#btn-pair').addEventListener('click', openPairing);
$('#pair-close').addEventListener('click', closePairing);
$('#pair-mask').addEventListener('click', closePairing);
$('#pair-mode-lan').addEventListener('click', () => setPairMode('lan'));
$('#pair-mode-remote').addEventListener('click', () => setPairMode('remote'));
$('#pair-remote-toggle').addEventListener('change', async (event) => {
  const enabled = event.target.checked;
  event.target.disabled = true;
  try {
    await api('/pairing/tunnel', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
    toast(enabled ? '正在建立公网通道…' : '已关闭公网访问');
    await refreshPairing();
  } catch (error) {
    event.target.checked = !enabled;
    toast(error.message);
  } finally {
    event.target.disabled = false;
  }
});
$('#pair-copy').addEventListener('click', async () => {
  if (!$('#pair-url').value) { toast('当前模式地址尚未就绪'); return; }
  const text = `地址：${$('#pair-url').value}\n令牌：${$('#pair-token').value}`;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板');
  } catch {
    toast('复制失败，请手动选择文本');
  }
});

$('#lightbox-close').addEventListener('click', closeLightbox);
$('#lightbox-mask').addEventListener('click', closeLightbox);

$('#btn-upload').addEventListener('click', () => $('#quick-upload').click());
$('#quick-upload').addEventListener('change', (event) => {
  if (event.target.files.length) uploadFiles(event.target.files, bubbles[0]);
  event.target.value = '';
});

$('#btn-settings').addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', closeSettings);
$('#settings-cancel').addEventListener('click', closeSettings);
$('#settings-mask').addEventListener('click', closeSettings);
$('#settings-save').addEventListener('click', saveSettings);
$('#btn-run-now').addEventListener('click', runAutomationNow);
$('#btn-group-setup').addEventListener('click', openGroupSetup);
$('#btn-sync').addEventListener('click', openSync);
$('#btn-sync-settings').addEventListener('click', openSync);

$('#setup-close').addEventListener('click', closeGroupSetup);
$('#setup-mask').addEventListener('click', closeGroupSetup);
$('#setup-platform-qq').addEventListener('change', syncSetupPlatformUI);
$('#setup-platform-wechat').addEventListener('change', syncSetupPlatformUI);
$('#setup-rescan').addEventListener('click', scanSources);
$('#setup-next-1').addEventListener('click', () => setupStep(2));
$('#setup-back-2').addEventListener('click', () => setupStep(1));
$('#setup-back-3').addEventListener('click', () => setupStep(2));
$('#setup-authorize').addEventListener('click', authorizeSources);
$('#setup-pick-wechat').addEventListener('click', async () => {
  try {
    const data = await api('/setup/folder', {method: 'POST', body: JSON.stringify({platform: 'wechat'})});
    setupState.wechatPaths = data.paths;
    $('#setup-wechat-path').textContent = data.paths.database_dir;
  } catch (error) {
    toast(error.message);
  }
});
$('#setup-search').addEventListener('input', renderSetupGroups);
$('#setup-manual-add').addEventListener('click', addManualQqGroup);
$('#setup-check-all').addEventListener('change', (event) => {
  for (const group of setupVisibleGroups()) group._selected = event.target.checked;
  renderSetupGroups();
});
$('#setup-save-groups').addEventListener('click', saveSetupGroups);
$('#setup-skip-key').addEventListener('click', () => {
  closeGroupSetup();
  toast('群聊已保存，可手动读取群消息');
});
$('#setup-go-key').addEventListener('click', () => {
  closeGroupSetup();
  setTimeout(() => {
    const section = document.querySelector('.ai-section');
    if (section) section.scrollIntoView({block: 'start'});
    const key = $('#s-api-key');
    if (key) key.focus();
  }, 100);
});

$('#sync-close').addEventListener('click', closeSync);
$('#sync-mask').addEventListener('click', closeSync);
$('#sync-refresh').addEventListener('click', readSync);
$('#sync-range').addEventListener('change', () => {
  $('#sync-list').innerHTML = '<div class="sync-empty">时间范围已更改，点击“读取”获取消息。</div>';
});
$('#sync-scope').addEventListener('change', () => {
  syncGroupKeys._cache = null;
  $('#sync-list').innerHTML = '<div class="sync-empty">读取范围已更改，点击“读取”获取消息。</div>';
});
$('#sync-likely').addEventListener('change', renderSyncList);
$('#sync-all').addEventListener('change', (event) => {
  for (const item of syncVisibleItems()) {
    if (event.target.checked) syncState.selected.add(item.message_key);
    else syncState.selected.delete(item.message_key);
  }
  renderSyncList();
});
$('#sync-create').addEventListener('click', () => {
  syncCommit(syncState.items.filter((item) => syncState.selected.has(item.message_key)), 'plain');
});
$('#sync-rules').addEventListener('click', () => {
  syncCommit(syncState.items.filter((item) => syncState.selected.has(item.message_key)), 'rules');
});
$('#sync-ignore').addEventListener('click', () => {
  syncIgnore(syncState.items.filter((item) => syncState.selected.has(item.message_key)));
});
$('#sync-ignore-rest').addEventListener('click', () => {
  syncIgnore(syncState.items.filter((item) => !syncState.selected.has(item.message_key)));
});
$('#btn-clear-key').addEventListener('click', () => {
  pendingClearKey = true;
  $('#s-api-key').value = '';
  $('#s-api-key').placeholder = '保存后清除';
  $('#key-state').textContent = '待清除（保存后生效）';
  $('#s-enabled').checked = false;
});

$('#btn-bell').addEventListener('click', () => toast('通知中心开发中'));

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeDrawer();
    closeModal();
    closeCompleted();
    closePairing();
    closeSettings();
    closeGroupSetup();
    closeSync();
    closeLightbox();
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