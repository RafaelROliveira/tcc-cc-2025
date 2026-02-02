// ================= Defaults =================
const DEFAULT_SETTINGS = { enabled: true, mode: 'blocklist', passwordHash: null };
const DEFAULT_LISTS = { allow: [], block: [], categories: {}, categoryExceptions: {} };
const DEFAULT_SCHEDULE = { enabled: false, days: [1, 2, 3, 4, 5], start: '18:00', end: '20:00', studyAllow: [] };
const DEFAULT_ADMIN = { unlockUntil: 0, lockPopup: true };

const HISTORY_LIMIT = 1000;
const SELF_PREFIX = chrome.runtime.getURL('');

// Guarda última URL pedida no frame principal de cada aba
const lastMainUrlByTab = new Map(); // tabId -> { url, ts }

// Deduplicação de logs de bloqueio
const recentlyLoggedBlocked = new Map(); // key=url|tabId -> ts
function shouldLogBlocked(url, tabId) {
  const key = `${url}|${tabId}`;
  const now = Date.now();
  const prev = recentlyLoggedBlocked.get(key) || 0;
  if (now - prev < 2000) return false;
  recentlyLoggedBlocked.set(key, now);
  return true;
}

// Guarda a URL original (antes do redirect/bloqueio do DNR)
chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (details.type !== 'main_frame') return;
  if (details.url.startsWith(SELF_PREFIX)) return;
  lastMainUrlByTab.set(details.tabId, { url: details.url, ts: Date.now() });
}, { urls: ["<all_urls>"] });


// ================= Helpers (storage) =================
async function getAllState() {
  return new Promise((resolve) => {
    chrome.storage.local.get({
      settings: DEFAULT_SETTINGS,
      lists: DEFAULT_LISTS,
      schedule: DEFAULT_SCHEDULE,
      admin: DEFAULT_ADMIN,
      ruleMap: {},
      nextRuleId: 1,
      history: []
    }, resolve);
  });
}

async function setState(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}


// ================= Heurística de conteúdo suspeito =================
async function isSuspiciousURL(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const qs = u.search || '';
    const full = (host + ' ' + u.pathname + ' ' + qs).toLowerCase();

    const stKW = await new Promise(r => chrome.storage.local.get({ contentBlock: { keywords: [] } }, r));
    const userKW = (stKW.contentBlock?.keywords || []).map(x => String(x).toLowerCase());
    const builtins = ['porn', 'xvideos', 'pornhub', 'redtube', 'xhamster', 'xnxx', 'onlyfans', 'nsfw', 'sex', 'xxx', 'camgirl', 'escort'];

    // === Carrega TODAS as categorias habilitadas ===
    let activeCategoryDomains = [];
    try {
      const [catFile, stLists] = await Promise.all([
        fetch(chrome.runtime.getURL('assets/categories.json')).then(r => r.json()),
        new Promise(r => chrome.storage.local.get({ lists: { categories: {}, categoryExceptions: {} } }, r))
      ]);

      const enabledMap = stLists.lists.categories || {};
      const excMap = stLists.lists.categoryExceptions || {};
      for (const [catId, enabled] of Object.entries(enabledMap)) {
        if (!enabled) continue;
        const arr = Array.isArray(catFile[catId]) ? catFile[catId] : [];
        activeCategoryDomains.push(...arr);
        // remove exceções
        for (const exc of (excMap[catId] || [])) {
          const idx = activeCategoryDomains.indexOf(exc);
          if (idx !== -1) activeCategoryDomains.splice(idx, 1);
        }
      }
    } catch (e) {
      console.warn('Erro ao carregar categorias:', e);
    }

    // Blocklist atual
    const stLists2 = await new Promise(r => chrome.storage.local.get({ lists: { block: [] } }, r));
    const blockList = (stLists2.lists?.block || []).map(d => String(d).toLowerCase());

    // Função para comparar domínios
    const domainMatches = (cand, dom) => cand === dom || cand.endsWith('.' + dom);

    // Verifica se o host pertence a alguma categoria ativa
    if (activeCategoryDomains.some(d => domainMatches(host, d.toLowerCase()))) return true;

    // Verifica lista de bloqueados
    if (blockList.some(d => domainMatches(host, d))) return true;

    // Verifica palavras-chave (usuário e padrão)
    const all = [...new Set([...builtins, ...userKW])].map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (all.length) {
      const re = new RegExp(`\\b(${all.join('|')})\\b`, 'i');
      if (re.test(full)) return true;
    }

    // Heurística de pesquisa no Google
    const isGoogleSearch = /^https?:\/\/([a-z0-9-]+\.)?google\.[^/]+\/(search|webhp)/i.test(url);
    if (isGoogleSearch) {
      const sp = u.searchParams;
      const qRaw = (sp.get('q') || sp.get('oq') || '').trim().toLowerCase();
      let candDomain = null;

      const mSite = qRaw.match(/(?:^|\s)site:([a-z0-9.-]+\.[a-z]{2,})(?:\s|$)/);
      if (mSite) candDomain = mSite[1];

      if (!candDomain) {
        try {
          if (/^https?:\/\//.test(qRaw)) {
            const qUrl = new URL(qRaw);
            candDomain = qUrl.hostname;
          }
        } catch { }
      }

      if (!candDomain) {
        const mDom = qRaw.match(/^(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)\/?$/i);
        if (mDom) candDomain = mDom[1];
      }

      const domainMatchesLoose = (cand, dom) =>
        cand === dom || cand.endsWith('.' + dom) || dom.endsWith('.' + cand);

      if (candDomain) {
        candDomain = candDomain.replace(/^www\./, '').toLowerCase();
        const hitBlock = blockList.some(d => domainMatchesLoose(candDomain, d));
        const hitCategory = activeCategoryDomains.some(d => domainMatchesLoose(candDomain, d));
        if (hitBlock || hitCategory) return true;
      } else {
        // Verifica se há termos de marca das categorias
        const toBrand = (dom) => {
          try {
            dom = dom.replace(/^www\./, '');
            const parts = dom.split('.').filter(Boolean);
            if (parts.length === 1) return parts[0];
            const last = parts[parts.length - 1];
            const second = parts[parts.length - 2];
            const slds = new Set(['com', 'co', 'org', 'gov', 'net', 'edu']);
            if (last.length === 2 && slds.has(second) && parts.length >= 3) {
              return parts[parts.length - 3];
            }
            return second;
          } catch { return dom; }
        };

        const brandSet = new Set([
          ...activeCategoryDomains.map(toBrand),
          ...blockList.map(toBrand)
        ].filter(Boolean));

        const stop = new Set(['www', 'http', 'https', 'site', 'com', 'br', 'net', 'org']);
        const tokens = qRaw.split(/[^a-z0-9]+/g).filter(t => t && !stop.has(t));
        for (const t of tokens) if (brandSet.has(t)) return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}



// ================= Regras (DNR) =================
function domainToRegex(domain) {
  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^https?://([a-z0-9-]+\\.)*${escaped}(:\\d+)?(/|$)`;
}

async function clearAllDynamicRules() {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  if (rules.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: rules.map(r => r.id)
    });
  }
}

function parseHM(hm) {
  const [h, m] = (hm || '00:00').split(':').map(n => parseInt(n, 10) || 0);
  return { h, m };
}

function nowInStudyWindow(schedule, now = new Date()) {
  if (!schedule || !schedule.enabled) return false;
  const dow = now.getDay();
  if (!Array.isArray(schedule.days) || !schedule.days.includes(dow)) return false;
  const { h: sh, m: sm } = parseHM(schedule.start);
  const { h: eh, m: em } = parseHM(schedule.end);
  const curM = now.getHours() * 60 + now.getMinutes();
  const sM = sh * 60 + sm;
  const eM = eh * 60 + em;
  if (sM === eM) return false;
  if (sM < eM) return curM >= sM && curM < eM;
  return curM >= sM || curM < eM; // cruza meia-noite
}

async function buildStudyRules(schedule, ruleMap, nextId) {
  const rules = [];
  const ensure = (key, rule) => {
    if (ruleMap[key]) rule.id = ruleMap[key];
    else { rule.id = nextId++; ruleMap[key] = rule.id; }
    rules.push(rule);
  };

  // Bloqueia tudo
  ensure('study:blockAll', {
    id: 0,
    priority: 1,
    action: { type: 'redirect', redirect: { extensionPath: '/block.html' } },
    condition: { resourceTypes: ['main_frame', 'sub_frame'], urlFilter: 'http' }
  });

  // Libera sites de estudo
  for (const d of (schedule.studyAllow || [])) {
    ensure(`study:allow:${d}`, {
      id: 0,
      priority: 2,
      action: { type: 'allow' },
      condition: { regexFilter: domainToRegex(String(d).toLowerCase()), resourceTypes: ['main_frame', 'sub_frame'] }
    });
  }

  return { rules, ruleMap, nextId };
}

// ===== Aliases/fixes (twitter = x, etc.)
function aliasOfHost(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  const aliases = new Set([h]);
  aliases.add(h.replace(/^www\./, ''));
  aliases.add('www.' + h);

  if (h === 'twitter.com') aliases.add('x.com');
  if (h === 'x.com') aliases.add('twitter.com');

  if (h === 'instagram.com') {
    aliases.add('www.instagram.com');
    aliases.add('m.instagram.com');
  }

  return aliases;
}

function expandWithAliases(setOrArr) {
  const out = new Set();
  for (const item of setOrArr || []) {
    const h = String(item || '').toLowerCase().replace(/^www\./, '');
    for (const a of aliasOfHost(h)) out.add(a.replace(/^www\./, ''));
  }
  return out;
}

// ===== helpers para criar regras redundantes por domínio (bloqueio/allow)
function addBlockDomainRules(ensureFn, host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  const rx = domainToRegex(h);

  // 1) regexFilter (subdomínios + http/https)
  ensureFn(`block:rx:${h}`, {
    priority: 2,
    action: { type: 'redirect', redirect: { extensionPath: '/block.html' } },
    condition: { regexFilter: rx, resourceTypes: ['main_frame', 'sub_frame'] }
  });

  // 2) requestDomains (match direto)
  ensureFn(`block:rd:${h}`, {
    priority: 2,
    action: { type: 'redirect', redirect: { extensionPath: '/block.html' } },
    condition: { requestDomains: [h], resourceTypes: ['main_frame', 'sub_frame'] }
  });

  // 3) urlFilter com ancoragem "://host/" (ajuda domínios curtos = x.com)
  ensureFn(`block:uf:${h}`, {
    priority: 2,
    action: { type: 'redirect', redirect: { extensionPath: '/block.html' } },
    condition: { urlFilter: `://${h}/`, resourceTypes: ['main_frame', 'sub_frame'] }
  });

  // 4) fallback extra para host muito curto
  if (h.length <= 5) {
    ensureFn(`block:uf2:${h}`, {
      priority: 2,
      action: { type: 'redirect', redirect: { extensionPath: '/block.html' } },
      condition: { urlFilter: `://${h}`, resourceTypes: ['main_frame', 'sub_frame'] }
    });
  }
}

function addAllowDomainRule(ensureFn, host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  const rx = domainToRegex(h);
  ensureFn(`allow:${h}`, {
    priority: 1, // BLOQUEIO vence (2 > 1)
    action: { type: 'allow' },
    condition: { regexFilter: rx, resourceTypes: ['main_frame', 'sub_frame'] }
  });
}


// ================= SYNC RULES =================
async function syncRulesFromStorage() {
  const { settings, lists, schedule } = await getAllState();

  // Helpers
  const normalizeHost = (d) => {
    try {
      if (/^https?:\/\//i.test(d)) d = new URL(d).hostname;
      d = String(d || '').trim().toLowerCase();
      d = d.replace(/^www\./, '').replace(/:\d+$/, '').split('/')[0];
      return d;
    } catch { return String(d || '').trim().toLowerCase(); }
  };
  const domainToUrlFilter = (d) => `||${normalizeHost(d)}^`;

  // Remove subdomínios quando o domínio base já está presente
  function pruneSubdomains(domainsSet) {
    const arr = [...domainsSet];
    const keep = new Set(arr);
    for (const d of arr) {
      for (const e of arr) {
        if (d !== e && d.endsWith('.' + e)) { // ex.: m.instagram.com vs instagram.com
          keep.delete(d);
          break;
        }
      }
    }
    return keep;
  }

  // Domínios que exigem regex reforçada
  const SPECIAL_ENFORCE = new Set(['x.com', 'twitter.com', 'instagram.com', 'facebook.com', 'tiktok.com']);

  // Aliases expandidos
  const ALIASES = {
    'x.com': ['twitter.com', 'www.x.com', 'www.twitter.com', 'mobile.twitter.com', 'm.twitter.com'],
    'twitter.com': ['x.com', 'www.twitter.com', 'www.x.com', 'mobile.twitter.com', 'm.twitter.com'],
    'instagram.com': ['www.instagram.com', 'm.instagram.com', 'mobile.instagram.com'],
    'www.instagram.com': ['instagram.com', 'm.instagram.com', 'mobile.instagram.com'],
    'm.instagram.com': ['instagram.com', 'www.instagram.com'],
    'facebook.com': ['www.facebook.com', 'm.facebook.com'],
    'tiktok.com': ['www.tiktok.com', 'm.tiktok.com'],
  };

  const expandAliases = (iter) => {
    const out = new Set();
    for (const raw of iter || []) {
      const base = normalizeHost(raw);
      if (!base) continue;
      out.add(base);
      const al = ALIASES[base];
      if (al) al.forEach(a => out.add(normalizeHost(a)));
    }
    return out;
  };

  const addAllow = (ensure, d) => {
    const host = normalizeHost(d);
    ensure(`allow:${host}`, {
      priority: 1,
      action: { type: 'allow' },
      condition: { urlFilter: domainToUrlFilter(host), resourceTypes: ['main_frame', 'sub_frame'] },
    });
  };

  const addBlock = (ensure, d) => {
    const host = normalizeHost(d);
    const reqDomains = [host, `www.${host}`, `m.${host}`, `mobile.${host}`]; // inclui mobile.

    // 1) urlFilter (genérico)
    ensure(`block:${host}:uf`, {
      priority: 2,
      action: { type: 'redirect', redirect: { extensionPath: '/block.html' } },
      condition: { urlFilter: domainToUrlFilter(host), resourceTypes: ['main_frame', 'sub_frame'] },
    });

    // 2) requestDomains (agarra o domínio solicitado direto)
    ensure(`block:${host}:rd`, {
      priority: 2,
      action: { type: 'redirect', redirect: { extensionPath: '/block.html' } },
      condition: { requestDomains: reqDomains, resourceTypes: ['main_frame', 'sub_frame'] },
    });

    // 3) regex de reforço (garante base mesmo que host seja www./m./mobile.)
    const enforceBase = [...SPECIAL_ENFORCE].find(b =>
      host === b ||
      host === `www.${b}` ||
      host === `m.${b}` ||
      host === `mobile.${b}` ||
      host.endsWith(`.${b}`)
    );
    if (enforceBase) {
      const rx = `^https?://([a-z0-9-]+\\.)?${enforceBase.replace('.', '\\.')}(:\\d+)?(/|$)`;
      ensure(`block:${enforceBase}:rx`, {
        priority: 3,
        action: { type: 'redirect', redirect: { extensionPath: '/block.html' } },
        condition: { regexFilter: rx, resourceTypes: ['main_frame', 'sub_frame'] },
      });
    }
  };

  // Desativado - limpa tudo
  if (!settings.enabled) {
    await clearAllDynamicRules();
    chrome.runtime.sendMessage({ type: 'STATE_CHANGED', source: 'sync' }, () => void chrome.runtime.lastError);
    return;
  }

  // --- Categorias e exceções ---
  let categoryDomains = [];
  const categoryExceptions = new Set();
  try {
    const res = await fetch(chrome.runtime.getURL('assets/categories.json'));
    const catData = await res.json();
    const excMap = lists.categoryExceptions || {};
    for (const [catId, enabled] of Object.entries(lists.categories || {})) {
      if (!enabled) continue;
      const arr = Array.isArray(catData[catId]) ? catData[catId] : [];
      categoryDomains.push(...arr);
      (excMap[catId] || []).forEach(d => categoryExceptions.add(normalizeHost(d)));
    }
  } catch (e) {
    console.warn('Falha ao carregar categories.json', e);
  }

  // --- Listas finais ---
  let allowList = new Set((lists.allow || []).map(normalizeHost));
  let blockList = new Set((lists.block || []).map(normalizeHost));

  const categoryList = new Set(categoryDomains.map(normalizeHost));   // primeiro cru
  const categoryExceptionsExpanded = expandAliases(categoryExceptions);

  // exceções de categoria viram allow
  for (const d of categoryExceptionsExpanded) allowList.add(d);
  // categorias ligadas viram block, exceto o que virou exceção
  for (const d of categoryList) if (!categoryExceptionsExpanded.has(d)) blockList.add(d);

  // expande aliases
  allowList = expandAliases(allowList);
  // para o block, expande e remove subdomínios redundantes (fica só o base)
  blockList = pruneSubdomains(expandAliases(blockList));

  // conflito > block > allow
  for (const d of blockList) allowList.delete(d);

  // --- Gerador de IDs únicos e registry local ---
  let nextId = 1;
  const addRules = [];
  const usedIds = new Set();
  const usedKeys = new Set();
  const allocId = () => { while (usedIds.has(nextId)) nextId++; const id = nextId++; usedIds.add(id); return id; };
  const ensure = (key, rule) => {
    if (usedKeys.has(key)) return;
    usedKeys.add(key);
    addRules.push({ ...rule, id: allocId() });
  };

  // --- Modo estudo ---
  if (nowInStudyWindow(schedule)) {
    const built = await buildStudyRules(schedule || {}, {}, 1);
    for (const r of built.rules) {
      const key = `study:${r.condition?.regexFilter || r.condition?.urlFilter || JSON.stringify(r.condition)}`;
      ensure(key, r);
    }
  } else {
    if (settings.mode === 'allowlist') {
      ensure('global:block', {
        priority: 1,
        action: { type: 'redirect', redirect: { extensionPath: '/block.html' } },
        condition: { resourceTypes: ['main_frame', 'sub_frame'], urlFilter: 'http' },
      });
      for (const d of allowList) addAllow(ensure, d);
    } else {
      for (const d of blockList) addBlock(ensure, d);
      for (const d of allowList) addAllow(ensure, d);
    }
  }

  // --- Proteções de busca (Google SafeSearch / bloqueio de imagens e vídeos) ---
  const stSearch = await new Promise(r => chrome.storage.local.get({
    searchHardening: { blockImageSearch: false, blockVideos: false, forceSafe: false }
  }, r));
  const searchHardening = stSearch.searchHardening || {};


  // Imagens
  if (searchHardening.blockImageSearch) {
    const redirect = { type: 'redirect', redirect: { extensionPath: '/block.html' } };
    ensure('gimg:tbm', { id: 0, priority: 3, action: redirect, condition: { regexFilter: '^https?://([a-z0-9-]+\\.)?google\\.[^/]+/search\\?[^#]*[&?]tbm=isch([&#]|$)', resourceTypes: ['main_frame'] } });
    ensure('gimg:imgres', { id: 0, priority: 3, action: redirect, condition: { regexFilter: '^https?://([a-z0-9-]+\\.)?google\\.[^/]+/imgres\\?', resourceTypes: ['main_frame'] } });
    ensure('gimg:imghp', { id: 0, priority: 3, action: redirect, condition: { regexFilter: '^https?://([a-z0-9-]+\\.)?google\\.[^/]+/imghp(\\?|$)', resourceTypes: ['main_frame'] } });
    ensure('gimg:udm2', { id: 0, priority: 3, action: redirect, condition: { regexFilter: '^https?://([a-z0-9-]+\\.)?google\\.[^/]+/search\\?[^#]*[&?](tbm=isch|udm=2)([&#]|$)', resourceTypes: ['main_frame'] } });
    ensure('gimg:lhcdn', { id: 0, priority: 3, action: { type: 'block' }, condition: { regexFilter: '^https?://lh[0-9]\\.googleusercontent\\.com/.*', resourceTypes: ['image'] } });
  }

  // Vídeos
  if (searchHardening.blockVideos) {
    const redirect = { type: 'redirect', redirect: { extensionPath: '/block.html' } };
    ensure('gvid:tbm', { id: 0, priority: 3, action: redirect, condition: { regexFilter: '^https?://([a-z0-9-]+\\.)?google\\.[^/]+/search\\?[^#]*[&?]tbm=vid([&#]|$)', resourceTypes: ['main_frame'] } });
    ensure('gvid:udm714', { id: 0, priority: 3, action: redirect, condition: { regexFilter: '^https?://([a-z0-9-]+\\.)?google\\.[^/]+/(search|webhp)\\?[^#]*[&?]udm=(7|14)([&#]|$)', resourceTypes: ['main_frame'] } });
    ensure('gvid:tbs', { id: 0, priority: 3, action: redirect, condition: { regexFilter: '^https?://([a-z0-9-]+\\.)?google\\.[^/]+/(search|webhp)\\?[^#]*[&?]tbs=[^#]*vid:1', resourceTypes: ['main_frame'] } });
    ensure('gvid:home', { id: 0, priority: 3, action: redirect, condition: { regexFilter: '^https?://([a-z0-9-]+\\.)?google\\.[^/]+/videohp(\\?|$)', resourceTypes: ['main_frame'] } });
    ensure('gvid:shorts1', { id: 0, priority: 3, action: redirect, condition: { regexFilter: '^https?://([a-z0-9-]+\\.)?google\\.[^/]+/search\\?[^#]*[&?]ibp=sv[a-z0-9_]*', resourceTypes: ['main_frame'] } });
    ensure('gvid:shorts2', { id: 0, priority: 3, action: redirect, condition: { regexFilter: '^https?://([a-z0-9-]+\\.)?google\\.[^/]+/search\\?[^#]*[&?]ibp=sv[a-z0-9_]*([&#]|$)', resourceTypes: ['main_frame'] } });
    ensure('gvid:udm39', { id: 0, priority: 3, action: redirect, condition: { regexFilter: '^https?://([a-z0-9-]+\\.)?google\\.[^/]+/search\\?[^#]*[&?]udm=39([&#]|$)', resourceTypes: ['main_frame'] } });
    ensure('yt:media', { id: 0, priority: 3, action: { type: 'block' }, condition: { regexFilter: '^https?://([a-z0-9-]+\\.)?googlevideo\\.com/.*', resourceTypes: ['media'] } });
    ensure('yt:thumbs', { id: 0, priority: 3, action: { type: 'block' }, condition: { regexFilter: '^https?://i[0-9]?\\.ytimg\\.com/.*', resourceTypes: ['image'] } });
    ensure('yt:avatars', { id: 0, priority: 3, action: { type: 'block' }, condition: { regexFilter: '^https?://yt3\\.ggpht\\.com/.*', resourceTypes: ['image'] } });
  }

  // SafeSearch
  if (searchHardening.forceSafe) {
    ensure('gsafe:web', {
      id: 0, priority: 2,
      action: { type: 'redirect', redirect: { transform: { queryTransform: { addOrReplaceParams: [{ key: 'safe', value: 'active' }] } } } },
      condition: { regexFilter: '^https?://([a-z0-9-]+\\.)?google\\.[^/]+/search\\?.*', resourceTypes: ['main_frame'] }
    });
  }

  // Debug
  console.group('[CP] Regras calculadas');
  console.log('Total:', addRules.length);
  const dump = (r) => r.map(x => x.condition?.regexFilter || x.condition?.urlFilter || x.condition?.requestDomains);
  console.log('x.com presente?', addRules.some(r =>
    (r.condition?.requestDomains && r.condition.requestDomains.includes('x.com')) ||
    /\|\|x\.com\^/.test(r.condition?.urlFilter || '') ||
    /x\\\.com/.test(r.condition?.regexFilter || '')
  ));
  console.log('instagram presente?', addRules.some(r =>
    (r.condition?.requestDomains && (
      r.condition.requestDomains.includes('instagram.com') ||
      r.condition.requestDomains.includes('www.instagram.com') ||
      r.condition.requestDomains.includes('m.instagram.com') ||
      r.condition.requestDomains.includes('mobile.instagram.com')
    )) ||
    /\|\|instagram\.com\^/.test(r.condition?.urlFilter || '') ||
    /instagram\\\.com/.test(r.condition?.regexFilter || '')
  ));
  console.log('Preview conds:', dump(addRules));
  console.groupEnd();

  // Commit
  try {
    const current = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: current.map(r => r.id),
      addRules
    });
  } catch (e) {
    console.warn('Falha ao atualizar DNR:', e);
    // reset de emergência
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: (await chrome.declarativeNetRequest.getDynamicRules()).map(r => r.id),
      addRules: []
    });
  } finally {
    chrome.runtime.sendMessage({ type: 'STATE_CHANGED', source: 'sync' }, () => void chrome.runtime.lastError);
  }
}


// ================= Histórico =================
async function pushHistory(entry) {
  const url = entry?.url || '';
  if (!/^https?:\/\//i.test(url)) return;
  const SELF = `chrome-extension://${chrome.runtime.id}/`;
  if (url.startsWith(SELF)) return;

  const state = await getAllState();
  const hist = state.history || [];
  const now = Date.now();

  const last = hist[hist.length - 1];
  const sameAsLast = last && last.url === url && (last.status || '') === (entry.status || '') && now - (last.ts || 0) < 60_000;
  if (sameAsLast) return;

  hist.push({ ts: now, ...entry });
  while (hist.length > HISTORY_LIMIT) hist.shift();
  await setState({ history: hist });
}

// Visitas (permitido/suspeito) + bloqueios por redirect page
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0 || details.transitionType === 'auto_subframe') return;

  if (details.url.startsWith(SELF_PREFIX)) {
    const entry = lastMainUrlByTab.get(details.tabId);
    if (entry && !entry.url.startsWith(SELF_PREFIX) && shouldLogBlocked(entry.url, details.tabId)) {
      await pushHistory({ type: 'redirect', status: 'blocked', url: entry.url });
    }
    return;
  }

  const suspicious = await isSuspiciousURL(details.url);
  await pushHistory({ type: 'visit', url: details.url, status: suspicious ? 'suspicious' : 'allowed' });
});

// Log de bloqueios via DNR
if (chrome.declarativeNetRequest && chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(async (info) => {
    try {
      if (!info || !info.rule || !info.request || !info.rule.action) return;
      const act = info.rule.action.type;
      if (act === 'redirect' || act === 'block') {
        const url = info.request.url;
        if (!url.startsWith(SELF_PREFIX) && shouldLogBlocked(url, info.request.tabId ?? -1)) {
          await pushHistory({ type: act, status: 'blocked', url, ruleId: info.rule.ruleId });
        }
      }
    } catch { }
  });
}

// ÚNICO handler de erro de navegação
chrome.webNavigation.onErrorOccurred.addListener(async (details) => {
  if (details.frameId !== 0) return;

  const errUp = String(details.error || '').toUpperCase();
  if (!errUp.includes('ERR_BLOCKED_BY_CLIENT')) return;

  if (details.url.startsWith(SELF_PREFIX)) return;

  const entry = lastMainUrlByTab.get(details.tabId);
  const originalUrl = entry && !entry.url.startsWith(SELF_PREFIX) ? entry.url : details.url;
  if (shouldLogBlocked(originalUrl, details.tabId)) {
    await pushHistory({ type: 'blocked', status: 'blocked', url: originalUrl, error: details.error });
  }

  const u = chrome.runtime.getURL('block.html') + '?u=' + encodeURIComponent(details.url);
  setTimeout(() => {
    try { chrome.tabs.update(details.tabId, { url: u }); } catch { }
  }, 0);
});


// ================= Messaging =================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        // === pedido do options.js ===
        case 'GET_ALL_STATE': {
          const state = await getAllState();
          sendResponse(state);
          break;
        }

        case 'GET_STATE': {
          const state = await getAllState();
          sendResponse(state);
          break;
        }

        case 'SET_SETTINGS': {
          const { settings } = await getAllState();
          await setState({ settings: { ...settings, ...msg.payload } });
          await syncRulesFromStorage();
          sendResponse({ ok: true });
          break;
        }

        case 'SET_LISTS': {
          const { lists } = await getAllState();
          await setState({ lists: { ...lists, ...msg.payload } });
          await syncRulesFromStorage();
          sendResponse({ ok: true });
          break;
        }

        case 'CLEAR_HISTORY': {
          await setState({ history: [] });
          sendResponse({ ok: true });
          break;
        }

        case 'EXPORT_HISTORY': {
          const { history } = await getAllState();
          sendResponse({ ok: true, history });
          break;
        }

        case 'HASH_SHA256': {
          const data = new TextEncoder().encode(msg.text || '');
          const hashBuffer = await crypto.subtle.digest('SHA-256', data);
          const hashArray = Array.from(new Uint8Array(hashBuffer));
          const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
          sendResponse({ hash: hashHex });
          break;
        }

        case 'SYNC_RULES': {
          await syncRulesFromStorage();
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ ok: true });
      }
    } catch (err) {
      console.error('BG error:', err);
      sendResponse({ error: String(err) });
    }
  })();
  return true; // mantém o canal aberto para respostas async
});



// ================= Alarms & bootstrap =================
chrome.runtime.onInstalled.addListener(async () => {
  const state = await getAllState();
  await setState({
    settings: { ...DEFAULT_SETTINGS, ...(state.settings || {}) },
    lists: { ...DEFAULT_LISTS, ...(state.lists || {}) },
    schedule: { ...DEFAULT_SCHEDULE, ...(state.schedule || {}) },
    ruleMap: state.ruleMap || {},
    nextRuleId: state.nextRuleId || 1,
    history: state.history || []
  });
  chrome.alarms.create('scheduleTick', { periodInMinutes: 1 });
  await syncRulesFromStorage();
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create('scheduleTick', { periodInMinutes: 1 });
  await syncRulesFromStorage();
});

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'scheduleTick') await syncRulesFromStorage();
});


// Initial sync (resiliente)
(async () => {
  try { await syncRulesFromStorage(); } catch (e) { console.warn(e); }
})();
