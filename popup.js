// ======= Controle de autenticação da sessão =======
let sessionAuthOK = false;

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function requireAuth() {
  const state = await send({ type: "GET_STATE" });
  const savedHash = state.settings?.passwordHash || null;

  // se não existe senha configurada - liberar
  if (!savedHash) return true;

  // se já autenticado nesta sessão - liberar
  if (sessionAuthOK) return true;

  // cria modal customizado
  const modal = document.createElement('div');
  modal.style.cssText = `
    position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.45); z-index: 9999; font-family: inherit;
  `;

  modal.innerHTML = `
  <div style="
    background: var(--bg);
    padding: 20px 24px;
    border-radius: 10px;
    width: 340px;
    box-shadow: var(--shadow);
    text-align: center;
    font-family: 'Lexend';
  ">
    <h3 style="margin-bottom: 12px; font-size: 1.2rem">Confirmação</h3>
    <p style="margin-bottom: 14px; color: var(--muted); font-size: 14px;">
      Digite a senha para confirmar:
    </p>
    <input id="auth-pass" type="password" class="modal-input" placeholder="...">

    <div style="margin-top: 16px; display: flex; justify-content: center; gap: 10px;">
      <button
        id="auth-ok"
        style="
          padding: 6px 16px;
          border-radius: 6px;
          background: var(--accent,#4a90e2);
          color: var(--primary-contrast);
          border: none;
          font-weight: 600;
          font-family: 'Lexend';
        "
      >
        Ok
      </button>
      <button
        id="auth-cancel"
        style="
          padding: 6px 16px;
          border-radius: 6px;
          background: var(--panel);
          color: var(--muted);
          font-weight: 600;
          border: none;
          font-family: 'Lexend';
        "
      >
        Cancelar
      </button>
    </div>
  </div>
`;


  document.body.appendChild(modal);

  const input = modal.querySelector('#auth-pass');
  input.focus();

  const okBtn = modal.querySelector('#auth-ok');
  const cancelBtn = modal.querySelector('#auth-cancel');

  const getPwd = () => input.value.trim();

  const result = await new Promise(resolve => {
    okBtn.onclick = () => resolve(getPwd());
    cancelBtn.onclick = () => resolve(null);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') resolve(getPwd());
      if (e.key === 'Escape') resolve(null);
    });
  });

  modal.remove();

  if (!result) return false;

  const hash = await send({ type: "HASH_SHA256", text: result }).then(r => r.hash);

  if (hash === savedHash) {
    sessionAuthOK = true;
    return true;
  }

  alert("Senha incorreta.");
  return false;
}



// ======= UI Helpers =======

function modeHelpText(mode) {
  if (mode === 'allowlist') {
    return 'Permite os sites que você adicionar à lista de permitidos. O restante fica bloqueado.';
  }
  return 'Bloqueia os sites que você adicionar à lista de bloqueados. O restante abre normalmente.';
}

function syncModeUI(mode) {
  const help = document.getElementById('mode-help');
  const btn = document.getElementById('add-current');
  if (help) help.textContent = modeHelpText(mode);
  if (btn) btn.textContent = (mode === 'allowlist')
    ? 'Adicionar site atual à lista de PERMITIDOS'
    : 'Adicionar site atual à lista de BLOQUEADOS';
}


// ======= Refresh principal =======
let lastRealMode = "blocklist";

async function refresh() {
  try {
    const state = await send({ type: 'GET_STATE' });
    const settings = state?.settings ?? {};

    const toggle = document.getElementById('toggle-enabled');
    const modeSel = document.getElementById('mode');
    const addBtn = document.getElementById('add-current');
    const stateTxt = document.getElementById('state-text');

    lastRealMode = settings.mode || "blocklist";

    if (toggle) toggle.checked = !!settings.enabled;
    if (modeSel) {
      modeSel.value = lastRealMode;
      modeSel.disabled = !settings.enabled;
    }
    if (addBtn) addBtn.disabled = !settings.enabled;

    document.documentElement.setAttribute('data-on', settings.enabled ? 'true' : 'false');

    if (stateTxt) {
      stateTxt.textContent = settings.enabled ? 'Habilitado' : 'Desabilitado';
      stateTxt.classList.toggle('on', !!settings.enabled);
      stateTxt.classList.toggle('off', !settings.enabled);
    }

    syncModeUI(lastRealMode);

  } catch (e) {
    console.warn('refresh failed:', e);
  }
}


// ========== Debounce Refresh ==========
let refreshTimeout = null;
function scheduleRefresh(delay = 120) {
  if (refreshTimeout) clearTimeout(refreshTimeout);
  refreshTimeout = setTimeout(refresh, delay);
}


// ========== Watchers (storage, runtime, focus) ==========
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('settings' in changes || 'lists' in changes || 'schedule' in changes || 'searchHardening' in changes) {
    scheduleRefresh();
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && (msg.type === 'STATE_CHANGED' || msg.type === 'SYNC_UI')) {
    scheduleRefresh(0);
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});

window.addEventListener('focus', () => refresh());


// ========== Utils ==========
async function getCurrentDomain() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = tabs && tabs[0] ? tabs[0].url : '';
      try { const u = new URL(url); resolve(u.hostname.replace(/^www\./, '')); }
      catch { resolve(''); }
    });
  });
}

async function addCurrentToList() {
  const state = await send({ type: 'GET_STATE' });
  const domain = await getCurrentDomain();
  if (!domain) return;

  const lists = state.lists || { allow: [], block: [], categories: {} };
  const mode = state.settings?.mode || 'blocklist';

  if (mode === 'blocklist') {
    if (!lists.block.includes(domain)) lists.block.push(domain);
  } else {
    if (!lists.allow.includes(domain)) lists.allow.push(domain);
  }

  await send({ type: 'SET_LISTS', payload: lists });
  await send({ type: 'SYNC_RULES' });
  chrome.runtime.sendMessage({ type: 'STATE_CHANGED', source: 'popup:addCurrent' });

  window.close();
}



// =============================
//  LISTENERS COM AUTENTICAÇÃO 
// =============================

// ------ Habilitar/desabilitar proteção ------
document.getElementById('toggle-enabled').addEventListener('change', async (e) => {

  if (!(await requireAuth())) {
    e.target.checked = !e.target.checked; // volta
    return;
  }

  const on = e.target.checked;
  await send({ type: 'SET_SETTINGS', payload: { enabled: on } });
  chrome.runtime.sendMessage({ type: 'STATE_CHANGED', source: 'popup:enabled' });

  scheduleRefresh(0);
});


// ------ Select: impedir vazamento antes da senha ------
const modeSelect = document.getElementById('mode');

// bloquear abertura com mouse
modeSelect.addEventListener('pointerdown', async (e) => {
  if (sessionAuthOK) return;

  const state = await send({ type: "GET_STATE" });
  if (!state.settings?.passwordHash) return; // sem senha → ok

  e.preventDefault();
  e.stopPropagation();

  const ok = await requireAuth();
  if (ok) {
    setTimeout(() => modeSelect.showPicker?.(), 0);
  }
});

// bloquear abertura com teclado
modeSelect.addEventListener('keydown', async (e) => {
  if (sessionAuthOK) return;

  const keys = [' ', 'Spacebar', 'Enter', 'ArrowUp', 'ArrowDown'];
  if (!keys.includes(e.key)) return;

  const state = await send({ type: "GET_STATE" });
  if (!state.settings?.passwordHash) return;

  e.preventDefault();
  e.stopPropagation();

  const ok = await requireAuth();
  if (ok) {
    setTimeout(() => modeSelect.showPicker?.(), 0);
  }
});


// troca do modo
modeSelect.addEventListener('change', async (e) => {
  const newValue = e.target.value;

  // exige senha
  if (!(await requireAuth())) {
    modeSelect.value = lastRealMode;
    return;
  }

  // senha ok - aplicar
  await send({ type: 'SET_SETTINGS', payload: { mode: newValue } });
  await send({ type: 'SYNC_RULES' });
  chrome.runtime.sendMessage({ type: 'STATE_CHANGED', source: 'popup:mode' });

  lastRealMode = newValue;

  syncModeUI(newValue);
  scheduleRefresh(0);
});

// ------ Botão: adicionar site ------
document.getElementById('add-current').addEventListener('click', async () => {
  if (!(await requireAuth())) return;
  addCurrentToList();
});

// ------ Abrir opções ------
document.getElementById('open-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// Primeiro render
refresh();
