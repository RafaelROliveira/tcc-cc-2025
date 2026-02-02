/* ====================== util & bridge ====================== */
function send(msg) { return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve)); }
function $(sel) { return document.querySelector(sel); }
function el(tag, opts = {}) { const e = document.createElement(tag); Object.assign(e, opts); return e; }

/* ===== Flag global: extensão habilitada/desabilitada ===== */
let EXT_ON = false;

let AUTH_OK = false;
let PASSWORD_HASH = null;

// Evita rebind dos listeners globais (delegação)
let __ACC_BOUND = false;
let __DIM_BOUND = false;

// ---- Acordeon: controle de binding por elemento
const __BOUND_TOGGLES = new WeakSet();
let __ACC_OBS = null;


async function sha256(text) {
  const res = await send({ type: 'HASH_SHA256', text });
  return res.hash;
}

async function loadState() {
  const state = await send({ type: 'GET_STATE' });
  PASSWORD_HASH = state.settings?.passwordHash || null;
  return state;
}

/* ====================== auth UI ====================== */
function hideAuthShowMain() {
  $('#auth-section')?.remove();
  $('#main')?.classList.remove('hidden');
}

function showAuthUI() {
  const hasPass = !!PASSWORD_HASH;
  $('#set-pass')?.classList.toggle('hidden', hasPass);
  $('#login-pass')?.classList.toggle('hidden', !hasPass);
}

function showMainUI(show) { $('#main')?.classList.toggle('hidden', !show); }

async function ensureAuth() {
  const state = await loadState();
  showAuthUI();
  if (!PASSWORD_HASH) {
    showMainUI(false);
  } else {
    showMainUI(AUTH_OK);
  }
  if (AUTH_OK) {
    hideAuthShowMain();
    await hydrate(state);
  }
}

/* ============== dim automático por “master” ============== */
function applyDimForSection(cardEl) {
  const masterSel = cardEl?.getAttribute('data-master');
  if (!masterSel) return;

  const master = document.querySelector(masterSel);
  if (!master) return;

  const on = !!master.checked;
  cardEl.classList.toggle('dim', !on);

  // Desabilita controles, mas preserva o botão de cabeçalho (.collapse-toggle)
  const controls = cardEl.querySelectorAll('input, select, button, textarea');
  controls.forEach(el => {
    if (el === master) return;
    if (el.closest('.collapse-toggle')) return;
    el.disabled = !on;
  });
}


function wireAutoDim() {
  if (__DIM_BOUND) return;
  __DIM_BOUND = true;

  document.querySelectorAll('.dimmable').forEach(card => {
    applyDimForSection(card);
    const masterSel = card.getAttribute('data-master');
    const master = document.querySelector(masterSel);
    master?.addEventListener('change', () => applyDimForSection(card));
  });

  const mo = new MutationObserver(() => {
    document.querySelectorAll('.dimmable').forEach(card => {
      applyDimForSection(card);
    });
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
}


/* ====================== Status card ====================== */
function modeHelpText(mode) {
  return (mode === 'allowlist')
    ? 'Permite os sites que você adicionar à lista de permitidos. O restante fica bloqueado.'
    : 'Bloqueia os sites que você adicionar à lista de bloqueados. O restante abre normalmente.';
}

function updateStatusCardUI(enabled) {
  const card = $('#status-card');
  const pill = $('#status-pill');
  if (!card || !pill) return;

  EXT_ON = !!enabled;

  card.classList.toggle('is-on', EXT_ON);
  if (EXT_ON) {
    pill.textContent = 'Habilitado';
    pill.classList.remove('bad'); pill.classList.add('ok');
  } else {
    pill.textContent = 'Desabilitado';
    pill.classList.remove('ok'); pill.classList.add('bad');
  }
}

function syncModeHelpFromSelect() {
  const sel = $('#mode');
  const help = $('#mode-help');
  if (sel && help) help.textContent = modeHelpText(sel.value);
}

/* ===== Badge util (usa EXT_ON) ===== */
function setBadgeUsage({ badgeEl, cardEl, active }) {
  if (!badgeEl || !cardEl) return;

  const show = !!(EXT_ON && active);

  // "apaga" só o corpo do card
  const body = cardEl.querySelector('.collapse-body');
  if (body) {
    if (EXT_ON && !active) {
      cardEl.classList.add('dimmable', 'dim');
    } else {
      cardEl.classList.remove('dim');
    }
  }

  // badge
  badgeEl.textContent = show ? 'Em uso' : '';
  badgeEl.title = show ? 'Este conjunto está ativo no modo atual' : '';
  badgeEl.classList.toggle('hidden', !show);
}


/* Mostra "Em uso" quando ativo, esconde quando inativo */
function updateBadge(card, active) {
  const badge = card.querySelector('.mode-badge');
  if (!badge) return;
  setBadgeUsage({ badgeEl: badge, cardEl: card, active });
}

/* ===== Listas: allow/block + badges por modo ===== */
function normalizeMode(val) {
  if (!val) return 'blocklist';
  const v = String(val).toLowerCase();
  if (v === 'allow' || v === 'allowlist' || v === 'allowlist_strict') return 'allowlist';
  if (v === 'block' || v === 'blocklist') return 'blocklist';
  return 'blocklist';
}

function refreshModeUI() {
  // Le e normaliza o modo atual
  const mode = normalizeMode(document.querySelector('#mode')?.value);

  // Cards
  const allowCard = document.querySelector('#card-allow');
  const blockCard = document.querySelector('#card-block');

  // Limpa destaque anterior
  [allowCard, blockCard].forEach((c) => c && c.classList.remove('is-active'));

  // Destaca SOMENTE o card do modo atual
  if (mode === 'allowlist') {
    allowCard && allowCard.classList.add('is-active');
  } else {
    blockCard && blockCard.classList.add('is-active');
  }

  const isActiveAllow = (mode === 'allowlist');
  const isActiveBlock = (mode === 'blocklist');

  updateBadge(allowCard, isActiveAllow);
  updateBadge(blockCard, isActiveBlock);
}


/* ====================== Category viewer (modal) ====================== */
function applyCatFilter() {
  const q = ($('#catv-filter')?.value || '').trim().toLowerCase();
  const rows = Array.from(document.querySelectorAll('#catv-list .cat-row'));
  let shown = 0;
  rows.forEach(r => {
    const d = r.dataset.domain || '';
    const show = !q || d.includes(q);
    r.style.display = show ? '' : 'none';
    if (show) shown++;
  });
  const counter = $('#catv-counter');
  if (counter) counter.textContent = shown ? `${shown} itens` : 'Nenhum resultado';
}
function closeCategoryViewer() {
  $('#cat-viewer')?.classList.add('hidden');
  $('#catv-list') && ($('#catv-list').innerHTML = '');
  if ($('#catv-filter')) $('#catv-filter').value = '';
}
$('#catv-close')?.addEventListener('click', closeCategoryViewer);
$('#catv-close2')?.addEventListener('click', closeCategoryViewer);
$('#catv-filter')?.addEventListener('input', applyCatFilter);

async function toggleCategoryException(catId, domain) {
  const st = await send({ type: 'GET_STATE' });
  const lists = st.lists || {};
  lists.categoryExceptions = lists.categoryExceptions || {};
  const arr = lists.categoryExceptions[catId] || [];
  const i = arr.indexOf(domain);
  if (i === -1) arr.push(domain); else arr.splice(i, 1);
  lists.categoryExceptions[catId] = arr;
  await send({ type: 'SET_LISTS', payload: lists });
  await send({ type: 'SYNC_RULES' });
  return arr;
}

function openCategoryViewer(catId, domains, exceptions) {
  $('#catv-title').textContent = `Categoria: ${catId}`;
  const list = $('#catv-list'); list.innerHTML = '';

  const exc = new Set(exceptions || []);
  domains.forEach(d => {
    const row = el('div', { className: 'cat-row' });
    row.dataset.domain = d;
    row.appendChild(el('span', { className: 'd', innerText: d }));

    const isExc = exc.has(d);
    const btn = el('button', { className: `tag ${isExc ? 'allow' : 'block'}`, innerText: isExc ? 'Permitido' : 'Bloqueado' });
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const arr = await toggleCategoryException(catId, d);
      const nowExc = arr.includes(d);
      btn.className = `tag ${nowExc ? 'allow' : 'block'}`;
      btn.textContent = nowExc ? 'Permitido' : 'Bloqueado';
      await ensureAuth();
    });


    row.appendChild(btn);
    list.appendChild(row);
  });

  $('#cat-viewer').classList.remove('hidden');
  applyCatFilter();
}

/* ============== Render de Categorias + badge ============== */
function categoriesActiveFromDOM() {
  return !!document.querySelector('#categories input[type="checkbox"]:checked');
}

function updateCategoriesBadge() {
  const badge = document.getElementById('badge-categories');
  const card = document.getElementById('card-categories');
  const active = categoriesActiveFromDOM();
  setBadgeUsage({ badgeEl: badge, cardEl: card, active });
}

async function renderCategories(state) {
  const catsEl = $('#categories');
  if (!catsEl) return;

  const res = await fetch(chrome.runtime.getURL('assets/categories.json'));
  const catData = await res.json();

  const enabledMap = state.lists?.categories || {};
  const exceptionsMap = state.lists?.categoryExceptions || {};

  const frag = document.createDocumentFragment();

  for (const [catId, domains] of Object.entries(catData)) {
    const checked = !!enabledMap[catId];
    const exceptions = Array.isArray(exceptionsMap[catId]) ? exceptionsMap[catId] : [];
    const excCount = exceptions.length;
    const total = Array.isArray(domains) ? domains.length : 0;

    const row = el('label', { className: 'ck' });
    const input = el('input', { type: 'checkbox', checked, 'data-id': catId });

    input.addEventListener('change', async (e) => {
      const s = await send({ type: 'GET_STATE' });
      const lists2 = s.lists || {};
      lists2.categories = { ...(lists2.categories || {}), [catId]: e.target.checked };
      await send({ type: 'SET_LISTS', payload: lists2 });
      await send({ type: 'SYNC_RULES' });
      updateCategoriesBadge();
    });

    row.appendChild(input);
    row.appendChild(el('span', { className: 'ck-box', ariaHidden: 'true' }));
    row.appendChild(el('span', { className: 'ck-label', innerText: catId }));
    row.appendChild(el('span', {
      className: 'ck-count',
      innerText: excCount
        ? `${total} domínios • ${excCount} permitido${excCount > 1 ? 's' : ''}`
        : `${total} domínios`
    }));

    const btnView = el('button', { type: 'button', className: 'ck-view', innerText: 'Ver' });
    btnView.addEventListener('click', (e) => {
      e.stopPropagation();
      openCategoryViewer(catId, domains, exceptions);
    });
    row.appendChild(btnView);


    frag.appendChild(row);
  }

  catsEl.replaceChildren(frag);
  updateCategoriesBadge();
}

/* ============== Accordions ============== */
function toggleCollapse(btn) {
  const targetId = btn.getAttribute('aria-controls');
  const body = document.getElementById(targetId);
  const key = 'ui:' + targetId;

  const isOpen = btn.getAttribute('aria-expanded') === 'true';
  const next = !isOpen;

  btn.setAttribute('aria-expanded', String(next));
  localStorage.setItem(key, next ? '1' : '0');

  if (!body) return;

  if (next) {
    // ABRIR
    body.hidden = false;
    requestAnimationFrame(() => { body.dataset.open = 'true'; });
  } else {
    // FECHAR
    body.dataset.open = 'false';
    const onEnd = (e) => {
      if (e.propertyName !== 'grid-template-rows') return;
      body.hidden = true;
      body.removeEventListener('transitionend', onEnd);
    };
    body.addEventListener('transitionend', onEnd, { once: true });

    // fallback caso o transitionend não dispare
    setTimeout(() => {
      if (body.dataset.open === 'false') body.hidden = true;
    }, 350);
  }
}

function onCollapseClick(ev) {
  const btn = ev.target.closest('.collapse-toggle');
  if (!btn) return;
  toggleCollapse(btn);
}

function onCollapseKeydown(ev) {
  const btn = ev.target.closest('.collapse-toggle');
  if (!btn) return;
  if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
    ev.preventDefault();
    toggleCollapse(btn);
  }
}

function initCollapseButton(btn) {
  if (!btn || __BOUND_TOGGLES.has(btn)) return;

  // Estado inicial a partir do localStorage
  const targetId = btn.getAttribute('aria-controls');
  const body = document.getElementById(targetId);
  const key = 'ui:' + targetId;
  const saved = localStorage.getItem(key) === '1';

  btn.setAttribute('aria-expanded', String(saved));
  if (body) {
    body.hidden = !saved;
    body.dataset.open = String(saved);
  }

  btn.addEventListener('click', () => toggleCollapse(btn), { passive: false });

  // Teclado (Enter/Espaço)
  btn.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
      ev.preventDefault();
      toggleCollapse(btn);
    }
  }, { passive: false });

  __BOUND_TOGGLES.add(btn);
}


function bindAccordions() {
  // Liga os botões já existentes
  document.querySelectorAll('.collapse-toggle').forEach(initCollapseButton);

  // Observa mudanças no DOM para ligar botões que apareçam depois
  if (__ACC_OBS) return;
  __ACC_OBS = new MutationObserver((mutList) => {
    for (const mut of mutList) {
      // Novos nós
      mut.addedNodes && mut.addedNodes.forEach((n) => {
        if (!(n instanceof Element)) return;
        if (n.classList?.contains('collapse-toggle')) {
          initCollapseButton(n);
        } else {
          n.querySelectorAll?.('.collapse-toggle').forEach(initCollapseButton);
        }
      });
    }
  });
  __ACC_OBS.observe(document.body, { childList: true, subtree: true });
}

/* ============== Advanced <details> state ============== */
async function restoreAdvancedOpen() {
  const st = await new Promise(r => chrome.storage.local.get({ ui: { advOpen: false } }, r));
  const adv = $('#advanced');
  if (adv) adv.open = !!(st.ui?.advOpen);
}
function bindAdvancedToggle() {
  const adv = $('#advanced');
  adv?.addEventListener('toggle', async () => {
    await chrome.storage.local.set({ ui: { advOpen: adv.open } });
  });
}

/* ====================== Search protections (UNIFICADO) ====================== */
async function loadSearchHardening() {
  return new Promise(r =>
    chrome.storage.local.get({
      searchHardening: { blockImageSearch: false, blockVideos: false, forceSafe: false }
    }, r)
  );
}
async function renderSearchHardening() {
  const st = await loadSearchHardening();
  const cfg = st.searchHardening || {};
  const i1 = $('#sh-images'); if (i1) i1.checked = !!cfg.blockImageSearch;
  const i2 = $('#sh-videos'); if (i2) i2.checked = !!cfg.blockVideos;
  const i3 = $('#sh-safesearch'); if (i3) i3.checked = !!cfg.forceSafe;
}
['#sh-images', '#sh-videos', '#sh-safesearch'].forEach(sel => {
  document.querySelector(sel)?.addEventListener('change', async () => {
    const st = await loadSearchHardening();
    const old = st.searchHardening || {};
    const cfg = {
      blockImageSearch: $('#sh-images')?.checked ?? !!old.blockImageSearch,
      blockVideos: $('#sh-videos')?.checked ?? !!old.blockVideos,
      forceSafe: $('#sh-safesearch')?.checked ?? !!old.forceSafe,
    };
    await chrome.storage.local.set({ searchHardening: cfg });
    await send({ type: 'SYNC_RULES' });
    await updateSearchBadge();
  });
});
function searchActive(cfg) {
  return !!(cfg.blockImageSearch || cfg.blockVideos || cfg.forceSafe);
}
async function updateSearchBadge() {
  const st = await chrome.storage.local.get({
    searchHardening: { blockImageSearch: false, blockVideos: false, forceSafe: false }
  });
  const cfg = st.searchHardening || {};
  const anyOn = !!(cfg.blockImageSearch || cfg.blockVideos || cfg.forceSafe);

  const badge = document.getElementById('badge-search');
  const card = document.getElementById('card-search');

  setBadgeUsage({ badgeEl: badge, cardEl: card, active: anyOn });
}

/* ====================== Study badge ====================== */
async function updateStudyBadge() {
  const st = await loadSchedule();
  const sch = st.schedule || {};
  const badge = document.getElementById('badge-study');
  const card = document.getElementById('card-study');
  if (!badge || !card) return; // caso o card não exista no HTML
  setBadgeUsage({ badgeEl: badge, cardEl: card, active: !!sch.enabled });
}

/* ====================== hydrate ====================== */
async function hydrate(state) {
  const settings = state.settings || {};
  const lists = state.lists || { allow: [], block: [], categories: {} };

  EXT_ON = !!settings.enabled;                               // << aqui também
  $('#enabled') && ($('#enabled').checked = EXT_ON);
  $('#mode') && ($('#mode').value = settings.mode || 'blocklist');

  refreshModeUI();
  updateStatusCardUI(EXT_ON);
  syncModeHelpFromSelect();

  renderList('#allow-list', lists.allow, (d) => removeDomain('allow', d));
  renderList('#block-list', lists.block, (d) => removeDomain('block', d));

  // Palavras-chave
  // const stCB = await new Promise(r => chrome.storage.local.get({ contentBlock: { enabled: false, sensitivity: 1, keywords: [] } }, r));
  // const contentCfg = stCB.contentBlock || { enabled: false, sensitivity: 1, keywords: [] };
  // $('#cb-enabled') && ($('#cb-enabled').checked = !!contentCfg.enabled);
  // $('#cb-sens') && ($('#cb-sens').value = String(contentCfg.sensitivity || 1));
  // renderKeywordList(contentCfg.keywords || []);

  // Schedule
  await renderSchedule();
  await updateStudyBadge();

  // Accordions e proteções
  bindAccordions();
  await renderSearchHardening();

  // Histórico
  if (!historyInitialized) {
    historyInitialized = true;
    await loadHistoryData(true);
  }


  // Dim
  wireAutoDim();
  await restoreAdvancedOpen();
  bindAdvancedToggle();

  // Badges
  await renderCategories(state);
  updateCategoriesBadge();
  await updateSearchBadge();
}

/* ====================== listas simples ====================== */
function renderList(sel, arr, onRemove) {
  const ul = document.querySelector(sel);
  if (!ul) return;
  ul.innerHTML = '';
  (arr || []).forEach((d) => {
    const li = el('li');
    li.appendChild(el('span', { innerText: d }));
    const btn = el('button', { innerText: '✖', className: 'btn-remover' });
    btn.addEventListener('click', () => onRemove(d));
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

async function removeDomain(kind, domain) {
  const state = await send({ type: 'GET_STATE' });
  const lists = state.lists || { allow: [], block: [] };
  lists[kind] = (lists[kind] || []).filter(d => d !== domain);
  await send({ type: 'SET_LISTS', payload: lists });
  await send({ type: 'SYNC_RULES' });
  await ensureAuth();
}

// ====================== Motivo de bloqueio/suspeita ======================
function getReason(entry) {
  try {
    const u = new URL(entry.url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();

    // transforma domínio em nome legível (YouTube)
    const name = host
      .split(".")[0]
      .replace(/-/g, " ")
      .replace(/\b\w/g, c => c.toUpperCase());

    // ---------------- BLOQUEADO ----------------
    if (entry.status === "blocked") {
      return `Tentou acessar o site bloqueado (${name}).`;
    }

    // ---------------- SUSPEITO ----------------
    if (entry.status === "suspicious") {
      // Detecta pesquisa no Google
      if (/google\.[^/]+\/search/i.test(entry.url)) {
        const params = new URLSearchParams(u.search);
        const q = params.get("q") || params.get("oq") || "";
        const cleanQ = q.replace(/site:|https?:\/\/|www\./gi, "").trim();

        if (cleanQ) {
          return `Pesquisa no Google com termos ou domínios bloqueados: “${cleanQ}”.`;
        } else {
          return "Pesquisa no Google contendo conteúdo potencialmente bloqueado.";
        }
      }

      // fallback
      return `Atividade suspeita detectada envolvendo o domínio (${name}).`;
    }

    // ---------------- PERMITIDO ----------------
    if (entry.status === "allowed") {
      return `Site permitido (${name}).`;
    }

    // fallback
    return "Motivo não identificado.";

  } catch {
    return "Não foi possível determinar o motivo (URL inválida).";
  }
}


/* ====================== histórico ====================== */
function renderHistory(items) {
  const tbody = $('#hist-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const rows = [...items].reverse().slice(0, 200);

  const fmtUrl = (u) => {
    try {
      const x = new URL(u);
      let path = (x.pathname || '') + (x.search || '');
      if (path.length > 120) path = path.slice(0, 117) + '…';
      return x.hostname + path;
    } catch {
      return u?.length > 120 ? (u.slice(0, 117) + '…') : u;
    }
  };

  rows.forEach((h) => {
    const tr = el('tr');

    const status = h.status || ((h.type === 'redirect' || h.type === 'blocked' || h.type === 'block') ? 'blocked' : 'allowed');
    let cls = 'hist-allow', label = 'Permitido', pill = 'ok';
    if (status === 'blocked') { cls = 'hist-block'; label = 'Bloqueado'; pill = 'bad'; }
    else if (status === 'suspicious') { cls = 'hist-susp'; label = 'Suspeito'; pill = 'warn'; }
    tr.className = cls;

    const date = new Date(h.ts);
    tr.appendChild(el('td', { innerText: date.toLocaleString() }));

    const tdS = el('td');
    const pillEl = el('span', { className: `pill ${pill}`, innerText: label });
    tdS.appendChild(pillEl);
    tr.appendChild(tdS);

    const tdU = el('td');
    const a = el('a', {
      href: h.url || '#',
      innerText: fmtUrl(h.url || ''),
      title: h.url || '',
      target: '_blank',
      rel: 'noopener'
    });
    tdU.appendChild(a);
    tr.appendChild(tdU);

    tbody.appendChild(tr);

    // Clique no selo abre o motivo 
    pillEl.addEventListener('click', () => {
      const existing = tr.nextSibling;
      const msg = getReason(h);

      // Se já existe linha de motivo - fecha
      if (existing && existing.classList.contains('hist-reason-row')) {
        existing.remove();
        pillEl.classList.remove('open');
        return;
      }

      // Fecha outros motivos abertos
      document.querySelectorAll('.hist-reason-row').forEach(r => r.remove());
      document.querySelectorAll('.pill.open').forEach(p => p.classList.remove('open'));

      // Marca este como aberto
      pillEl.classList.add('open');

      // Cria nova linha de motivo
      const reasonRow = el('tr', { className: 'hist-reason-row' });
      const td = el('td', {
        colSpan: 3,
        innerHTML: `<strong>${label}:</strong> ${msg || 'Motivo não identificado.'}`
      });
      reasonRow.appendChild(td);

      tr.insertAdjacentElement('afterend', reasonRow);
    });
  });
}

// ======= Utilitário para buscar dados do background =======
async function getAllState() {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ type: 'GET_ALL_STATE' }, (res) => {
        if (chrome.runtime.lastError) {
          console.error('Erro na comunicação com background:', chrome.runtime.lastError);
          reject(chrome.runtime.lastError);
          return;
        }
        resolve(res || {});
      });
    } catch (err) {
      console.error('Erro interno em getAllState:', err);
      reject(err);
    }
  });
}

// ========= cache + normalizadores =========
let HIST_ALL = []; 

function computeStatus(item) {
  const s = item.status || ((item.type === 'redirect' || item.type === 'blocked' || item.type === 'block') ? 'blocked' : 'allowed');
  return s; 
}

function normalizeFilterValue(v) {
  v = String(v || '').toLowerCase().trim();
  // cobre valores do <select> ou só rótulos em PT
  if (v === 'todos' || v === 'todas' || v === 'all') return 'all';
  if (v === 'permitido' || v === 'allowed') return 'allowed';
  if (v === 'bloqueado' || v === 'blocked') return 'blocked';
  if (v === 'suspeito' || v === 'suspeita' || v === 'suspicious') return 'suspicious';
  // fallback
  return 'all';
}

function domainBare(u) {
  try {
    const x = new URL(u);
    return x.hostname.replace(/^www\./, '');
  } catch { return ''; }
}

function textForSearch(u) {
  try {
    const x = new URL(u);
    // pesquisa em domínio "limpo" + pathname + query
    return (x.hostname.replace(/^www\./, '') + ' ' + (x.pathname || '') + ' ' + (x.search || '')).toLowerCase();
  } catch {
    return String(u || '').toLowerCase();
  }
}

function fmtUrl(u) {
  try {
    const x = new URL(u);
    let path = (x.pathname || '') + (x.search || '');
    if (path.length > 120) path = path.slice(0, 117) + '…';
    return x.hostname + path;
  } catch {
    return u?.length > 120 ? (u.slice(0, 117) + '…') : (u || '');
  }
}

// ========= render das linhas com expansão (suave) opcional =========
function renderHistoryRows(items) {
  const tbody = document.querySelector('#hist-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const rows = [...items].reverse().slice(0, 200);

  rows.forEach((h) => {
    const tr = document.createElement('tr');

    const status = computeStatus(h);
    let cls = 'hist-allow', label = 'Permitido', pill = 'ok';
    if (status === 'blocked') { cls = 'hist-block'; label = 'Bloqueado'; pill = 'bad'; }
    else if (status === 'suspicious') { cls = 'hist-susp'; label = 'Suspeito'; pill = 'warn'; }
    tr.className = cls;

    const date = new Date(h.ts);
    const tdWhen = document.createElement('td');
    tdWhen.innerText = date.toLocaleString();

    const tdType = document.createElement('td');
    const span = document.createElement('span');
    span.className = `pill ${pill}`;
    span.innerText = label;
    tdType.appendChild(span);

    const tdUrl = document.createElement('td');
    const a = document.createElement('a');
    a.href = h.url || '#';
    a.innerText = fmtUrl(h.url || '');
    a.title = h.url || '';
    a.target = '_blank';
    a.rel = 'noopener';
    tdUrl.appendChild(a);

    tr.appendChild(tdWhen);
    tr.appendChild(tdType);
    tr.appendChild(tdUrl);
    tbody.appendChild(tr);
  });
}

// ========= aplicação de filtros =========
function getFilterControls() {
  const qEl = document.getElementById('hist-search');
  const fEl = document.getElementById('hist-filter');
  const q = (qEl?.value || '').toLowerCase().trim();
  const fRaw = fEl ? (fEl.value || fEl.options?.[fEl.selectedIndex]?.text || '') : 'all';
  const f = normalizeFilterValue(fRaw);
  return { q, f };
}

function applyFiltersAndRender() {
  const { q, f } = getFilterControls();
  historyFilter = { q, f };

  container.classList.add("loading");

  // Reaplica lazy load com os filtros
  const filtered = historyData.filter((h) => {
    const status = computeStatus(h);
    const matchesFilter = (f === "all") || (status === f);
    if (!matchesFilter) return false;

    if (q) {
      const hay = textForSearch(h.url || "");
      return hay.includes(q);
    }
    return true;
  });

  filteredHistoryData = filtered;
  loadedCount = 0;

  tbody.style.opacity = "0";

  // Aguarda o fade e aplica lazy load
  setTimeout(() => {
    tbody.innerHTML = "";
    loadMoreRows(true);

    tbody.style.opacity = "1";
    container.classList.remove("loading");
  }, 180);
}



// ========= carregar e hidratar =========
async function loadAndRenderHistory() {
  try {
    const st = await getAllState();
    HIST_ALL = Array.isArray(st.history) ? st.history : [];
    applyFiltersAndRender();
  } catch (err) {
    console.error('Erro ao carregar histórico:', err);
  }
}

// ========= wire de eventos (com debounce) =========
(function wireHistoryFilters() {
  const qEl = document.getElementById('hist-search');
  const fEl = document.getElementById('hist-filter');

  let t = null;
  qEl?.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(applyFiltersAndRender, 150);
  });

  fEl?.addEventListener('change', applyFiltersAndRender);
})();

document.addEventListener('DOMContentLoaded', loadAndRenderHistory);

/* ====================== schedule ====================== */
async function loadSchedule() {
  return new Promise(r => chrome.storage.local.get({ schedule: { enabled: false, days: [1, 2, 3, 4, 5], start: '18:00', end: '20:00', studyAllow: [] } }, r));
}
function renderScheduleUI(sch) {
  $('#sch-enabled') && ($('#sch-enabled').checked = !!sch.enabled);
  $('#sch-start') && ($('#sch-start').value = sch.start || '18:00');
  $('#sch-end') && ($('#sch-end').value = sch.end || '20:00');
  document.querySelectorAll('.sch-day').forEach(cb => {
    cb.checked = (sch.days || []).includes(Number(cb.value));
  });
  const ul = $('#sch-allow-list'); if (!ul) return; ul.innerHTML = '';
  (sch.studyAllow || []).forEach((d) => {
    const li = el('li');
    li.appendChild(el('span', { innerText: d }));
    const btn = el('button', { innerText: '✖', className: 'btn-remover' });
    btn.addEventListener('click', async () => {
      const st = await loadSchedule(); const s = st.schedule;
      s.studyAllow = (s.studyAllow || []).filter(x => x !== d);
      await chrome.storage.local.set({ schedule: s });
      await renderSchedule();
      await send({ type: 'SYNC_RULES' });
    });
    li.appendChild(btn); ul.appendChild(li);
  });
  updateStudyBadge();
}
async function renderSchedule() {
  const st = await loadSchedule();
  renderScheduleUI(st.schedule || {});
}
$('#sch-enabled')?.addEventListener('change', async (e) => {
  const st = await loadSchedule(); const s = st.schedule; s.enabled = !!e.target.checked;
  await chrome.storage.local.set({ schedule: s });
  await send({ type: 'SYNC_RULES' });
  await updateStudyBadge();
});
['#sch-start', '#sch-end'].forEach(sel => {
  document.querySelector(sel)?.addEventListener('change', async () => {
    const st = await loadSchedule(); const s = st.schedule;
    s.start = $('#sch-start').value;
    s.end = $('#sch-end').value;
    await chrome.storage.local.set({ schedule: s });
    await send({ type: 'SYNC_RULES' });
    await updateStudyBadge();
  });
});
document.querySelectorAll('.sch-day').forEach(cb => {
  cb.addEventListener('change', async () => {
    const st = await loadSchedule(); const s = st.schedule;
    s.days = Array.from(document.querySelectorAll('.sch-day'))
      .filter(x => x.checked).map(x => Number(x.value));
    await chrome.storage.local.set({ schedule: s });
    await send({ type: 'SYNC_RULES' });
    await updateStudyBadge();
  });
});
$('#sch-allow-add')?.addEventListener('click', async () => {
  const input = $('#sch-allow-input');
  const v = (input?.value || '').trim().toLowerCase(); if (!v) return;
  const st = await loadSchedule(); const s = st.schedule; s.studyAllow = s.studyAllow || [];
  if (!s.studyAllow.includes(v)) s.studyAllow.push(v);
  input.value = '';
  await chrome.storage.local.set({ schedule: s });
  await renderSchedule();
  await send({ type: 'SYNC_RULES' });
});

/* ====================== add itens listas ====================== */
function normalizeDomain(v) {
  let s = (v || '').trim();
  if (!s) return '';
  try { if (s.includes('://')) s = new URL(s).hostname; } catch { }
  s = s.replace(/^www\./, '').toLowerCase();
  s = s.split('/')[0];
  return s;
}
$('#allow-add')?.addEventListener('click', async () => {
  const raw = $('#allow-input')?.value;
  const v = normalizeDomain(raw);
  if (!v) return;
  const state = await send({ type: 'GET_STATE' });
  const lists = state.lists || { allow: [], block: [], categories: {} };
  lists.allow = Array.isArray(lists.allow) ? lists.allow : [];
  if (!lists.allow.includes(v)) lists.allow.push(v);
  $('#allow-input').value = '';
  await send({ type: 'SET_LISTS', payload: lists });
  await send({ type: 'SYNC_RULES' });
  await ensureAuth();
});
$('#block-add')?.addEventListener('click', async () => {
  const raw = $('#block-input')?.value;
  const v = normalizeDomain(raw);
  if (!v) return;
  const state = await send({ type: 'GET_STATE' });
  const lists = state.lists || { allow: [], block: [], categories: {} };
  lists.block = Array.isArray(lists.block) ? lists.block : [];
  if (!lists.block.includes(v)) lists.block.push(v);
  $('#block-input').value = '';
  await send({ type: 'SET_LISTS', payload: lists });
  await send({ type: 'SYNC_RULES' });
  await ensureAuth();
});
['#allow-input', '#block-input'].forEach(sel => {
  document.querySelector(sel)?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      document.querySelector(sel === '#allow-input' ? '#allow-add' : '#block-add')?.click();
    }
  });
});

/* ====================== hist: export/clear. (UTILIZANDO SOMENTE CLEAR) ====================== */
$('#export-history')?.addEventListener('click', async () => {
  const res = await send({ type: 'EXPORT_HISTORY' });
  const blob = new Blob([JSON.stringify(res.history || [], null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: 'historico_controle_parental.json' });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('#clear-history')?.addEventListener('click', async () => {
  if (!confirm('Limpar todo o histórico?')) return;
  await send({ type: 'CLEAR_HISTORY' });
  await ensureAuth();
});

/* ====================== auth actions ====================== */
$('#btn-set-pass')?.addEventListener('click', async () => {
  const p1 = $('#new-pass')?.value; const p2 = $('#new-pass2')?.value;
  if (!p1 || p1.length < 4) return alert('Use ao menos 4 caracteres.');
  if (p1 !== p2) return alert('As senhas não coincidem.');
  const hash = await sha256(p1);
  await send({ type: 'SET_SETTINGS', payload: { passwordHash: hash } });
  PASSWORD_HASH = hash; AUTH_OK = true;
  hideAuthShowMain();
  await ensureAuth();
});
$('#btn-login')?.addEventListener('click', async () => {
  const input = $('#login-input')?.value || '';
  const hash = await sha256(input);
  if (hash === PASSWORD_HASH) {
    AUTH_OK = true;
    hideAuthShowMain();
    await ensureAuth();
  } else {
    alert('Senha incorreta.');
  }
});

/* ====================== status listeners ====================== */
(function bindStatusListeners() {
  const enabledEl = $('#enabled');
  const modeEl = $('#mode');

  enabledEl?.addEventListener('change', async (e) => {
    const on = !!e.target.checked;
    EXT_ON = on;
    await send({ type: 'SET_SETTINGS', payload: { enabled: on } });
    await send({ type: 'SYNC_RULES' });
    updateStatusCardUI(on);
    refreshModeUI();
    updateCategoriesBadge();
    updateSearchBadge();
    await updateStudyBadge();
  });

  modeEl?.addEventListener('change', async (e) => {
    await send({ type: 'SET_SETTINGS', payload: { mode: e.target.value } });
    await send({ type: 'SYNC_RULES' });
    refreshModeUI();
    syncModeHelpFromSelect();
  });
})();

/* ====================== storage sync (UNIFICADO) ====================== */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if (changes.settings) {
    const newMode = normalizeMode(changes.settings.newValue?.mode);
    const modeSel = document.querySelector('#mode');
    if (modeSel && newMode && modeSel.value !== newMode) {
      modeSel.value = newMode;
    }
    const enabled = !!changes.settings.newValue?.enabled;
    const enabledEl = document.querySelector('#enabled');
    if (enabledEl) enabledEl.checked = enabled;

    EXT_ON = enabled;
    updateStatusCardUI(enabled);
    refreshModeUI();
    updateCategoriesBadge();
    updateSearchBadge();
    updateStudyBadge();
  }

  if (changes.lists) {
    send({ type: 'GET_STATE' }).then(state => {
      renderCategories(state).then(() => {
        updateCategoriesBadge();
      });
    });
  }

  if (changes.schedule) {
    renderSchedule().then(updateStudyBadge);
  }

  if (changes.searchHardening) {
    updateSearchBadge();
  }
});

// ========== LAZY LOAD DO HISTÓRICO (FINAL COM GETREASON) ==========
let historyFilter = { q: "", f: "all" };
let historyInitialized = false;
let historyData = [];
let loadedCount = 0;
const chunkSize = 25;

const tbody = document.getElementById("history-body");
const container = document.getElementById("history-container");
const loading = document.getElementById("loading");

// ====== Gerador de motivo ======
function getReason(entry) {
  try {
    const u = new URL(entry.url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();

    // transforma domínio em nome legível
    const name = host
      .split(".")[0]
      .replace(/-/g, " ")
      .replace(/\b\w/g, c => c.toUpperCase());

    // ---------------- BLOQUEADO ----------------
    if (entry.status === "blocked") {
      return `Tentou acessar o site bloqueado (${name}).`;
    }

    // ---------------- SUSPEITO ----------------
    if (entry.status === "suspicious") {
      if (/google\.[^/]+\/search/i.test(entry.url)) {
        const params = new URLSearchParams(u.search);
        const q = params.get("q") || params.get("oq") || "";
        const cleanQ = q.replace(/site:|https?:\/\/|www\./gi, "").trim();

        if (cleanQ) {
          return `Pesquisa no Google com termos ou domínios bloqueados: “${cleanQ}”.`;
        } else {
          return "Pesquisa no Google contendo conteúdo potencialmente bloqueado.";
        }
      }
      return `Atividade suspeita detectada envolvendo o domínio (${name}).`;
    }

    // ---------------- PERMITIDO ----------------
    if (entry.status === "allowed") {
      return `Site permitido (${name}).`;
    }

    // fallback
    return "Motivo não identificado.";
  } catch {
    return "Não foi possível determinar o motivo (URL inválida).";
  }
}

// ====== Helper seguro para domínio ======
function safeGetDomain(url) {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return "desconhecido";
  }
}

// ====== Carregar histórico ======
async function loadHistoryData(force = false) {
  if (!tbody || !container) return;

  let retries = 0;
  let history = [];

  while (retries < 10) {
    const st = await chrome.storage.local.get({ history: [] });
    history = Array.isArray(st.history) ? st.history : [];
    if (history.length && history.every(h => h.url && h.status)) break;
    await new Promise(r => setTimeout(r, 150));
    retries++;
  }

  historyData = history
    .filter(h => h && h.url)
    .map(h => ({
      ...h,
      domain: h.domain || safeGetDomain(h.url)
    }))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));

  filteredHistoryData = []; // reseta filtro ao recarregar o histórico
  loadedCount = 0;
  tbody.innerHTML = "";

  await new Promise(r => setTimeout(r, 100));
  loadMoreRows(true);
}

// ====== Criação das linhas ======
function fmtUrl(u) {
  try {
    const x = new URL(u);
    let path = (x.pathname || '') + (x.search || '');
    if (path.length > 120) path = path.slice(0, 117) + '…';
    return x.hostname + path;
  } catch {
    return u?.length > 120 ? (u.slice(0, 117) + '…') : u;
  }
}
// ====== Criação das linhas ======
function createHistoryRow(entry) {
  const tr = el('tr');

  const status = (entry.status || 'allowed').toLowerCase();
  let cls = 'hist-allow', label = 'Permitido', pill = 'ok';
  if (status === 'blocked') { cls = 'hist-block'; label = 'Bloqueado'; pill = 'bad'; }
  else if (status === 'suspicious') { cls = 'hist-susp'; label = 'Suspeito'; pill = 'warn'; }
  tr.className = cls;

  const date = entry.ts ? new Date(entry.ts).toLocaleString('pt-BR') : '—';
  tr.appendChild(el('td', { innerText: date }));

  // pill
  const tdS = el('td');
  const pillEl = el('span', { className: `pill ${pill}`, innerText: label });
  tdS.appendChild(pillEl);
  tr.appendChild(tdS);

  // URL
  const tdU = el('td');
  const a = el('a', {
    href: entry.url || '#',
    innerText: fmtUrl(entry.url || ''),
    title: entry.url || '',
    target: '_blank',
    rel: 'noopener'
  });
  tdU.appendChild(a);
  tr.appendChild(tdU);

  // toggle do motivo
  pillEl.addEventListener('click', () => {
    const existing = tr.nextSibling;
    const msg = getReason(entry);
    if (existing && existing.classList.contains('hist-reason-row')) {
      existing.remove();
      pillEl.classList.remove('open');
      return;
    }
    document.querySelectorAll('.hist-reason-row').forEach(r => r.remove());
    document.querySelectorAll('.pill.open').forEach(p => p.classList.remove('open'));

    pillEl.classList.add('open');
    const reasonRow = el('tr', { className: 'hist-reason-row' });
    const td = el('td', { colSpan: 3, innerHTML: `<strong>${label}:</strong> ${msg || 'Motivo não identificado.'}` });
    reasonRow.appendChild(td);
    tr.insertAdjacentElement('afterend', reasonRow);
  });

  return tr;
}

// ====== Expansão da linha de motivo ======
function toggleReasonRow(tr, pill, entry) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains("hist-reason-row")) {
    next.remove();
    pill.classList.remove("open");
    return;
  }

  // fecha outras abertas
  document.querySelectorAll(".hist-reason-row").forEach(r => r.remove());
  document.querySelectorAll(".pill.open").forEach(p => p.classList.remove("open"));

  pill.classList.add("open");

  const reasonRow = document.createElement("tr");
  reasonRow.className = "hist-reason-row";
  const td = document.createElement("td");
  td.colSpan = 3;

  const reason = getReason(entry);
  td.innerHTML = `<strong>${pill.textContent}:</strong> ${reason}`;
  reasonRow.appendChild(td);
  tr.insertAdjacentElement("afterend", reasonRow);
}

// ====== Lazy load ======
let filteredHistoryData = [];

function loadMoreRows(initial = false) {
  // Decide de onde puxar os dados: filtrado ou total
  const source = (filteredHistoryData.length ? filteredHistoryData : historyData);

  if (loadedCount >= source.length) return;
  if (loading) loading.style.display = "block";

  setTimeout(() => {
    const nextChunk = source.slice(loadedCount, loadedCount + chunkSize);
    const frag = document.createDocumentFragment();
    for (const entry of nextChunk) frag.appendChild(createHistoryRow(entry));

    tbody.appendChild(frag);

    loadedCount += nextChunk.length;
    if (loading) loading.style.display = "none";

    tbody.offsetHeight; // força layout
    container.scrollTop += 0.1;
  }, 80);
}


// ====== Scroll handler ======
if (container) {
  let debounce;
  container.addEventListener("scroll", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const nearBottom =
        container.scrollTop + container.clientHeight >=
        container.scrollHeight - 80;
      if (nearBottom) loadMoreRows();
    }, 120);
  });
}

// ====== Recarregar ao voltar para aba ======
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    requestAnimationFrame(() => {
      document.querySelectorAll(".url-cell a").forEach(a => {
        a.style.width = "99%";
        setTimeout(() => (a.style.width = "100%"), 60);
      });
    });
  }
});

// ====== Inicialização ======
document.addEventListener("DOMContentLoaded", () => {

  // modo estudo
  const card = document.getElementById("card-study");
  const master = document.querySelector(card.dataset.master);

  const updateDim = () => {
    if (!master) return;
    card.classList.toggle("dimmed", !master.checked);
  };

  master.addEventListener("change", updateDim);
  updateDim(); // inicial
});

/* boot */
ensureAuth();
