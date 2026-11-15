'use strict';

/* Ship Transfer — admin panel (independent from the member site) */

const TOKEN_KEY = 'ship.admin.token';

const state = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  admin: null,
  tab: 'dashboard',
  overview: null,
  requests: [],
  requestFilter: { type: 'all', status: 'pending' },
  members: [],
  memberFilter: 'all',
  memberSearch: '',
  settings: null,
  modal: null,
  busy: false,
};

const app = document.getElementById('app');

const esc = (value) =>
  String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);

const tzs = (value) => `TZS ${Number(value || 0).toLocaleString('en-US')}`;

function fmtDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('sw-TZ', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function api(path, options = {}) {
  const headers = { Accept: 'application/json' };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (options.body) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = {};
  try {
    data = await response.json();
  } catch (_err) {
    data = {};
  }
  if (response.status === 401) {
    signOutLocally();
    throw new Error(data.error || 'Muda wa kuingia umeisha. Ingia tena.');
  }
  if (!response.ok) throw new Error(data.error || 'Hitilafu imetokea. Jaribu tena.');
  return data;
}

function toast(message, isError) {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    node.className = 'toast';
  }, 3600);
}

function signOutLocally() {
  state.token = null;
  state.admin = null;
  state.overview = null;
  state.requests = [];
  state.members = [];
  localStorage.removeItem(TOKEN_KEY);
  renderLogin();
}

/* ------------------------------- sign in -------------------------------- */

function renderLogin(message) {
  app.innerHTML = `
    <div class="login-wrap">
      <form class="login-card" id="login-form" novalidate>
        <div class="brand">
          <span class="brand-mark">ST</span>
          <div>
            <h1>Ship Transfer</h1>
            <p>Admin Panel</p>
          </div>
        </div>
        <p class="muted small">
          Hii ni sehemu ya waendeshaji pekee. Akaunti ya mwanachama haiwezi kuingia hapa.
        </p>
        ${message ? `<div class="alert">${esc(message)}</div>` : ''}
        <label class="field"><span>Jina la mtumiaji</span>
          <input name="username" autocomplete="username" required />
        </label>
        <label class="field"><span>Password ya admin</span>
          <input name="password" type="password" autocomplete="current-password" required />
        </label>
        <button class="btn primary" type="submit">Ingia kwenye panel</button>
        <p class="muted small center">Ukisahau password, tumia ADMIN_USERNAME / ADMIN_PASSWORD kwenye mazingira ya app.</p>
      </form>
      <div id="toast" class="toast"></div>
    </div>`;

  document.getElementById('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const body = {};
    new FormData(form).forEach((value, key) => {
      body[key] = String(value).trim();
    });
    button.disabled = true;
    button.textContent = 'Inaingia…';
    try {
      const data = await api('/api/admin/login', { method: 'POST', body });
      state.token = data.token;
      state.admin = data.admin;
      localStorage.setItem(TOKEN_KEY, data.token);
      await boot();
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Ingia kwenye panel';
      const alert = form.querySelector('.alert') || document.createElement('div');
      alert.className = 'alert';
      alert.textContent = err.message;
      form.insertBefore(alert, form.querySelector('.field'));
    }
  });
}

/* -------------------------------- layout -------------------------------- */

function renderShell() {
  app.innerHTML = `
    <header class="topbar">
      <div class="brand small">
        <span class="brand-mark">ST</span>
        <div><strong>Ship Transfer</strong><span class="muted">Admin Panel</span></div>
      </div>
      <nav class="tabs" id="tabs">
        <button data-tab="dashboard" type="button">Dashibodi</button>
        <button data-tab="requests" type="button">Maombi</button>
        <button data-tab="members" type="button">Wanachama</button>
        <button data-tab="numbers" type="button">Namba za malipo</button>
        <button data-tab="settings" type="button">Mipangilio</button>
      </nav>
      <div class="top-actions">
        <span class="pill">${esc(state.admin ? state.admin.username : 'admin')}</span>
        <button class="btn ghost small" data-action="logout" type="button">Toka</button>
      </div>
    </header>
    <main id="view" class="view"></main>
    <div id="modal-root"></div>
    <div id="toast" class="toast"></div>`;

  document.getElementById('tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (!button) return;
    state.tab = button.dataset.tab;
    renderTab();
  });
  paintTabs();
}

function paintTabs() {
  document.querySelectorAll('#tabs [data-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === state.tab);
  });
}

function renderTab() {
  paintTabs();
  const view = document.getElementById('view');
  if (state.tab === 'dashboard') view.innerHTML = viewDashboard();
  if (state.tab === 'requests') view.innerHTML = viewRequests();
  if (state.tab === 'members') view.innerHTML = viewMembers();
  if (state.tab === 'numbers') view.innerHTML = viewNumbers();
  if (state.tab === 'settings') view.innerHTML = viewSettings();
  renderModal();
}

/* ------------------------------ dashboard ------------------------------- */

function statCard(label, value, tone) {
  return `<div class="stat ${tone || ''}"><em>${esc(label)}</em><strong>${esc(value)}</strong></div>`;
}

function requestRow(txn) {
  const isWithdraw = txn.type === 'withdraw';
  return `
    <div class="row">
      <div class="row-ico ${isWithdraw ? 'out' : ''}">${isWithdraw ? '↑' : '↓'}</div>
      <div class="row-main">
        <strong>${isWithdraw ? 'Uondoaji' : 'Deposit'} · ${tzs(txn.amount)}</strong>
        <span>${esc(txn.user ? `${txn.user.phone}` : '—')} · ${esc(txn.method || '—')} · ${esc(fmtDate(txn.createdAt))}</span>
        ${isWithdraw ? `<span>Makato ${tzs(txn.fee)} · Atapokea ${tzs(txn.net)}</span>` : ''}
        ${txn.account ? `<span>Namba: ${esc(txn.account)}</span>` : ''}
      </div>
      <div class="row-actions">
        ${txn.status === 'pending'
          ? `<button class="btn primary small" data-action="decide" data-id="${esc(txn.id)}" data-decision="approve" type="button">Idhinisha</button>
             <button class="btn ghost small" data-action="decide" data-id="${esc(txn.id)}" data-decision="reject" type="button">Kataa</button>`
          : `<span class="badge ${esc(txn.status)}">${esc(txn.status === 'completed' ? 'Imekamilika' : 'Imekataliwa')}</span>`}
      </div>
    </div>`;
}

function viewDashboard() {
  const data = state.overview;
  if (!data) return '<div class="card"><p class="muted">Inapakia…</p></div>';
  const stats = data.stats || {};
  const pending = data.pending || [];
  return `
    <section class="card hero">
      <h2>Dashibodi ya mfumo</h2>
      <p class="muted small">Idhinisha malipo, simamia wanachama na namba za malipo.</p>
      <button class="btn ghost small" data-action="refresh" type="button">Sasisha data</button>
    </section>
    <div class="stats">
      ${statCard('Wanachama wote', stats.members)}
      ${statCard('Waliodeposit / kukodisha meli', stats.depositors, 'green')}
      ${statCard('Waliojisajili tu', stats.registeredOnly, 'gold')}
      ${statCard('Deposit zinasubiri', stats.pendingDeposits, 'gold')}
      ${statCard('Uondoaji unasubiri', stats.pendingWithdrawals, 'gold')}
      ${statCard('Jumla ya deposit', tzs(stats.totalDeposited), 'green')}
      ${statCard('Jumla ya uondoaji', tzs(stats.totalWithdrawn))}
      ${statCard('Faida iliyolipwa', tzs(stats.totalProfitPaid), 'green')}
    </div>
    <div class="card">
      <div class="section-title"><h3>Maombi yanayosubiri</h3><span class="muted small">${pending.length}</span></div>
      <div class="list">
        ${pending.length ? pending.map(requestRow).join('') : '<p class="muted small">Hakuna ombi linalosubiri.</p>'}
      </div>
    </div>`;
}

/* ------------------------------- requests ------------------------------- */

function viewRequests() {
  const filter = state.requestFilter;
  return `
    <section class="card hero">
      <h2>Maombi ya deposit na uondoaji</h2>
      <p class="muted small">Kila ombi linaidhinishwa mara moja tu — hakuna malipo yanayojirudia.</p>
    </section>
    <div class="card">
      <div class="filters">
        <label class="field inline"><span>Aina</span>
          <select id="request-type">
            <option value="all"${filter.type === 'all' ? ' selected' : ''}>Zote</option>
            <option value="deposit"${filter.type === 'deposit' ? ' selected' : ''}>Deposit</option>
            <option value="withdraw"${filter.type === 'withdraw' ? ' selected' : ''}>Uondoaji</option>
          </select>
        </label>
        <label class="field inline"><span>Hali</span>
          <select id="request-status">
            <option value="pending"${filter.status === 'pending' ? ' selected' : ''}>Zinasubiri</option>
            <option value="completed"${filter.status === 'completed' ? ' selected' : ''}>Zilizokamilika</option>
            <option value="rejected"${filter.status === 'rejected' ? ' selected' : ''}>Zilizokataliwa</option>
            <option value="all"${filter.status === 'all' ? ' selected' : ''}>Zote</option>
          </select>
        </label>
        <button class="btn ghost small" data-action="reload-requests" type="button">Chuja</button>
      </div>
      <div class="list">
        ${state.requests.length ? state.requests.map(requestRow).join('') : '<p class="muted small">Hakuna maombi kwa kichujio hiki.</p>'}
      </div>
    </div>`;
}

/* ------------------------------- members -------------------------------- */

function memberRow(member) {
  return `
    <div class="row member">
      <div class="row-ico ${member.group === 'active' ? 'in' : ''}">${member.group === 'active' ? '★' : '·'}</div>
      <div class="row-main">
        <strong>${esc(member.phone)}${member.withdrawBlocked ? ' · <span class="badge rejected">Uondoaji umezuiwa</span>' : ''}</strong>
        <span>Salio ${tzs(member.balance)} · Mtaji ${tzs(member.capital)} · Faida jumla ${tzs(member.totalProfit)}</span>
        <span>${member.group === 'active'
          ? `Ameweka ${tzs(member.deposited)} · Meli ${member.activeInvestments} (${tzs(member.activeCapital)})`
          : 'Hajafanya deposit wala kukodisha meli'}</span>
        <span class="muted">${esc(fmtDate(member.createdAt))}</span>
      </div>
      <div class="row-actions wrap">
        <button class="btn ghost small" data-action="open-member" data-id="${esc(member.id)}" type="button">Fungua</button>
        <button class="btn primary small" data-action="credit" data-id="${esc(member.id)}" type="button">+ Salio</button>
        <button class="btn ghost small" data-action="debit" data-id="${esc(member.id)}" type="button">− Salio</button>
        <button class="btn ghost small" data-action="password" data-id="${esc(member.id)}" type="button">Password</button>
        <button class="btn ghost small" data-action="block" data-id="${esc(member.id)}" type="button">${member.withdrawBlocked ? 'Ruhusu uondoaji' : 'Zuia uondoaji'}</button>
        <button class="btn danger small" data-action="delete" data-id="${esc(member.id)}" type="button">Futa</button>
      </div>
    </div>`;
}

function viewMembers() {
  const filter = state.memberFilter;
  return `
    <section class="card hero">
      <h2>Wanachama wote</h2>
      <p class="muted small">Tenganisha waliodeposit/kukodisha meli na waliojisajili tu.</p>
    </section>
    <div class="card">
      <div class="filters">
        <label class="field inline"><span>Kundi</span>
          <select id="member-filter">
            <option value="all"${filter === 'all' ? ' selected' : ''}>Wote</option>
            <option value="active"${filter === 'active' ? ' selected' : ''}>Waliodeposit / kukodisha meli</option>
            <option value="registered"${filter === 'registered' ? ' selected' : ''}>Waliojisajili tu</option>
          </select>
        </label>
        <label class="field inline grow"><span>Tafuta kwa namba</span>
          <input id="member-search" value="${esc(state.memberSearch)}" placeholder="mfano 0712…" />
        </label>
        <button class="btn ghost small" data-action="reload-members" type="button">Chuja</button>
      </div>
      <div class="list">
        ${state.members.length ? state.members.map(memberRow).join('') : '<p class="muted small">Hakuna mwanachama anayelingana na kichujio.</p>'}
      </div>
    </div>`;
}

/* ---------------------------- deposit numbers --------------------------- */

function viewNumbers() {
  const settings = state.settings;
  if (!settings) return '<div class="card"><p class="muted">Inapakia…</p></div>';
  const methods = settings.depositMethods || [];
  const numbers = settings.depositNumbers || [];
  return `
    <section class="card hero">
      <h2>Namba za malipo</h2>
      <p class="muted small">Hizi ni akaunti wanachama wanazotumia kuweka deposit.</p>
    </section>
    <form class="card" id="numbers-form">
      <div class="section-title"><h3>Akaunti za deposit</h3></div>
      <div id="method-rows">
        ${methods.map((method, index) => methodRow(method, index)).join('')}
      </div>
      <button class="btn ghost small" data-action="add-method" type="button">+ Ongeza akaunti</button>
      <div class="section-title" style="margin-top:18px"><h3>Namba za ziada</h3></div>
      <div id="number-rows">
        ${numbers.map((number, index) => numberRow(number, index)).join('')}
      </div>
      <button class="btn ghost small" data-action="add-number" type="button">+ Ongeza namba</button>
      <div class="form-actions">
        <button class="btn primary" type="submit">Hifadhi namba</button>
      </div>
    </form>`;
}

function methodRow(method, index) {
  return `
    <div class="grid-row" data-method-row="${index}">
      <label class="field"><span>Jina la akaunti</span>
        <input data-method="label" value="${esc(method.label || '')}" placeholder="M-Pesa / CRDB" />
      </label>
      <label class="field"><span>Namba ya malipo</span>
        <input data-method="account" value="${esc(method.account || '')}" placeholder="0754…" />
      </label>
      <label class="field"><span>Jina la mmiliki</span>
        <input data-method="holder" value="${esc(method.holder || '')}" placeholder="Ship Transfer Ltd" />
      </label>
      <label class="field"><span>Aina</span>
        <select data-method="channel">
          <option value="mobile_money"${method.channel !== 'bank' ? ' selected' : ''}>Simu</option>
          <option value="bank"${method.channel === 'bank' ? ' selected' : ''}>Benki</option>
        </select>
      </label>
      <input type="hidden" data-method="id" value="${esc(method.id || '')}" />
      <button class="btn danger small" data-action="remove-method" data-index="${index}" type="button">Ondoa</button>
    </div>`;
}

function numberRow(number, index) {
  return `
    <div class="grid-row" data-number-row="${index}">
      <label class="field"><span>Maelezo</span>
        <input data-number="label" value="${esc(number.label || '')}" placeholder="Namba ya duka" />
      </label>
      <label class="field"><span>Namba</span>
        <input data-number="number" value="${esc(number.number || '')}" placeholder="0754…" />
      </label>
      <input type="hidden" data-number="id" value="${esc(number.id || '')}" />
      <button class="btn danger small" data-action="remove-number" data-index="${index}" type="button">Ondoa</button>
    </div>`;
}

/* ------------------------------- settings ------------------------------- */

function viewSettings() {
  return `
    <section class="card hero">
      <h2>Mipangilio ya admin</h2>
      <p class="muted small">Badilisha password ya panel. Wanachama hawaioni sehemu hii.</p>
    </section>
    <form class="card" id="admin-password-form">
      <div class="section-title"><h3>Badilisha password</h3></div>
      <label class="field"><span>Password ya sasa</span>
        <input name="currentPassword" type="password" autocomplete="current-password" required />
      </label>
      <label class="field"><span>Password mpya (angalau herufi 8)</span>
        <input name="newPassword" type="password" minlength="8" autocomplete="new-password" required />
      </label>
      <label class="field"><span>Rudia password mpya</span>
        <input name="confirmPassword" type="password" minlength="8" autocomplete="new-password" required />
      </label>
      <div class="form-actions"><button class="btn primary" type="submit">Hifadhi password</button></div>
    </form>`;
}

/* --------------------------------- modal -------------------------------- */

function renderModal() {
  const root = document.getElementById('modal-root');
  if (!root) return;
  if (!state.modal) {
    root.innerHTML = '';
    return;
  }
  const modal = state.modal;
  root.innerHTML = `
    <div class="modal-backdrop" data-action="close-modal">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="section-title"><h3>${esc(modal.title)}</h3>
          <button class="btn ghost small" data-action="close-modal" type="button">✕</button>
        </div>
        ${modal.body}
      </div>
    </div>`;
}

function openModal(title, body) {
  state.modal = { title, body };
  renderModal();
}

function closeModal() {
  state.modal = null;
  renderModal();
}

function balanceModal(member, direction) {
  openModal(
    direction === 'add' ? `Ongeza salio · ${member.phone}` : `Punguza salio · ${member.phone}`,
    `<form id="balance-form" class="form" novalidate>
      <p class="muted small">Salio la sasa: ${tzs(member.balance)}</p>
      <label class="field"><span>Kiasi (TZS)</span>
        <input name="amount" type="number" min="1" step="1" required />
      </label>
      <label class="field"><span>Maelezo (si lazima)</span>
        <input name="note" maxlength="200" />
      </label>
      <input type="hidden" name="direction" value="${direction}" />
      <input type="hidden" name="id" value="${esc(member.id)}" />
      <div class="form-actions">
        <button class="btn primary" type="submit">${direction === 'add' ? 'Ongeza' : 'Punguza'}</button>
        <button class="btn ghost" data-action="close-modal" type="button">Ghairi</button>
      </div>
    </form>`,
  );
}

function passwordModal(member, password, available) {
  openModal(
    `Password ya ${member.phone}`,
    `<p class="muted small">Password hii inatumiwa na mwanachama kuingia kwenye website.</p>
     <div class="code-box">${available ? esc(password) : 'Hakuna password iliyohifadhiwa kwa akaunti hii (imewekwa kabla ya mfumo huu).'}</div>
     <div class="form-actions"><button class="btn ghost" data-action="close-modal" type="button">Funga</button></div>`,
  );
}

function blockModal(member) {
  const blocked = member.withdrawBlocked;
  openModal(
    blocked ? `Ruhusu uondoaji · ${member.phone}` : `Zuia uondoaji · ${member.phone}`,
    `<form id="block-form" class="form" novalidate>
      <p class="muted small">${blocked ? 'Mwanachama huyu hawezi kutoa pesa. Unaweza kumruhusu tena.' : 'Mwanachama hataweza kuomba uondoaji hadi utakapomruhusu.'}</p>
      <label class="field"><span>Sababu (si lazima)</span>
        <input name="reason" maxlength="160" value="${esc(member.withdrawBlockReason || '')}" />
      </label>
      <input type="hidden" name="blocked" value="${blocked ? '0' : '1'}" />
      <input type="hidden" name="id" value="${esc(member.id)}" />
      <div class="form-actions">
        <button class="btn ${blocked ? 'primary' : 'danger'}" type="submit">${blocked ? 'Ruhusu uondoaji' : 'Zuia uondoaji'}</button>
        <button class="btn ghost" data-action="close-modal" type="button">Ghairi</button>
      </div>
    </form>`,
  );
}

function deleteModal(member) {
  openModal(
    `Futa account · ${member.phone}`,
    `<form id="delete-form" class="form" novalidate>
      <p class="muted small">Hatua hii inafuta mwanachama pamoja na historia yake na hairejeshwi. Andika namba ${esc(member.phone)} kuthibitisha.</p>
      <label class="field"><span>Thibitisha namba ya mwanachama</span>
        <input name="confirmPhone" required />
      </label>
      <input type="hidden" name="id" value="${esc(member.id)}" />
      <div class="form-actions">
        <button class="btn danger" type="submit">Futa account</button>
        <button class="btn ghost" data-action="close-modal" type="button">Ghairi</button>
      </div>
    </form>`,
  );
}

async function memberDetailModal(id) {
  openModal('Inapakia…', '<p class="muted small">Inapakia taarifa za mwanachama…</p>');
  try {
    const data = await api(`/api/admin/users/${encodeURIComponent(id)}`);
    const member = data.member;
    const txns = (data.transactions || []).slice(0, 15);
    openModal(
      `Mwanachama ${member.phone}`,
      `<div class="kv-grid">
        <div><span>Salio</span><b>${tzs(member.balance)}</b></div>
        <div><span>Mtaji</span><b>${tzs(member.capital)}</b></div>
        <div><span>Faida jumla</span><b>${tzs(member.totalProfit)}</b></div>
        <div><span>Bonasi</span><b>${tzs(member.totalBonus)}</b></div>
        <div><span>Ameweka</span><b>${tzs(member.deposited)}</b></div>
        <div><span>Meli hai</span><b>${member.activeInvestments}</b></div>
        <div><span>Kundi</span><b>${member.group === 'active' ? 'Ameweka / amekodisha' : 'Amejisajili tu'}</b></div>
        <div><span>Uondoaji</span><b>${member.withdrawBlocked ? 'Umezuiwa' : 'Umeruhusiwa'}</b></div>
      </div>
      <div class="section-title" style="margin-top:14px"><h3>Historia ya karibuni</h3></div>
      <div class="list compact">
        ${txns.length
          ? txns
              .map(
                (t) => `<div class="row"><div class="row-main"><strong>${esc(t.label)} · ${tzs(t.amount)}</strong>
                  <span>${esc(t.status)} · ${esc(fmtDate(t.createdAt))}</span></div></div>`,
              )
              .join('')
          : '<p class="muted small">Hakuna historia bado.</p>'}
      </div>
      <div class="form-actions"><button class="btn ghost" data-action="close-modal" type="button">Funga</button></div>`,
    );
  } catch (err) {
    toast(err.message, true);
    closeModal();
  }
}

/* -------------------------------- actions ------------------------------- */

async function refreshAll() {
  const [overview, requests] = await Promise.all([
    api('/api/admin/overview'),
    api(`/api/admin/requests?status=${state.requestFilter.status}&type=${state.requestFilter.type}`),
  ]);
  state.overview = overview;
  state.requests = requests.requests || [];
}

async function loadMembers() {
  const query = new URLSearchParams({ filter: state.memberFilter });
  if (state.memberSearch) query.set('q', state.memberSearch);
  const data = await api(`/api/admin/users?${query.toString()}`);
  state.members = data.members || [];
}

async function loadSettings() {
  state.settings = await api('/api/admin/settings');
}

function findMember(id) {
  return state.members.find((member) => member.id === id) || { id, phone: '…' };
}

async function decide(id, decision) {
  if (state.busy) return;
  state.busy = true;
  try {
    await api(`/api/admin/requests/${encodeURIComponent(id)}/decision`, {
      method: 'POST',
      body: { action: decision },
    });
    toast(decision === 'approve' ? 'Ombi limeidhinishwa.' : 'Ombi limekataliwa.');
    await refreshAll();
    if (state.tab === 'members') await loadMembers();
    renderTab();
  } catch (err) {
    toast(err.message, true);
  } finally {
    state.busy = false;
  }
}

function collectMethods() {
  return Array.from(document.querySelectorAll('[data-method-row]')).map((row, index) => ({
    id: row.querySelector('[data-method="id"]').value || `method-${index + 1}`,
    label: row.querySelector('[data-method="label"]').value.trim(),
    account: row.querySelector('[data-method="account"]').value.trim(),
    holder: row.querySelector('[data-method="holder"]').value.trim(),
    channel: row.querySelector('[data-method="channel"]').value,
  }));
}

function collectNumbers() {
  return Array.from(document.querySelectorAll('[data-number-row]')).map((row, index) => ({
    id: row.querySelector('[data-number="id"]').value || `number-${index + 1}`,
    label: row.querySelector('[data-number="label"]').value.trim(),
    number: row.querySelector('[data-number="number"]').value.trim(),
  }));
}

/* -------------------------------- wiring -------------------------------- */

document.addEventListener('click', async (event) => {
  const trigger = event.target.closest('[data-action]');
  if (!trigger) return;
  const action = trigger.dataset.action;
  const id = trigger.dataset.id;

  if (action === 'close-modal') {
    if (event.target === trigger || trigger.tagName === 'BUTTON') closeModal();
    return;
  }

  if (action === 'logout') {
    try {
      await api('/api/admin/logout', { method: 'POST' });
    } catch (_err) {
      /* session may already be gone */
    }
    signOutLocally();
    return;
  }

  if (action === 'refresh') {
    await refreshAll();
    renderTab();
    toast('Data imesasishwa.');
    return;
  }

  if (action === 'reload-requests') {
    const type = document.getElementById('request-type');
    const status = document.getElementById('request-status');
    state.requestFilter = { type: type.value, status: status.value };
    const data = await api(`/api/admin/requests?status=${status.value}&type=${type.value}`);
    state.requests = data.requests || [];
    renderTab();
    return;
  }

  if (action === 'reload-members') {
    state.memberFilter = document.getElementById('member-filter').value;
    state.memberSearch = document.getElementById('member-search').value.trim();
    await loadMembers();
    renderTab();
    return;
  }

  if (action === 'decide') return decide(id, trigger.dataset.decision);

  if (action === 'open-member') return memberDetailModal(id);

  if (action === 'credit' || action === 'debit') {
    return balanceModal(findMember(id), action === 'credit' ? 'add' : 'subtract');
  }

  if (action === 'password') {
    try {
      const data = await api(`/api/admin/users/${encodeURIComponent(id)}/password`);
      passwordModal({ id, phone: data.phone }, data.password, data.available);
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }

  if (action === 'block') return blockModal(findMember(id));
  if (action === 'delete') return deleteModal(findMember(id));

  if (action === 'add-method') {
    const methods = collectMethods();
    methods.push({ id: '', label: '', account: '', holder: '', channel: 'mobile_money' });
    state.settings.depositMethods = methods;
    document.getElementById('method-rows').innerHTML = methods.map(methodRow).join('');
    return;
  }

  if (action === 'remove-method') {
    const methods = collectMethods();
    methods.splice(Number(trigger.dataset.index), 1);
    state.settings.depositMethods = methods;
    document.getElementById('method-rows').innerHTML = methods.map(methodRow).join('');
    return;
  }

  if (action === 'add-number') {
    const numbers = collectNumbers();
    numbers.push({ id: '', label: '', number: '' });
    state.settings.depositNumbers = numbers;
    document.getElementById('number-rows').innerHTML = numbers.map(numberRow).join('');
    return;
  }

  if (action === 'remove-number') {
    const numbers = collectNumbers();
    numbers.splice(Number(trigger.dataset.index), 1);
    state.settings.depositNumbers = numbers;
    document.getElementById('number-rows').innerHTML = numbers.map(numberRow).join('');
  }
});

document.addEventListener('submit', async (event) => {
  const form = event.target;

  if (form.id === 'balance-form') {
    event.preventDefault();
    const body = {};
    new FormData(form).forEach((value, key) => {
      body[key] = String(value).trim();
    });
    try {
      await api(`/api/admin/users/${encodeURIComponent(body.id)}/balance`, {
        method: 'POST',
        body: { direction: body.direction, amount: Number(body.amount), note: body.note },
      });
      toast(body.direction === 'add' ? 'Salio limeongezwa.' : 'Salio limepunguzwa.');
      closeModal();
      await Promise.all([refreshAll(), loadMembers()]);
      renderTab();
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }

  if (form.id === 'block-form') {
    event.preventDefault();
    const body = {};
    new FormData(form).forEach((value, key) => {
      body[key] = String(value).trim();
    });
    try {
      await api(`/api/admin/users/${encodeURIComponent(body.id)}/withdraw-block`, {
        method: 'POST',
        body: { blocked: body.blocked === '1', reason: body.reason },
      });
      toast('Hali ya uondoaji imebadilishwa.');
      closeModal();
      await loadMembers();
      renderTab();
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }

  if (form.id === 'delete-form') {
    event.preventDefault();
    const body = {};
    new FormData(form).forEach((value, key) => {
      body[key] = String(value).trim();
    });
    try {
      await api(`/api/admin/users/${encodeURIComponent(body.id)}/delete`, {
        method: 'POST',
        body: { confirmPhone: body.confirmPhone },
      });
      toast('Account imefutwa.');
      closeModal();
      await Promise.all([refreshAll(), loadMembers()]);
      renderTab();
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }

  if (form.id === 'numbers-form') {
    event.preventDefault();
    try {
      const saved = await api('/api/admin/settings', {
        method: 'PUT',
        body: { depositMethods: collectMethods(), depositNumbers: collectNumbers() },
      });
      state.settings = saved;
      renderTab();
      toast('Namba za malipo zimehifadhiwa.');
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }

  if (form.id === 'admin-password-form') {
    event.preventDefault();
    const body = {};
    new FormData(form).forEach((value, key) => {
      body[key] = String(value);
    });
    if (body.newPassword !== body.confirmPassword) {
      toast('Password mpya hazifanani.', true);
      return;
    }
    try {
      await api('/api/admin/password', {
        method: 'POST',
        body: { currentPassword: body.currentPassword, newPassword: body.newPassword },
      });
      form.reset();
      toast('Password ya admin imebadilishwa.');
    } catch (err) {
      toast(err.message, true);
    }
  }
});

/* --------------------------------- boot --------------------------------- */

async function boot() {
  if (!state.token) {
    renderLogin();
    return;
  }
  try {
    const session = await api('/api/admin/session');
    state.admin = session.admin;
  } catch (err) {
    renderLogin(err.message);
    return;
  }
  renderShell();
  await Promise.all([refreshAll(), loadMembers(), loadSettings()]);
  renderTab();
}

boot();
