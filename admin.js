'use strict';

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const loginEl = $('#login');
const appEl = $('#app');
const tabsEditor = $('#tabsEditor');

let pass = '';
let config = null;
let videoFiles = [];
let photoFiles = [];
let athletes = [];
const ACTION_LOG_KEY = 'cpvViewer:actions';
const VIDEO_ERROR_KEY = 'cpvViewer:videoErrors';
const RECENT_KEY = 'cpvViewer:recent';
const DEFAULT_FOLDERS = [
  { id: 'courte-piste', name: 'Courte Piste', children: [] },
  { id: 'longue-piste', name: 'Longue Piste', children: [] },
  { id: 'entrainement', name: 'Entraînement', children: [] }
];

function setConfigDirty(dirty) {
  const state = $('#configState');
  if (!state) return;
  state.textContent = dirty ? 'Modifications non enregistrées' : 'Configuration enregistrée';
  state.classList.toggle('dirty', dirty);
}

/* ---------- tiny helpers ---------- */

function fmtTime(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return (h > 0 ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0');
}

function parseTime(str) {
  if (typeof str !== 'string') return NaN;
  const s = str.trim().replace(',', '.').replace('h', ':').replace('m', ':').replace('s', '');
  if (!s) return NaN;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const parts = s.split(':').map((x) => parseFloat(x));
  if (parts.some((x) => Number.isNaN(x))) return NaN;
  let total = 0;
  for (const p of parts) total = total * 60 + p;
  return total;
}

function toast(msg, kind) {
  const t = document.createElement('div');
  t.className = 'toast ' + (kind || '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; }, 3200);
  setTimeout(() => t.remove(), 3700);
}

function readLocalJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeLocalJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) { /* silencieux */ }
}

function recordAction(label, kind) {
  const actions = Array.isArray(readLocalJSON(ACTION_LOG_KEY, [])) ? readLocalJSON(ACTION_LOG_KEY, []) : [];
  actions.unshift({ label, kind, at: new Date().toISOString() });
  writeLocalJSON(ACTION_LOG_KEY, actions.slice(0, 25));
  renderActionLog();
}

function renderActionLog() {
  const list = $('#monitorActions') || $('#actionLogList');
  if (!list) return;
  const actions = Array.isArray(readLocalJSON(ACTION_LOG_KEY, [])) ? readLocalJSON(ACTION_LOG_KEY, []) : [];
  if (!actions.length) {
    list.innerHTML = '<li class="empty-monitor">Aucune action enregistrée.</li>';
    return;
  }
  list.innerHTML = actions.slice(0, 8).map((entry) => {
    const time = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return '<li class="monitor-item ' + (entry.kind || 'info') + '"><span>' + esc(entry.label) + '</span><small>' + esc(time) + '</small></li>';
  }).join('');
}

function api(url, opts) {
  opts = opts || {};
  opts.credentials = opts.credentials || 'same-origin';
  opts.headers = Object.assign({}, opts.headers);
  if (pass) opts.headers['x-admin-pass'] = pass;
  return fetch(url, opts).then(async (r) => {
    let data = null;
    try { data = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
    return data;
  });
}

/* ---------- auth ---------- */

async function init() {
  configureLogin();
  $('#logoutBtn').addEventListener('click', logout);
  bindGlobals();

  try {
    await api('/api/verify');
    return showApp();
  } catch (e) {
    pass = '';
    showLogin();
  }
}

function configureLogin() {
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#loginErr');
    err.hidden = true;
    pass = $('#passInput').value;
    try {
      await api('/api/verify');
      showApp();
    } catch (e) {
      err.textContent = 'Mot de passe incorrect.';
      err.hidden = false;
      $('#passInput').select();
    }
  });
}

function showLogin() {
  loginEl.hidden = false;
  appEl.hidden = true;
  $('#passInput').focus();
}

async function logout() {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch (e) {
    toast('Impossible de fermer la session : ' + e.message, 'err');
    return;
  }
  recordAction('Déconnexion admin', 'info');
  pass = '';
  location.reload();
}

/* ---------- load & render ---------- */

async function showApp() {
  loginEl.hidden = true;
  appEl.hidden = false;
  try {
    const [cfg, vid, photosData, athleteData] = await Promise.all([
      api('/api/config'),
      api('/api/videos').catch(() => ({ videos: [] })),
      api('/api/photos').catch(() => ({ photos: [] })),
      api('/api/athletes')
    ]);
    config = cfg;
    videoFiles = vid.videos || [];
    photoFiles = photosData.photos || [];
    athletes = athleteData.athletes || [];
    config.folders = mergeDiscoveredFolders(config.folders || DEFAULT_FOLDERS, videoFiles.map((file) => file.name));
    render();
    setConfigDirty(false);
    refreshMonitor();
    renderActionLog();
    refreshYoutubeJobs();
    if (!ytPollTimer) ytPollTimer = setInterval(refreshYoutubeJobs, 3000);
  } catch (e) {
    toast('Impossible de charger la configuration : ' + e.message, 'err');
  }
}

function render() {
  fillGlobal();
  renderCalendarEditor();
  renderFolderTree();
  renderTabs();
  renderVideoList();
  renderPhotoList();
  renderPhotoTargetOptions();
  renderAthletes();
  renderYoutubeFolderOptions();
  setAccentPreview();
  renderActionLog();
}

function renderCalendarEditor() {
  const editor = $('#calendarEditor');
  const events = Array.isArray(config.calendar) ? config.calendar : [];
  if (!events.length) {
    editor.innerHTML = '<p class="calendar-empty">Aucune activité au calendrier.</p>';
    return;
  }
  editor.innerHTML = events.map((event) => `
    <article class="calendar-event-editor" data-event-id="${esc(event.id)}">
      <div class="calendar-event-head">
        <strong>${esc(event.title || 'Nouvelle activité')}</strong>
        <button class="btn small danger" type="button" data-event-action="delete">Supprimer</button>
      </div>
      <div class="calendar-event-fields">
        <label class="event-title">Nom de l'activité
          <input data-field="title" maxlength="120" value="${esc(event.title || '')}" placeholder="Ex. Entraînement de courte piste">
        </label>
        <label>Date
          <input data-field="date" type="date" value="${esc(event.date || '')}" required>
        </label>
        <label>Début
          <input data-field="startTime" type="time" value="${esc(event.startTime || '')}">
        </label>
        <label>Fin
          <input data-field="endTime" type="time" value="${esc(event.endTime || '')}">
        </label>
        <label>Lieu
          <input data-field="location" maxlength="160" value="${esc(event.location || '')}" placeholder="Aréna ou adresse">
        </label>
        <label>Catégorie
          <select data-field="category">
            ${['Entraînement', 'Compétition', 'Activité sociale', 'Autre'].map((category) => `<option${event.category === category ? ' selected' : ''}>${category}</option>`).join('')}
            ${!['Entraînement', 'Compétition', 'Activité sociale', 'Autre'].includes(event.category) ? `<option selected>${esc(event.category)}</option>` : ''}
          </select>
        </label>
        <label class="event-description">Description
          <textarea data-field="description" maxlength="1200" rows="2" placeholder="Détails utiles aux membres">${esc(event.description || '')}</textarea>
        </label>
        <fieldset class="calendar-target-picker">
          <legend>Personnes concernées</legend>
          <div class="calendar-targets">${athletes.filter((athlete) => athlete.hasPassword).map((athlete) => `
            <label class="calendar-target"><input type="checkbox" data-field="targetIds" value="${esc(athlete.id)}"${(event.targetIds || []).includes(athlete.id) ? ' checked' : ''}>${esc(athlete.name)}</label>`).join('') || '<span class="muted-note">Aucune fiche athlète active.</span>'}</div>
          <small>Laissez vide pour ajouter l’activité au calendrier de tout le club.</small>
        </fieldset>
      </div>
    </article>`).join('');
}

function renderAthletes() {
    const editor = $('#athleteEditor');
    $('#athleteSummary').textContent = athletes.length + ' fiche' + (athletes.length === 1 ? '' : 's') + ' privée' + (athletes.length === 1 ? '' : 's');
    if (!athletes.length) {
      editor.innerHTML = '<p class="muted-note">Aucune fiche pour le moment. Ajoutez un athlète pour créer un accès privé.</p>';
      return;
    }
    editor.innerHTML = athletes.map((athlete) => `
      <article class="athlete-card" data-athlete-card data-id="${esc(athlete.id)}">
        <div class="athlete-card-head">
          <strong>${esc(athlete.name || 'Nouvel athlète')}</strong>
          <div class="athlete-actions">
            ${athlete.hasPassword ? `<a class="btn small" href="/athlete.html?id=${encodeURIComponent(athlete.id)}" target="_blank" rel="noopener">Ouvrir la fiche</a>` : ''}
            <button class="btn small primary" type="button" data-athlete-action="save">Enregistrer la fiche</button>
            <button class="btn small danger" type="button" data-athlete-action="delete">Supprimer</button>
          </div>
        </div>
        <div class="athlete-card-body">
          <div class="grid2">
            <label>Nom complet<input data-field="name" maxlength="100" value="${esc(athlete.name || '')}" required></label>
            <label>Catégorie<input data-field="category" maxlength="80" value="${esc(athlete.category || '')}" placeholder="Junior, sénior…"></label>
            <label>${athlete.hasPassword ? 'Nouveau mot de passe (facultatif)' : 'Mot de passe initial'}
              <input data-field="password" type="password" minlength="8" autocomplete="new-password" placeholder="${athlete.hasPassword ? 'Laisser vide pour conserver le mot de passe' : '8 caractères minimum'}" ${athlete.hasPassword ? '' : 'required'}>
            </label>
            <label class="event-description">Présentation<textarea data-field="bio" maxlength="2000" rows="3" placeholder="Courte présentation">${esc(athlete.bio || '')}</textarea></label>
          </div>
          ${athlete.hasPassword ? `<div class="athlete-link"><label>Lien privé<input readonly value="${esc(location.origin + '/athlete.html?id=' + encodeURIComponent(athlete.id))}"></label><button class="btn small" type="button" data-athlete-action="copy-link">Copier le lien</button></div>` : ''}
          <section>
            <h3>Meilleurs temps personnels</h3>
            <div class="athlete-entry-list" data-entry-list="records">${(athlete.records || []).map((record) => athleteRecordMarkup(record)).join('')}</div>
            <button class="btn small" type="button" data-athlete-action="add-record">+ Ajouter un temps</button>
          </section>
          <section>
            <h3>Entraînements</h3>
            <div class="athlete-entry-list" data-entry-list="trainings">${(athlete.trainings || []).map((training) => athleteTrainingMarkup(training)).join('')}</div>
            <button class="btn small" type="button" data-athlete-action="add-training">+ Ajouter un entraînement</button>
          </section>
        </div>
      </article>`).join('');
}

function syncCalendarTarget(athlete, remove) {
  $$('.calendar-event-editor').forEach((card) => {
    const targets = $('.calendar-targets', card);
    if (!targets) return;
    const existing = $$('[data-field="targetIds"]', targets).find((input) => input.value === athlete.id);
    if (remove) {
      if (existing) existing.closest('label').remove();
      const event = config.calendar.find((item) => item.id === card.dataset.eventId);
      if (event) event.targetIds = (event.targetIds || []).filter((id) => id !== athlete.id);
    } else if (athlete.hasPassword && !existing) {
      const empty = targets.querySelector('.muted-note');
      if (empty) empty.remove();
      const label = document.createElement('label');
      label.className = 'calendar-target';
      label.innerHTML = `<input type="checkbox" data-field="targetIds" value="${esc(athlete.id)}">${esc(athlete.name)}`;
      targets.append(label);
    } else if (existing) existing.closest('label').lastChild.textContent = athlete.name;
  });
  if (remove) setConfigDirty(true);
}

function athleteRecordMarkup(record) {
    return `<div class="athlete-record-row" data-entry-id="${esc(record.id || '')}">
      <label>Distance<input data-field="distance" maxlength="60" value="${esc(record.distance || '')}" placeholder="500 m"></label>
      <label>Temps<input data-field="time" maxlength="40" value="${esc(record.time || '')}" placeholder="45,32"></label>
      <label>Date<input data-field="date" type="date" value="${esc(record.date || '')}"></label>
      <label>Compétition<input data-field="competition" maxlength="120" value="${esc(record.competition || '')}"></label>
      <label>Notes<input data-field="notes" maxlength="500" value="${esc(record.notes || '')}"></label>
      <button class="btn small danger" type="button" data-entry-action="delete" aria-label="Supprimer ce temps">×</button>
    </div>`;
}

function athleteTrainingMarkup(training) {
    return `<div class="athlete-training-row" data-entry-id="${esc(training.id || '')}">
      <label>Date<input data-field="date" type="date" value="${esc(training.date || '')}"></label>
      <label>Type<input data-field="type" maxlength="100" value="${esc(training.type || '')}" placeholder="Glace, musculation…"></label>
      <label>Durée (min)<input data-field="duration" type="number" min="0" step="1" value="${esc(training.duration || '')}"></label>
      <label>Lieu<input data-field="location" maxlength="120" value="${esc(training.location || '')}"></label>
      <label>Notes<input data-field="notes" maxlength="1200" value="${esc(training.notes || '')}"></label>
      <button class="btn small danger" type="button" data-entry-action="delete" aria-label="Supprimer cet entraînement">×</button>
    </div>`;
}

function showAdminSection(name) {
  $$('[data-admin-section]').forEach((section) => { section.hidden = section.dataset.adminSection !== name; });
  $$('.admin-section-tab').forEach((button) => {
    const active = button.dataset.section === name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function fillGlobal() {
  const adminTitle = config.adminTitle || 'Administration du viewer';
  document.title = adminTitle + ' — CPV Cyclones Viewer 2000';
  $('#adminTitle').textContent = adminTitle;
  $('#cfgTitle').value = config.siteTitle || '';
  $('#cfgSubtitle').value = config.siteSubtitle || '';
  $('#cfgAdminTitle').value = adminTitle;
  $('#cfgLogoPageTitle').value = config.logoPageTitle || 'Logo — CPV Cyclones Viewer 2000';
  $('#cfgHint').value = config.hint || '';
  const c = config.accentColor || '#4d7ea6';
  $('#cfgAccent').value = /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#4d7ea6';
  $('#cfgAccentText').value = c;
}

function setAccentPreview() {
  const c = config.accentColor || '#4d7ea6';
  document.body.style.setProperty('--accent', c);
  document.body.style.setProperty('--primary-bg', c);
}

let fileMeta = {};
let checkedFileMeta = new Set();
let previewObserver = null;
let probing = false;
let tabFilterFrame = 0;

function metaLabel(f, val) {
  let parts = [fmtSize(f.size)];
  const m = fileMeta[val];
  if (m && m.w && m.h) parts.unshift(m.w + '×' + m.h);
  if (m && m.duration > 0.5) {
    const mbps = (f.size * 8 / m.duration) / 1e6;
    parts.push((mbps >= 1 ? mbps.toFixed(1) : Math.round(mbps * 1000)) + (mbps >= 1 ? ' Mbit/s' : ' kbit/s'));
  }
  return ' (' + parts.join(' · ') + ')';
}

function videoSrc(name) {
  return 'videos/' + name.split('/').map(encodeURIComponent).join('/');
}

function srcOptions(selectedSrc) {
  let html = '<option value="">— choisir un fichier —</option>';
  const paths = videoFiles.map((f) => videoSrc(f.name));
  if (selectedSrc && !paths.includes(selectedSrc)) {
    html += '<option value="' + esc(selectedSrc) + '" selected>Chemin actuel : ' + esc(selectedSrc) + '</option>';
  }
  const groups = new Map();
  videoFiles.forEach((f) => {
    const separator = f.name.lastIndexOf('/');
    const directory = separator < 0 ? '' : f.name.slice(0, separator);
    if (!groups.has(directory)) groups.set(directory, []);
    groups.get(directory).push(f);
  });
  groups.forEach((files, directory) => {
    const options = files.map((f) => {
      const val = videoSrc(f.name);
      const filename = f.name.slice(f.name.lastIndexOf('/') + 1);
      const sel = selectedSrc === val ? ' selected' : '';
      return '<option value="' + esc(val) + '"' + sel + '>' + esc(filename) + metaLabel(f, val) + '</option>';
    }).join('');
    if (!directory) {
      html += options;
    } else {
      html += '<optgroup label="' + esc(directory) + '/">' + options + '</optgroup>';
    }
  });
  return html;
}

function probeOne(f) {
  return new Promise((resolve) => {
    const val = videoSrc(f.name);
    const v = document.createElement('video');
    let done = false;
    let timeout;
    const finish = (meta) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      checkedFileMeta.add(val);
      if (meta) fileMeta[val] = meta;
      try { v.removeAttribute('src'); v.load(); } catch (e) {}
      resolve();
    };
    v.preload = 'metadata';
    v.addEventListener('loadedmetadata', () => finish({ w: v.videoWidth, h: v.videoHeight, duration: Number.isFinite(v.duration) ? v.duration : 0 }), { once: true });
    v.addEventListener('error', () => finish(null), { once: true });
    v.src = val;
    timeout = setTimeout(() => finish(null), 8000);
  });
}

async function probeVideoMeta() {
  if (probing) return;
  probing = true;
  const pending = videoFiles.filter((f) => !checkedFileMeta.has(videoSrc(f.name)));
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const f = pending[next++];
      await probeOne(f);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, worker));
    refreshSrcOptions();
  } finally {
    probing = false;
  }
}

function renderTabs() {
  if (previewObserver) previewObserver.disconnect();
  const fragment = document.createDocumentFragment();
  if (!config.tabs.length) {
    const p = document.createElement('p');
    p.className = 'muted-note';
    p.textContent = 'Aucun onglet. Ajoutez-en un.';
    fragment.appendChild(p);
  }
  config.tabs.forEach((t, i) => fragment.appendChild(buildTabCard(t, i)));
  tabsEditor.replaceChildren(fragment);
  $$('.prev', tabsEditor).forEach((preview) => watchPreview(preview));
  refreshTabOrderControls();
  updateTabFilter();
  renderPhotoTargetOptions();
}

function watchPreview(preview) {
  if (!('IntersectionObserver' in window)) {
    loadPreview(preview);
    return;
  }
  if (!previewObserver) {
    previewObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        loadPreview(entry.target);
        previewObserver.unobserve(entry.target);
      });
    }, { rootMargin: '200px 0px' });
  }
  previewObserver.observe(preview);
}

function loadPreview(preview) {
  const src = preview.dataset.src || '';
  if (!src) {
    preview.removeAttribute('src');
    preview.dataset.loaded = 'false';
    preview.load();
    return;
  }
  if (preview.getAttribute('src') === src) return;
  preview.preload = 'metadata';
  preview.setAttribute('src', src);
  preview.dataset.loaded = 'true';
  preview.load();
}

function updateTabFilter() {
  const query = $('#tabSearch').value.trim().toLocaleLowerCase();
  let visible = 0;
  $$('.tab-card', tabsEditor).forEach((card) => {
    const searchable = [
      $('.name', card).value,
      $('.srcPath', card)?.value || '',
      $('.poster', card)?.value || '',
      $('.folderId option:checked', card)?.textContent || ''
    ].join(' ').toLocaleLowerCase();
    const matches = !query || searchable.includes(query);
    card.hidden = !matches;
    if (matches) visible += 1;
  });
  $('#tabFilterStatus').textContent = query
    ? visible + ' résultat' + (visible === 1 ? '' : 's') + ' sur ' + config.tabs.length
    : config.tabs.length + ' onglet' + (config.tabs.length === 1 ? '' : 's');
}

function scheduleTabFilter() {
  if (tabFilterFrame) return;
  tabFilterFrame = requestAnimationFrame(() => {
    tabFilterFrame = 0;
    updateTabFilter();
  });
}

function refreshTabOrderControls() {
  const cards = $$('.tab-card', tabsEditor);
  const firstByFolder = new Map();
  const lastByFolder = new Map();
  cards.forEach((card, i) => {
    const folderId = $('.folderId', card).value;
    if (!firstByFolder.has(folderId)) firstByFolder.set(folderId, i);
    lastByFolder.set(folderId, i);
  });
  cards.forEach((card, i) => {
    card.dataset.i = String(i);
    $('.tnum', card).textContent = String(i + 1);
    const folderId = $('.folderId', card).value;
    $('[data-act="tabUp"]', card).disabled = firstByFolder.get(folderId) === i;
    $('[data-act="tabDown"]', card).disabled = lastByFolder.get(folderId) === i;
  });
}

function moveTabCard(card, direction) {
  const cards = $$('.tab-card', tabsEditor);
  const index = cards.indexOf(card);
  const folderId = $('.folderId', card).value;
  const step = direction < 0 ? -1 : 1;
  let target = index + step;
  while (target >= 0 && target < cards.length && $('.folderId', cards[target]).value !== folderId) {
    target += step;
  }
  if (target < 0 || target >= cards.length) return;

  if (step < 0) tabsEditor.insertBefore(card, cards[target]);
  else tabsEditor.insertBefore(cards[target], card);
  refreshTabOrderControls();
  updateTabFilter();
  setConfigDirty(true);
}

function folderOptions(selectedId) {
  let html = '<option value="">Racine</option>';
  const visit = (folders, parents) => (folders || []).forEach((folder) => {
    const path = parents.concat(folder.name);
    html += '<option value="' + esc(folder.id) + '"' + (selectedId === folder.id ? ' selected' : '') + '>' + esc(path.join(' / ')) + '</option>';
    visit(folder.children, path);
  });
  visit(config.folders, []);
  return html;
}

function renderFolderTree() {
  const tree = $('#folderTree');
  tree.replaceChildren();
  let total = 0;
  const count = (folders) => (folders || []).reduce((sum, folder) => sum + 1 + count(folder.children), 0);
  total = count(config.folders);
  $('#addRootFolderBtn').disabled = total >= 100;

  const append = (folders, depth) => (folders || []).forEach((folder) => {
    const row = document.createElement('div');
    row.className = 'folder-row';
    row.style.paddingInlineStart = (depth * 20) + 'px';
    const name = document.createElement('span');
    name.className = 'folder-name';
    name.textContent = folder.name;
    row.appendChild(name);
    if (depth < 4 && total < 100) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'btn small';
      add.dataset.parentFolder = folder.id;
      add.textContent = '+ Sous-dossier';
      row.appendChild(add);
    }
    tree.appendChild(row);
    append(folder.children, depth + 1);
  });
  append(config.folders, 0);
}

function refreshFolderSelectors() {
  $$('.folderId', tabsEditor).forEach((select) => {
    refreshFolderSelector(select);
  });
}

function refreshFolderSelector(select) {
  const selected = select.value;
  select.innerHTML = folderOptions(selected);
  select.value = selected;
}

function createFolder(parentId) {
  const name = prompt(parentId ? 'Nom du sous-dossier :' : 'Nom du dossier :');
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80) {
    toast('Le nom doit contenir de 1 à 80 caractères.', 'err');
    return;
  }
  let parent = null;
  if (parentId) {
    const find = (folders) => {
      for (const folder of folders || []) {
        if (folder.id === parentId) return folder;
        const nested = find(folder.children);
        if (nested) return nested;
      }
      return null;
    };
    parent = find(config.folders);
    if (!parent) return;
  }
  const total = argumentsCount(config.folders);
  if (total >= 100 || (parent && folderDepth(parentId) >= 4)) {
    toast('Limite de dossiers atteinte.', 'err');
    return;
  }
  const id = 'folder-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  const folder = { id, name: trimmed, children: [] };
  if (parent) parent.children.push(folder);
  else config.folders.push(folder);
  renderFolderTree();
  refreshFolderSelectors();
  renderYoutubeFolderOptions();
  setConfigDirty(true);
  toast('Dossier créé : ' + trimmed, 'ok');
}

function argumentsCount(folders) {
  return (folders || []).reduce((sum, folder) => sum + 1 + argumentsCount(folder.children), 0);
}

function folderDepth(folderId, folders, depth) {
  folders = folders || config.folders;
  depth = depth || 0;
  for (const folder of folders || []) {
    if (folder.id === folderId) return depth;
    const found = folderDepth(folderId, folder.children, depth + 1);
    if (found >= 0) return found;
  }
  return -1;
}

function buildTabCard(tab, i) {
  const card = document.createElement('div');
  card.className = 'tab-card';
  card.dataset.i = String(i);
  card.dataset.tabType = tab.type === 'photo' ? 'photo' : 'video';

  card.innerHTML =
    '<div class="tab-card-head">' +
      '<span class="tnum">' + (i + 1) + '</span>' +
      '<input class="name" value="' + esc(tab.name) + '" placeholder="Nom de l\'onglet" maxlength="80">' +
      '<label class="folder-field">Dossier dans la barre du haut' +
        '<select class="folderId">' + folderOptions(tab.folderId || '') + '</select>' +
      '</label>' +
      '<span class="tab-order-actions" aria-label="Ordre dans la barre du haut">' +
        '<button class="btn small" data-act="tabUp" type="button" title="Monter dans la barre du haut" aria-label="Monter dans la barre du haut">&#8593;</button>' +
        '<button class="btn small" data-act="tabDown" type="button" title="Descendre dans la barre du haut" aria-label="Descendre dans la barre du haut">&#8595;</button>' +
      '</span>' +
      '<button class="btn small" data-act="toggleTab" type="button" aria-expanded="true">Réduire</button>' +
      (config.tabs.length > 1 ? '<button class="btn small danger" data-act="delTab" type="button">Supprimer</button>' : '') +
    '</div>' +
    '<div class="tab-card-body">' +
    (tab.type === 'photo'
      ? '<div class="photo-editor"><p class="muted-note">Onglet de type « Photos ». Ajoutez des photos depuis le panneau Photos.</p><div class="photo-list"></div><button class="btn small add-photo" type="button">+ Ajouter une photo</button></div>'
      : '<div class="grid2">' +
          '<div class="src-block">' +
            '<label>Choisir un fichier envoyé dans videos/ (facultatif)' +
              '<select class="src">' + srcOptions(tab.src) + '</select>' +
            '</label>' +
            '<label>Chemin de la vidéo (relatif à la racine du site)' +
              '<input class="srcPath" value="' + esc(tab.src) + '" placeholder="provincialuno/mon-fichier.mp4">' +
            '</label>' +
            '<label>Poster (image, facultatif)' +
              '<input class="poster" value="' + esc(tab.poster) + '" placeholder="ex : images/poster.jpg">' +
            '</label>' +
          '</div>' +
          '<div class="preview-box">' +
            '<video class="prev" controls playsinline preload="metadata"></video>' +
            '<button class="btn small capture-btn" type="button">&#9200; Ajouter un timecode à l\'instant</button>' +
          '</div>' +
        '</div>' +
        '<h3>Timecodes</h3>' +
        '<div class="tc-wrap"><table class="tc-table"><thead>' +
          '<tr><th>Nom</th><th>Temps</th><th>Couleur</th><th style="text-align:right">Ordre</th></tr>' +
        '</thead><tbody></tbody></table></div>' +
        '<button class="btn small add-tc" type="button">+ Ajouter un timecode</button>' +
        '<h3>Qualités vidéo</h3>' +
        '<p class="muted-note">Versions alternatives de la vidéo (ex : 720p, 480p). Le spectateur pourra les choisir dans les réglages du lecteur.</p>' +
        '<div class="q-list"></div>' +
        '<button class="btn small add-q" type="button">+ Ajouter une qualité</button>') +
    '</div>';

  const qlist = $('.q-list', card);
  if (qlist) (tab.qualities || []).forEach((q) => qlist.appendChild(buildQualityRow(q)));

  const tbody = $('.tc-table tbody', card);
  if (tbody && tab.timecodes && tab.timecodes.length) {
    tab.timecodes.forEach((tc) => tbody.appendChild(buildTcRow(card, tc)));
  } else if (tbody) {
    tbody.appendChild(emptyRow());
  }

  const prev = $('.prev', card);
  if (prev) {
    prev.preload = 'none';
    prev.dataset.src = tab.src || '';
    let previewUpdateTimer;
    $('.src', card).addEventListener('change', (e) => {
      $('.srcPath', card).value = e.target.value;
      prev.dataset.src = e.target.value.trim();
      loadPreview(prev);
      probeVideoMeta();
    });
    $('.srcPath', card).addEventListener('input', () => {
      prev.dataset.src = $('.srcPath', card).value.trim();
      clearTimeout(previewUpdateTimer);
      previewUpdateTimer = setTimeout(() => {
        if (card.isConnected) loadPreview(prev);
      }, 300);
    });
    $('.capture-btn', card).addEventListener('click', () => {
      const d = prev.duration;
      if (!d || !Number.isFinite(d)) { toast('Chargez d\'abord la vidéo dans l\'aperçu', 'err'); return; }
      $('.add-tc', card).click();
      const rows = $$('.tc-time-input', card);
      if (rows.length) rows[rows.length - 1].value = fmtTime(prev.currentTime);
      toast('Timecode ajouté à ' + fmtTime(prev.currentTime));
    });
  }
  $('.name', card).addEventListener('input', () => {
    scheduleTabFilter();
    renderPhotoTargetOptions();
  });
  const srcPath = $('.srcPath', card);
  if (srcPath) srcPath.addEventListener('input', scheduleTabFilter);
  $('.folderId', card).addEventListener('change', () => {
    updateTabFilter();
    refreshTabOrderControls();
  });
  const addTcBtn = $('.add-tc', card);
  if (addTcBtn) addTcBtn.addEventListener('click', () => {
    const tbody = $('.tc-table tbody', card);
    const ph = $('.placeholder', tbody);
    if (ph) ph.remove();
    tbody.appendChild(buildTcRow(card, { t: 0, label: '', color: '#4d7ea6' }));
  });

  const addQualityBtn = $('.add-q', card);
  if (addQualityBtn) addQualityBtn.addEventListener('click', () => {
    $('.q-list', card).appendChild(buildQualityRow({ name: '', src: '' }));
  });

  const photoListEl = card.querySelector('.photo-list');
  if (photoListEl && tab.type === 'photo') {
    (Array.isArray(tab.photos) ? tab.photos : []).forEach((p) => photoListEl.appendChild(buildPhotoRow(p)));
  }
  const addPhotoBtn = card.querySelector('.add-photo');
  if (addPhotoBtn) {
    addPhotoBtn.addEventListener('click', () => {
      if (!photoListEl) return;
      photoListEl.appendChild(buildPhotoRow({ src: '', alt: '', caption: '' }));
    });
  }

  card.addEventListener('click', (e) => {
    const actBtn = e.target.closest('[data-act]');
    if (!actBtn) return;
    const act = actBtn.dataset.act;
    if (act === 'toggleTab') {
      const collapsed = card.classList.toggle('collapsed');
      actBtn.textContent = collapsed ? 'Développer' : 'Réduire';
      actBtn.setAttribute('aria-expanded', String(!collapsed));
      return;
    }
    if (act === 'tabUp' || act === 'tabDown') {
      moveTabCard(card, act === 'tabUp' ? -1 : 1);
      return;
    }
    if (act === 'delTab') {
      if (!confirm('Supprimer cet onglet ?')) return;
      const index = $$('.tab-card', tabsEditor).indexOf(card);
      try { readAllFromDom(); } catch (e) {}
      config.tabs.splice(index, 1);
      renderTabs();
      toast('Onglet supprimé.');
    }
    if (act === 'qdel') {
      const row = actBtn.closest('.q-row');
      if (row) row.remove();
      return;
    }
    if (act === 'pdel') {
      const row = actBtn.closest('.photo-row');
      if (row) row.remove();
      return;
    }
    if (act === 'del' || act === 'up' || act === 'down') {
      const tr = actBtn.closest('tr');
      const tbody = tr.parentNode;
      const rows = Array.from(tbody.children);
      const idx = rows.indexOf(tr);
      if (act === 'del') {
        rows[idx].remove();
        if (!tbody.children.length && tbody.classList.contains('tc-table')) tbody.appendChild(emptyRow());
      } else if (act === 'up' && idx > 0) {
        tbody.insertBefore(rows[idx], rows[idx - 1]);
      } else if (act === 'down' && idx < rows.length - 1) {
        tbody.insertBefore(rows[idx + 1], rows[idx]);
      }
    }
  });

  return card;
}

function photoSrc(name) {
  return '/photos/' + name.split('/').map(encodeURIComponent).join('/');
}

function photoOptions(selectedSrc) {
  let html = '<option value="">Choisir une photo…</option>';
  const paths = photoFiles.map((photo) => photoSrc(photo.name));
  if (selectedSrc && !paths.includes(selectedSrc)) {
    html += '<option value="' + esc(selectedSrc) + '" selected>Chemin actuel : ' + esc(selectedSrc) + '</option>';
  }
  photoFiles.forEach((photo) => {
    const src = photoSrc(photo.name);
    html += '<option value="' + esc(src) + '"' + (src === selectedSrc ? ' selected' : '') + '>' + esc(photo.name) + '</option>';
  });
  return html;
}

function buildPhotoRow(photo) {
  const row = document.createElement('div');
  row.className = 'photo-row';
  row.innerHTML =
    '<label class="photo-src-label">Fichier photo<select class="photo-src">' + photoOptions(photo.src || '') + '</select></label>' +
    '<label>Texte alternatif<input class="photo-alt" maxlength="200" value="' + esc(photo.alt || '') + '"></label>' +
    '<label>Légende<input class="photo-caption" maxlength="300" value="' + esc(photo.caption || '') + '"></label>' +
    '<button class="btn small danger" data-act="pdel" type="button" aria-label="Retirer la photo">Supprimer</button>';
  return row;
}

function emptyRow() {
  const tr = document.createElement('tr');
  tr.className = 'placeholder';
  tr.innerHTML = '<td colspan="4">Aucun timecode. Cliquez sur « Ajouter un timecode ».</td>';
  return tr;
}

function buildTcRow(card, tc) {
  const color = tc.color && /^#[0-9a-fA-F]{6}$/.test(tc.color) ? tc.color : '#4d7ea6';
  const tr = document.createElement('tr');
  tr.innerHTML =
    '<td><input class="tc-label-input" value="' + esc(tc.label || '') + '" placeholder="Nom du timecode" maxlength="120"></td>' +
    '<td><input class="tc-time-input" value="' + esc(fmtTime(tc.t)) + '" placeholder="0:00"></td>' +
    '<td><input class="tc-color-input" type="color" value="' + color + '" title="Couleur du marqueur"></td>' +
    '<td><span class="row-actions">' +
      '<button class="btn small" data-act="up" type="button" title="Monter" aria-label="Monter">&#8593;</button>' +
      '<button class="btn small" data-act="down" type="button" title="Descendre" aria-label="Descendre">&#8595;</button>' +
      '<button class="btn small danger" data-act="del" type="button" title="Supprimer" aria-label="Supprimer">&#10005;</button>' +
    '</span></td>';
  return tr;
}

function buildQualityRow(q) {
  const row = document.createElement('div');
  row.className = 'q-row';
  row.innerHTML =
    '<label class="q-name-label">Nom de la qualité' +
      '<input class="q-name" value="' + esc(q.name || '') + '" placeholder="ex : 720p" maxlength="40">' +
    '</label>' +
    '<label class="q-src-label">Fichier' +
      '<select class="qsrc">' + srcOptions(q.src) + '</select>' +
    '</label>' +
    '<label class="q-path-label">Chemin (relatif à la racine)' +
      '<input class="qPath" value="' + esc(q.src || '') + '" placeholder="videos/ma-video-720p.mp4">' +
    '</label>' +
    '<label class="q-auto"><input type="checkbox" class="q-auto-cb"' + (q.auto ? ' checked' : '') + '> Auto (au démarrage)</label>' +
    '<span class="row-actions q-actions">' +
      '<button class="btn small danger" data-act="qdel" type="button" title="Supprimer la qualité" aria-label="Supprimer la qualité">&#10005;</button>' +
    '</span>';

  const sel = $('.qsrc', row);
  const pathInput = $('.qPath', row);
  sel.addEventListener('change', () => {
    if (sel.value) pathInput.value = sel.value;
    probeVideoMeta();
  });
  const cb = $('.q-auto-cb', row);
  cb.addEventListener('change', () => {
    if (cb.checked) {
      const cardEl = row.closest('.tab-card');
      if (cardEl) $$('.q-auto-cb', cardEl).forEach((c) => { if (c !== cb) c.checked = false; });
    }
  });
  return row;
}

function renderPhotoTargetOptions() {
  const select = $('#photoTarget');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">Choisir un onglet photo…</option>' + $$('.tab-card', tabsEditor)
    .map((card, index) => card.dataset.tabType === 'photo'
      ? '<option value="' + index + '">' + esc($('.name', card).value || 'Photos') + '</option>'
      : '').join('');
  if (Array.from(select.options).some((option) => option.value === current)) select.value = current;
}

function renderPhotoList() {
  const list = $('#photoList');
  if (!list) return;
  list.replaceChildren();
  const query = ($('#photoSearch')?.value || '').trim().toLocaleLowerCase();
  const order = $('#photoSort')?.value || 'newest';
  const files = photoFiles.filter((photo) => !query || photo.name.toLocaleLowerCase().includes(query)).slice();
  files.sort((a, b) => {
    if (order === 'name') return a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' });
    if (order === 'oldest') return a.mtime - b.mtime;
    if (order === 'largest') return b.size - a.size;
    return b.mtime - a.mtime;
  });
  if (!files.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = photoFiles.length ? 'Aucune photo ne correspond à cette recherche.' : 'Aucune photo envoyée pour le moment.';
    list.appendChild(empty);
    return;
  }
  files.forEach((photo) => {
    const item = document.createElement('li');
    const image = document.createElement('img');
    image.className = 'photo-thumb';
    image.src = photoSrc(photo.name);
    image.alt = '';
    image.loading = 'lazy';
    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = photo.name;
    const size = document.createElement('span');
    size.className = 'fsize';
    size.textContent = fmtSize(photo.size);
    const add = document.createElement('button');
    add.className = 'btn small';
    add.type = 'button';
    add.textContent = 'Ajouter à l’onglet';
    add.dataset.photoAdd = photo.name;
    item.append(image, name, size, add);
    list.appendChild(item);
  });
}

async function refreshPhotos() {
  try {
    const data = await api('/api/photos');
    photoFiles = data.photos || [];
    renderPhotoList();
    $$('.photo-src', tabsEditor).forEach((select) => {
      const current = select.value;
      select.innerHTML = photoOptions(current);
      select.value = current;
    });
  } catch (error) {
    toast('Impossible d’actualiser les photos : ' + error.message, 'err');
  }
}

async function uploadPhoto(incomingFiles) {
  const input = $('#photoUploadInput');
  const files = Array.from(incomingFiles || input.files || []);
  if (!files.length) return;
  const progress = $('#photoUploadProg');
  const message = $('#photoUploadMsg');
  progress.hidden = false;
  progress.value = 0;
  let uploaded = 0;
  const errors = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    message.textContent = 'Envoi ' + (index + 1) + '/' + files.length + ' : ' + file.name;
    if (!/\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(file.name)) {
      errors.push(file.name + ' : format non supporté');
      continue;
    }
    try {
      await uploadOnePhoto(file, (loaded) => {
        progress.value = Math.min(100, loaded / Math.max(file.size, 1) * 100);
      });
      uploaded += 1;
      recordAction('Photo envoyée : ' + file.name, 'ok');
    } catch (error) {
      errors.push(file.name + ' : ' + error.message);
    }
  }
  progress.hidden = true;
  message.textContent = '';
  if (!incomingFiles) input.value = '';
  await refreshPhotos();
  toast(errors.length ? uploaded + ' photo(s) envoyée(s), ' + errors.length + ' échec(s) : ' + errors[0] : uploaded + ' photo(s) envoyée(s).', errors.length ? 'err' : 'ok');
}

function uploadOnePhoto(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload/photo?name=' + encodeURIComponent(file.name));
    xhr.setRequestHeader('x-admin-pass', pass);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (error) {}
      if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) resolve();
      else reject(new Error((data && data.error) || ('HTTP ' + xhr.status)));
    };
    xhr.onerror = () => reject(new Error('Erreur réseau pendant l’envoi'));
    xhr.send(file);
  });
}

/* ---------- video files ---------- */

function renderVideoList() {
  const ul = $('#videoList');
  ul.innerHTML = '';
  const query = ($('#fileSearch')?.value || '').trim().toLocaleLowerCase();
  const dateFilter = $('#fileDate')?.value || '';
  const order = $('#fileSort')?.value || 'newest';
  const files = videoFiles.filter((file) => {
    if (query && !file.name.toLocaleLowerCase().includes(query)) return false;
    if (!dateFilter) return true;
    const date = new Date(file.mtime);
    const key = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
    return key === dateFilter;
  }).slice();
  files.sort((a, b) => {
    if (order === 'name') return a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' });
    if (order === 'oldest') return a.mtime - b.mtime;
    if (order === 'largest') return b.size - a.size;
    return b.mtime - a.mtime;
  });
  if (!videoFiles.length || !files.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = videoFiles.length
      ? 'Aucun fichier ne correspond à cette recherche.'
      : 'Aucun fichier dans videos/. Les vidéos d’autres dossiers du serveur restent accessibles par leur chemin configuré.';
    ul.appendChild(li);
  }
  files.forEach((f) => {
    const li = document.createElement('li');
    const checkboxLabel = document.createElement('label');
    checkboxLabel.className = 'file-check';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.selectVideo = f.name;
    checkboxLabel.appendChild(checkbox);
    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = f.name;
    const size = document.createElement('span');
    size.className = 'fsize';
    size.textContent = fmtSize(f.size);
    const use = document.createElement('button');
    use.className = 'btn small';
    use.type = 'button';
    use.textContent = 'Utiliser';
    use.title = 'Affecter ce fichier au premier onglet sans vidéo';
    use.dataset.videoAction = 'use';
    use.dataset.video = f.name;
    const rename = document.createElement('button');
    rename.className = 'btn small';
    rename.type = 'button';
    rename.textContent = 'Renommer';
    rename.dataset.videoAction = 'rename';
    rename.dataset.video = f.name;
    const move = document.createElement('button');
    move.className = 'btn small';
    move.type = 'button';
    move.textContent = 'Déplacer';
    move.dataset.videoAction = 'move';
    move.dataset.video = f.name;
    const del = document.createElement('button');
    del.className = 'btn small danger';
    del.type = 'button';
    del.textContent = 'Supprimer';
    del.dataset.videoAction = 'delete';
    del.dataset.video = f.name;
    li.appendChild(checkboxLabel);
    li.appendChild(name);
    li.appendChild(size);
    li.appendChild(use);
    li.appendChild(rename);
    li.appendChild(move);
    li.appendChild(del);
    ul.appendChild(li);
  });
  updateVideoSelection();
  renderVideoDestinationOptions();
}

function renderVideoDestinationOptions() {
  const select = $('#fileDestination');
  if (!select) return;
  const current = select.value;
  const directories = new Set();
  videoFiles.forEach((file) => {
    const parts = file.name.split('/');
    parts.pop();
    for (let index = 1; index <= parts.length; index += 1) directories.add(parts.slice(0, index).join('/'));
  });
  select.innerHTML = '<option value="">Racine de videos/</option>' + Array.from(directories).sort().map((directory) =>
    `<option value="${esc(directory)}">${esc(directory)}</option>`
  ).join('');
  if (directories.has(current)) select.value = current;
}

function selectedVideoNames() {
  return $$('[data-select-video]:checked', $('#videoList')).map((checkbox) => checkbox.dataset.selectVideo);
}

function updateVideoSelection() {
  const selected = selectedVideoNames();
  const visible = $$('[data-select-video]', $('#videoList'));
  $('#fileSelectionStatus').textContent = selected.length ? selected.length + ' sélectionné' + (selected.length === 1 ? '' : 's') : videoFiles.length + ' fichier' + (videoFiles.length === 1 ? '' : 's');
  $('#moveSelectedBtn').disabled = !selected.length;
  $('#deleteSelectedBtn').disabled = !selected.length;
  const selectAll = $('#selectAllFiles');
  selectAll.checked = visible.length > 0 && visible.every((checkbox) => checkbox.checked);
  selectAll.indeterminate = selected.length > 0 && !selectAll.checked;
}

function fmtSize(b) {
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' Go';
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' Mo';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' Ko';
  return b + ' o';
}

function bindVideoList() {
  $('#uploadInput').addEventListener('change', () => uploadVideo());
  const photoInput = $('#photoUploadInput');
  if (photoInput) photoInput.addEventListener('change', () => uploadPhoto());
  const photoDropzone = $('#photoDropzone');
  if (photoDropzone) {
    photoDropzone.addEventListener('dragover', (event) => {
      event.preventDefault();
      photoDropzone.classList.add('dragover');
    });
    photoDropzone.addEventListener('dragleave', (event) => {
      if (!photoDropzone.contains(event.relatedTarget)) photoDropzone.classList.remove('dragover');
    });
    photoDropzone.addEventListener('drop', (event) => {
      event.preventDefault();
      photoDropzone.classList.remove('dragover');
      if (event.dataTransfer && event.dataTransfer.files.length) uploadPhoto(event.dataTransfer.files);
    });
  }
  const photoSearch = $('#photoSearch');
  if (photoSearch) photoSearch.addEventListener('input', renderPhotoList);
  const photoSort = $('#photoSort');
  if (photoSort) photoSort.addEventListener('change', renderPhotoList);
  $('#photoList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-photo-add]');
    if (!button) return;
    const targetValue = $('#photoTarget').value;
    const targetIndex = Number(targetValue);
    const targetCard = targetValue === '' ? null : $$('.tab-card', tabsEditor)[targetIndex];
    const photoList = targetCard && $('.photo-list', targetCard);
    if (!Number.isInteger(targetIndex) || !photoList || targetCard.dataset.tabType !== 'photo') {
      toast('Choisissez d’abord un onglet photo.', 'err');
      $('#photoTarget').focus();
      return;
    }
    const src = photoSrc(button.dataset.photoAdd);
    if (!$$('.photo-src', photoList).some((select) => select.value === src)) {
      photoList.appendChild(buildPhotoRow({ src, alt: button.dataset.photoAdd.replace(/\.[^.]+$/, ''), caption: '' }));
    }
    $('.add-photo', targetCard).scrollIntoView({ behavior: 'smooth', block: 'center' });
    setConfigDirty(true);
    toast('Photo ajoutée à « ' + $('.name', targetCard).value + ' ». Enregistrez la configuration pour publier.', 'ok');
  });
  const dropzone = $('#videoDropzone');
  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', (event) => {
    if (!dropzone.contains(event.relatedTarget)) dropzone.classList.remove('dragover');
  });
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragover');
    if (event.dataTransfer && event.dataTransfer.files.length) uploadVideo(event.dataTransfer.files);
  });
  $('#fileSearch').addEventListener('input', renderVideoList);
  $('#fileDate').addEventListener('change', renderVideoList);
  $('#fileSort').addEventListener('change', renderVideoList);
  $('#selectAllFiles').addEventListener('change', (event) => {
    $$('[data-select-video]', $('#videoList')).forEach((checkbox) => { checkbox.checked = event.target.checked; });
    updateVideoSelection();
  });
  $('#videoList').addEventListener('change', updateVideoSelection);

  $('#videoList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-video-action]');
    if (!btn) return;
    const name = btn.dataset.video;
    if (btn.dataset.videoAction === 'delete') {
      if (!confirm('Supprimer définitivement le fichier ' + name + ' ?')) return;
      try {
        await api('/api/video?name=' + encodeURIComponent(name), { method: 'DELETE' });
        recordAction('Vidéo supprimée : ' + name, 'warn');
        toast('Fichier supprimé : ' + name, 'ok');
        await refreshVideos();
      } catch (err) {
        toast('Erreur : ' + err.message, 'err');
      }
      return;
    }
    if (btn.dataset.videoAction === 'rename') {
      const oldBase = name.split('/').pop();
      const oldExt = oldBase.includes('.') ? oldBase.slice(oldBase.lastIndexOf('.')) : '';
      const entered = prompt('Nouveau nom du fichier :', oldBase);
      if (entered === null) return;
      const base = entered.trim();
      if (!base || /[\\/]/.test(base)) {
        toast('Entrez uniquement un nom de fichier, sans chemin.', 'err');
        return;
      }
      const newBase = oldExt && !base.toLowerCase().endsWith(oldExt.toLowerCase()) ? base + oldExt : base;
      const directory = name.includes('/') ? name.slice(0, name.lastIndexOf('/') + 1) : '';
      await moveVideo(name, directory + newBase, 'Vidéo renommée.');
      return;
    }
    if (btn.dataset.videoAction === 'move') {
      const folder = $('#fileDestination').value;
      const base = name.split('/').pop();
      const destination = folder ? folder + '/' + base : base;
      await moveVideo(name, destination, 'Vidéo déplacée.');
      return;
    }
    if (btn.dataset.videoAction === 'use') {
      const src = videoSrc(name);
      const target = config.tabs.find((t) => !t.src || t.src === src) || config.tabs[0];
      if (!target) {
        toast('Ajoutez d’abord un onglet vidéo.', 'err');
        return;
      }
      target.src = src;
      const card = tabsEditor.querySelector('.tab-card[data-i="' + config.tabs.indexOf(target) + '"]');
      if (card) {
        $('.srcPath', card).value = target.src;
        $('.src', card).value = target.src;
      }
      setConfigDirty(true);
      toast('Vidéo affectée à l\'onglet « ' + target.name + ' »', 'ok');
    }
  });

  $('#moveSelectedBtn').addEventListener('click', moveSelectedVideos);
  $('#deleteSelectedBtn').addEventListener('click', deleteSelectedVideos);
}

async function moveVideo(source, destination, successMessage) {
  const wasDirty = $('#configState').classList.contains('dirty');
  if (!readAllFromDom()) {
    toast('Corrigez les erreurs de configuration avant de déplacer ou renommer une vidéo.', 'err');
    return;
  }
  try {
    await api('/api/video', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, destination })
    });
    updateMovedVideoReferences(source, destination);
    recordAction(successMessage + ' ' + destination, 'ok');
    toast(successMessage + ' ' + destination, 'ok');
    await refreshVideos();
    renderTabs();
    setConfigDirty(wasDirty);
  } catch (error) {
    toast('Impossible de déplacer/renommer le fichier : ' + error.message, 'err');
  }
}

function updateMovedVideoReferences(source, destination) {
  const oldPaths = new Set([videoSrc(source), 'videos/' + source]);
  const newPath = videoSrc(destination);
  config.tabs.forEach((tab) => {
    if (oldPaths.has(tab.src)) tab.src = newPath;
    (tab.qualities || []).forEach((quality) => {
      if (oldPaths.has(quality.src)) quality.src = newPath;
    });
  });
}

async function moveSelectedVideos() {
  const names = selectedVideoNames();
  if (!names.length) return;
  const wasDirty = $('#configState').classList.contains('dirty');
  if (!readAllFromDom()) {
    toast('Corrigez les erreurs de configuration avant de déplacer des vidéos.', 'err');
    return;
  }
  const folder = $('#fileDestination').value;
  const count = names.filter((name) => (folder ? folder + '/' : '') + name.split('/').pop() !== name).length;
  if (count && !confirm(`Déplacer ${count} fichier(s) vers ${folder || 'la racine de videos/'} ?`)) return;
  let moved = 0;
  const errors = [];
  for (const name of names) {
    const base = name.split('/').pop();
    const destination = folder ? folder + '/' + base : base;
    if (destination === name) continue;
    try {
      await api('/api/video', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: name, destination })
      });
      updateMovedVideoReferences(name, destination);
      moved += 1;
    } catch (error) {
      errors.push(name + ': ' + error.message);
    }
  }
  if (moved) {
    recordAction(moved + ' vidéo(s) déplacée(s)', 'ok');
    await refreshVideos();
    renderTabs();
    setConfigDirty(wasDirty);
  }
  toast(errors.length ? `${moved} déplacée(s), ${errors.length} échec(s) : ${errors[0]}` : moved + ' vidéo(s) déplacée(s).', errors.length ? 'err' : 'ok');
}

async function deleteSelectedVideos() {
  const names = selectedVideoNames();
  if (!names.length || !confirm(`Supprimer définitivement ${names.length} fichier(s) vidéo ?`)) return;
  let deleted = 0;
  const errors = [];
  for (const name of names) {
    try {
      await api('/api/video?name=' + encodeURIComponent(name), { method: 'DELETE' });
      deleted += 1;
    } catch (error) {
      errors.push(name + ': ' + error.message);
    }
  }
  if (deleted) {
    recordAction(deleted + ' vidéo(s) supprimée(s)', 'warn');
    await refreshVideos();
  }
  toast(errors.length ? `${deleted} supprimée(s), ${errors.length} échec(s) : ${errors[0]}` : deleted + ' vidéo(s) supprimée(s).', errors.length ? 'err' : 'ok');
}

async function uploadVideo(incomingFiles) {
  const input = $('#uploadInput');
  const files = Array.from(incomingFiles || input.files || []);
  if (!files.length) return;
  const prog = $('#uploadProg');
  const msg = $('#uploadMsg');
  prog.hidden = false;
  prog.value = 0;
  const errors = [];
  let uploaded = 0;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    msg.textContent = `Upload ${index + 1}/${files.length} : ${file.name}`;
    if (!/\.(mp4|m4v|webm|ogv|ogg|mov|mkv|avi)$/i.test(file.name)) {
      errors.push(file.name + ': format non supporté');
      continue;
    }
    try {
      await uploadOneVideo(file, (loaded) => {
        prog.value = Math.min(100, (loaded / Math.max(file.size, 1)) * 100);
      });
      uploaded += 1;
      recordAction('Vidéo uploadée : ' + file.name, 'ok');
    } catch (error) {
      errors.push(file.name + ': ' + error.message);
    }
  }
  prog.hidden = true;
  msg.textContent = '';
  if (!incomingFiles) input.value = '';
  await refreshVideos();
  toast(errors.length ? `${uploaded} vidéo(s) envoyée(s), ${errors.length} échec(s) : ${errors[0]}` : uploaded + ' vidéo(s) envoyée(s).', errors.length ? 'err' : 'ok');
}

function uploadOneVideo(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload?name=' + encodeURIComponent(file.name));
    xhr.setRequestHeader('x-admin-pass', pass);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (error) {}
      if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) resolve();
      else reject(new Error((data && data.error) || ('HTTP ' + xhr.status)));
    };
    xhr.onerror = () => reject(new Error('Erreur réseau pendant l’upload'));
    xhr.send(file);
  });
}

async function refreshVideos() {
  try {
    const vid = await api('/api/videos');
    videoFiles = vid.videos || [];
    renderVideoList();
    refreshSrcOptions();
  } catch (error) {
    toast('Impossible d’actualiser les fichiers vidéo : ' + error.message, 'err');
  }
}

function refreshSrcOptions() {
  $$('.src, .qsrc', tabsEditor).forEach((sel) => {
    const current = sel.value;
    sel.innerHTML = srcOptions(current);
    sel.value = current;
  });
}

/* ---------- YouTube / direct ---------- */

const YT_ACTIVE_STAGES = ['preparing', 'downloading', 'merging', 'transcoding'];
const YT_STAGE_LABELS = {
  preparing: 'Préparation',
  downloading: 'Téléchargement',
  merging: 'Traitement',
  transcoding: 'Conversion AV1',
  done: 'Terminé',
  error: 'Erreur',
  cancelled: 'Annulé'
};
let ytPollTimer = 0;
let ytInitialized = false;
const ytSeenDone = new Set();

function folderPathName(id, folders, parents) {
  for (const folder of folders || []) {
    const trail = (parents || []).concat(folder.name);
    if (folder.id === id) return trail.join(' / ');
    const found = folderPathName(id, folder.children, trail);
    if (found) return found;
  }
  return '';
}

function renderYoutubeFolderOptions() {
  const select = $('#ytFolder');
  if (!select) return;
  const current = select.value;
  select.innerHTML = folderOptions('');
  if (current && Array.from(select.options).some((option) => option.value === current)) select.value = current;
}

function renderYoutubeJobs(jobs) {
  const container = $('#ytJobs');
  if (!container) return;
  if (!jobs.length) {
    container.innerHTML = '<p class="muted-note">Aucun téléchargement pour le moment.</p>';
    return;
  }
  container.innerHTML = jobs.map((job) => {
    const active = YT_ACTIVE_STAGES.includes(job.stage);
    const label = YT_STAGE_LABELS[job.stage] || job.stage;
    const title = job.name || job.title || job.url;
    const pct = clamp(Math.round(job.progress || 0), 0, 100);
    const cancel = active
      ? '<button class="btn small danger" type="button" data-yt-cancel="' + esc(job.id) + '">Annuler</button>'
      : '';
    const file = job.fileName ? '<span class="yt-file">' + esc(job.fileName) + '</span>' : '';
    const folder = folderPathName(job.folderId, config.folders) || 'Racine';
    return '<article class="yt-job ' + esc(job.stage) + '">' +
      '<div class="yt-job-head"><strong>' + esc(title) + '</strong>' +
        '<span class="yt-stage">' + esc(label) + '</span>' + cancel + '</div>' +
      '<div class="yt-progress"><span style="width:' + pct + '%"></span></div>' +
      '<div class="yt-job-meta"><span>' + esc(job.message || '') + '</span><span>' + pct + ' %</span></div>' +
      '<div class="yt-job-foot"><span>' + esc(folder) + '</span>' + file + '</div>' +
    '</article>';
  }).join('');
}

async function refreshYoutubeJobs() {
  if (!config) return;
  let data;
  try {
    data = await api('/api/youtube/jobs');
  } catch (error) {
    return;
  }
  const jobs = data.jobs || [];
  renderYoutubeJobs(jobs);
  const tools = data.tools || {};
  const missing = [];
  if (!tools.ytDlp) missing.push('yt-dlp');
  if (!tools.ffmpeg) missing.push('ffmpeg');
  const info = $('#ytTools');
  if (info) {
    info.textContent = data.available
      ? 'yt-dlp et ffmpeg sont disponibles sur le serveur.'
      : 'Outils manquants sur le serveur : ' + missing.join(', ') + '.';
    info.classList.toggle('err', !data.available);
  }
  const startBtn = $('#ytStart');
  if (startBtn && !startBtn.dataset.busy) startBtn.disabled = !data.available;

  const doneIds = jobs.filter((job) => job.stage === 'done').map((job) => job.id);
  if (!ytInitialized) {
    doneIds.forEach((id) => ytSeenDone.add(id));
    ytInitialized = true;
    return;
  }
  const newlyDone = doneIds.filter((id) => !ytSeenDone.has(id));
  if (!newlyDone.length) return;
  newlyDone.forEach((id) => ytSeenDone.add(id));
  if ($('#configState').classList.contains('dirty')) {
    toast('Vidéo YouTube ajoutée côté serveur. Rechargez la page avant d’enregistrer pour ne pas l’écraser.', 'err');
    return;
  }
  try {
    config = await api('/api/config');
    render();
    setConfigDirty(false);
    toast('Vidéo YouTube ajoutée à la configuration.', 'ok');
  } catch (error) {
    toast('Vidéo prête, mais la configuration n’a pas pu être rechargée : ' + error.message, 'err');
  }
}

function bindYoutube() {
  const startBtn = $('#ytStart');
  if (!startBtn) return;
  startBtn.addEventListener('click', async () => {
    const url = $('#ytUrl').value.trim();
    if (!url) {
      toast('Collez un lien YouTube.', 'err');
      $('#ytUrl').focus();
      return;
    }
    startBtn.dataset.busy = '1';
    startBtn.disabled = true;
    try {
      await api('/api/youtube/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, name: $('#ytName').value.trim(), folderId: $('#ytFolder').value })
      });
      $('#ytUrl').value = '';
      $('#ytName').value = '';
      recordAction('Téléchargement YouTube lancé', 'info');
      toast('Téléchargement lancé.', 'ok');
      await refreshYoutubeJobs();
    } catch (error) {
      toast('Impossible de lancer le téléchargement : ' + error.message, 'err');
    } finally {
      delete startBtn.dataset.busy;
      startBtn.disabled = false;
    }
  });
  $('#ytJobs').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-yt-cancel]');
    if (!button) return;
    button.disabled = true;
    try {
      await api('/api/youtube/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: button.dataset.ytCancel })
      });
      toast('Annulation demandée.', 'ok');
      await refreshYoutubeJobs();
    } catch (error) {
      toast('Impossible d’annuler : ' + error.message, 'err');
      button.disabled = false;
    }
  });
}

/* ---------- global fields ---------- */

function mergeDiscoveredFolders(existingFolders, videoPaths) {
  const base = Array.isArray(existingFolders) ? existingFolders : DEFAULT_FOLDERS;
  const folders = JSON.parse(JSON.stringify(base));
  const discover = (path) => {
    const relative = path.replace(/^\/+/, '').replace(/\\/g, '/');
    if (!relative) return;
    const parts = relative.split('/').filter(Boolean);
    const name = parts.slice(0, -1).filter(Boolean);
    if (!name.length) return;
    let root = folders;
    name.forEach((segment, idx) => {
      const normalized = segment.trim();
      if (!normalized) return;
      let node = root.find((folder) => folder.name === normalized);
      if (!node) {
        node = { id: 'auto-folder-' + normalized + '-' + idx + '-' + Date.now().toString(36), name: normalized, children: [] };
        root.push(node);
      }
      root = node.children;
    });
  };
  videoPaths.forEach((path) => {
    const fileName = path.split('/').pop();
    if (!fileName) return;
    const dir = path.split('/').slice(0, -1).join('/');
    if (dir) discover(dir);
  });
  return folders;
}

function readMonitorSnapshot() {
  return {
    recent: Array.isArray(readLocalJSON(RECENT_KEY, [])) ? readLocalJSON(RECENT_KEY, []) : [],
    errors: Array.isArray(readLocalJSON(VIDEO_ERROR_KEY, [])) ? readLocalJSON(VIDEO_ERROR_KEY, []) : [],
    actions: Array.isArray(readLocalJSON(ACTION_LOG_KEY, [])) ? readLocalJSON(ACTION_LOG_KEY, []) : []
  };
}

async function refreshMonitor() {
  const monitor = $('#monitorStatus');
  const pingEl = $('#monitorPing');
  const diskEl = $('#monitorDisk');
  const videosEl = $('#monitorVideoCount');
  const recentEl = $('#monitorRecent');
  const errorsEl = $('#monitorVideoErrors');
  const actionsEl = $('#monitorActions');
  if (!monitor || !pingEl || !diskEl || !videosEl || !recentEl || !errorsEl || !actionsEl) return;

  const started = performance.now();
  try {
    const data = await api('/api/monitor', { cache: 'no-store' });
    const ping = Math.round(performance.now() - started);
    pingEl.textContent = ping + ' ms';
    const total = Number(data.disk && data.disk.total) || 0;
    const free = Number(data.disk && data.disk.free) || 0;
    const used = total ? ((total - free) / total) * 100 : 0;
    diskEl.textContent = formatBytes(free) + ' libre / ' + Math.round(used) + '% utilisé';
    const videoCount = Number(data.videos && data.videos.count) || 0;
    const videoSize = Number(data.videos && data.videos.totalSize) || 0;
    videosEl.textContent = videoCount + ' vidéos · ' + formatBytes(videoSize);
    $('#monitorAthleteCount').textContent = String(Number(data.athletes) || 0) + ' fiches';
    if (data.videos && Number.isFinite(data.videos.totalSize)) {
      videosEl.title = formatBytes(data.videos.totalSize) + ' utilisés dans videos/';
    }
    monitor.textContent = 'OK';
  } catch (e) {
    pingEl.textContent = '—';
    diskEl.textContent = 'Indisponible';
    videosEl.textContent = '—';
    $('#monitorAthleteCount').textContent = '—';
    monitor.textContent = 'Erreur';
  }

  const snapshot = readMonitorSnapshot();
  const recent = snapshot.recent.slice(0, 5);
  recentEl.innerHTML = recent.length
    ? recent.map((item) => '<li><span>' + esc(item.title || 'Vidéo') + '</span><small>' + esc(Math.max(0, Math.round((item.position || 0) / 60)) + ' min') + '</small></li>').join('')
    : '<li class="empty-monitor">Aucune vidéo visionnée récemment.</li>';

  const errors = snapshot.errors.slice(0, 5);
  errorsEl.innerHTML = errors.length
    ? errors.map((item) => '<li><span>' + esc(item.message || 'Erreur') + '</span><small>' + esc(new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) + '</small></li>').join('')
    : '<li class="empty-monitor">Aucune erreur de lecture enregistrée.</li>';

  const actions = snapshot.actions.slice(0, 5);
  actionsEl.innerHTML = actions.length
    ? actions.map((entry) => '<li><span>' + esc(entry.label || 'Action') + '</span><small>' + esc(new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) + '</small></li>').join('')
    : '<li class="empty-monitor">Aucun journal d’actions.</li>';
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '0 o';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return size.toFixed(size >= 10 || unit === 0 ? 0 : 1) + ' ' + units[unit];
}

function makeEntryId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

async function saveAthleteCard(card) {
  const get = (name) => $(`[data-field="${name}"]`, card);
  const athlete = {
    id: card.dataset.id,
    name: get('name').value.trim(),
    category: get('category').value.trim(),
    bio: get('bio').value.trim(),
    records: $$('.athlete-record-row', card).map((row) => ({
      id: row.dataset.entryId || makeEntryId('record'),
      distance: $('[data-field="distance"]', row).value.trim(),
      time: $('[data-field="time"]', row).value.trim(),
      date: $('[data-field="date"]', row).value,
      competition: $('[data-field="competition"]', row).value.trim(),
      notes: $('[data-field="notes"]', row).value.trim()
    })),
    trainings: $$('.athlete-training-row', card).map((row) => ({
      id: row.dataset.entryId || makeEntryId('training'),
      date: $('[data-field="date"]', row).value,
      type: $('[data-field="type"]', row).value.trim(),
      duration: Number($('[data-field="duration"]', row).value) || 0,
      location: $('[data-field="location"]', row).value.trim(),
      notes: $('[data-field="notes"]', row).value.trim()
    }))
  };
  const passwordInput = get('password');
  if (!athlete.name) {
    get('name').focus();
    toast('Le nom de l’athlète est obligatoire.', 'err');
    return;
  }
  const existing = athletes.some((entry) => entry.id === athlete.id && entry.hasPassword);
  if (!existing && passwordInput.value.length < 8) {
    passwordInput.focus();
    toast('Le mot de passe initial doit contenir au moins 8 caractères.', 'err');
    return;
  }
  if (passwordInput.value) athlete[existing ? 'newPassword' : 'password'] = passwordInput.value;
  const button = $('[data-athlete-action="save"]', card);
  button.disabled = true;
  try {
    const result = await api(existing ? '/api/athletes/' + encodeURIComponent(athlete.id) : '/api/athletes', {
      method: existing ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(athlete)
    });
    const saved = result.athlete;
    const index = athletes.findIndex((entry) => entry.id === saved.id);
    if (index < 0) athletes.push(saved);
    else athletes[index] = saved;
    syncCalendarTarget(saved, false);
    card.dataset.id = saved.id;
    $('.athlete-card-head strong', card).textContent = saved.name;
    passwordInput.value = '';
    passwordInput.required = false;
    passwordInput.placeholder = 'Laisser vide pour conserver le mot de passe';
    const passwordLabel = passwordInput.closest('label');
    passwordLabel.firstChild.textContent = 'Nouveau mot de passe (facultatif)';
    if (!$('.athlete-link', card)) {
      const link = document.createElement('div');
      link.className = 'athlete-link';
      link.innerHTML = `<label>Lien privé<input readonly value="${esc(location.origin + '/athlete.html?id=' + encodeURIComponent(saved.id))}"></label><button class="btn small" type="button" data-athlete-action="copy-link">Copier le lien</button>`;
      card.querySelector('.athlete-card-body').insertBefore(link, card.querySelector('.athlete-card-body section'));
    } else {
      $('input', $('.athlete-link', card)).value = location.origin + '/athlete.html?id=' + encodeURIComponent(saved.id);
    }
    const openLink = document.createElement('a');
    openLink.className = 'btn small';
    openLink.href = '/athlete.html?id=' + encodeURIComponent(saved.id);
    openLink.target = '_blank';
    openLink.rel = 'noopener';
    openLink.textContent = 'Ouvrir la fiche';
    if (!$('.athlete-card-head a', card)) $('[data-athlete-action="save"]', card).before(openLink);
    toast('Fiche enregistrée : ' + saved.name, 'ok');
    recordAction('Fiche athlète enregistrée : ' + saved.name, 'ok');
  } catch (error) {
    toast('Impossible d’enregistrer la fiche : ' + error.message, 'err');
  } finally {
    button.disabled = false;
  }
}

async function downloadFullBackup() {
  const button = $('#backupBtn');
  button.disabled = true;
  try {
    const data = await api('/api/backup', { cache: 'no-store' });
    const blob = new Blob([JSON.stringify(data.backup, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'cpv-sauvegarde-' + new Date().toISOString().slice(0, 10) + '.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    toast('Sauvegarde téléchargée : configuration et fiches (mots de passe hachés; fichiers vidéo exclus).', 'ok');
  } catch (error) {
    toast('Impossible de télécharger la sauvegarde : ' + error.message, 'err');
  } finally {
    button.disabled = false;
  }
}

function bindGlobals() {
  bindYoutube();
  const markEdited = (e) => {
    const target = e.target;
    if (tabsEditor.contains(target) || $('#calendarEditor').contains(target) || target.matches('#cfgTitle, #cfgSubtitle, #cfgAdminTitle, #cfgLogoPageTitle, #cfgAccent, #cfgAccentText, #cfgHint')) {
      setConfigDirty(true);
    }
  };
  appEl.addEventListener('input', markEdited);
  appEl.addEventListener('change', markEdited);
  tabsEditor.addEventListener('focusin', (e) => {
    if (e.target.matches('.folderId')) refreshFolderSelector(e.target);
  });
  tabsEditor.addEventListener('click', (e) => {
    if (e.target.closest('.add-tc, .add-q, .add-photo, [data-act]:not([data-act="toggleTab"])')) setConfigDirty(true);
  });

  const syncAccent = () => {
    const c = $('#cfgAccentText').value.trim();
    config.accentColor = c;
    if (/^#[0-9a-fA-F]{6}$/.test(c)) $('#cfgAccent').value = c;
    document.body.style.setProperty('--accent', c);
  };
  $('#cfgAccent').addEventListener('input', (e) => {
    $('#cfgAccentText').value = e.target.value;
    syncAccent();
  });
  $('#cfgAccentText').addEventListener('input', syncAccent);

  $('#addTabBtn').addEventListener('click', () => {
    try { readAllFromDom(); } catch (e) {}
    config.tabs.push({ name: 'Vidéo ' + (config.tabs.length + 1), type: 'video', src: '', poster: '', folderId: '', qualities: [], timecodes: [{ t: 0, label: 'Début' }] });
    renderTabs();
    setConfigDirty(true);
  });
  const addPhotoTabBtn = $('#addPhotoTabBtn');
  if (addPhotoTabBtn) {
    addPhotoTabBtn.addEventListener('click', createPhotoTab);
  }
  $('#photoCreateTabBtn').addEventListener('click', createPhotoTab);
  $('#tabSearch').addEventListener('input', scheduleTabFilter);
  $('#collapseTabsBtn').addEventListener('click', () => {
    $$('.tab-card:not([hidden])', tabsEditor).forEach((card) => {
      card.classList.add('collapsed');
      const button = $('[data-act="toggleTab"]', card);
      button.textContent = 'Développer';
      button.setAttribute('aria-expanded', 'false');
    });
  });
  $('#expandTabsBtn').addEventListener('click', () => {
    $$('.tab-card:not([hidden])', tabsEditor).forEach((card) => {
      card.classList.remove('collapsed');
      const button = $('[data-act="toggleTab"]', card);
      button.textContent = 'Réduire';
      button.setAttribute('aria-expanded', 'true');
    });
  });

  $('#addRootFolderBtn').addEventListener('click', () => createFolder(''));
  $('#folderTree').addEventListener('click', (e) => {
    const button = e.target.closest('button[data-parent-folder]');
    if (button) createFolder(button.dataset.parentFolder);
  });

  $('#saveBtn').addEventListener('click', saveConfig);
  $('#exportBtn').addEventListener('click', exportConfig);
  $('#importInput').addEventListener('change', importConfig);
  $('#pwBtn').addEventListener('click', changePassword);
  $('#backupBtn').addEventListener('click', downloadFullBackup);
  $('#refreshMonitorBtn').addEventListener('click', refreshMonitor);
  $('#addAthleteBtn').addEventListener('click', () => {
    let id;
    do {
      id = 'athlete-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    } while (athletes.some((athlete) => athlete.id === id));
    athletes.push({ id, name: '', category: '', bio: '', records: [], trainings: [], hasPassword: false });
    renderAthletes();
    const card = $(`[data-athlete-card][data-id="${id}"]`, $('#athleteEditor'));
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('[data-field="name"]', card).focus();
    }
  });
  $('#athleteEditor').addEventListener('click', async (event) => {
    const actionButton = event.target.closest('[data-athlete-action]');
    const card = event.target.closest('[data-athlete-card]');
    if (!card) return;
    if (actionButton) {
      const action = actionButton.dataset.athleteAction;
      if (action === 'save') return saveAthleteCard(card);
      if (action === 'add-record') {
        $('[data-entry-list="records"]', card).insertAdjacentHTML('beforeend', athleteRecordMarkup({ id: makeEntryId('record') }));
        return;
      }
      if (action === 'add-training') {
        $('[data-entry-list="trainings"]', card).insertAdjacentHTML('beforeend', athleteTrainingMarkup({ id: makeEntryId('training') }));
        return;
      }
      if (action === 'copy-link') {
        const value = $('input', $('.athlete-link', card)).value;
        try {
          await navigator.clipboard.writeText(value);
          toast('Lien privé copié.', 'ok');
        } catch (error) {
          prompt('Copiez le lien privé :', value);
        }
        return;
      }
      if (action === 'delete') {
        const athlete = athletes.find((entry) => entry.id === card.dataset.id);
        if (athlete && athlete.hasPassword) {
          if (!confirm('Supprimer définitivement la fiche de ' + athlete.name + ' ?')) return;
          try {
            await api('/api/athletes/' + encodeURIComponent(athlete.id), { method: 'DELETE' });
            recordAction('Fiche athlète supprimée : ' + athlete.name, 'warn');
          } catch (error) {
            toast('Impossible de supprimer la fiche : ' + error.message, 'err');
            return;
          }
        }
        athletes = athletes.filter((entry) => entry.id !== card.dataset.id);
        if (athlete) syncCalendarTarget(athlete, true);
        renderAthletes();
        return;
      }
    }
    const entryDelete = event.target.closest('[data-entry-action="delete"]');
    if (entryDelete) entryDelete.closest('[data-entry-id]').remove();
  });
  $$('.admin-section-tab').forEach((button) => button.addEventListener('click', () => showAdminSection(button.dataset.section)));
  $('#addEventBtn').addEventListener('click', () => {
    if (!Array.isArray(config.calendar)) config.calendar = [];
    config.calendar.push({ id: 'event-' + Date.now().toString(36), title: '', date: '', startTime: '', endTime: '', location: '', category: 'Entraînement', description: '', targetIds: [] });
    renderCalendarEditor();
    setConfigDirty(true);
    const input = $('#calendarEditor [data-field="title"]');
    if (input) input.focus();
  });
  $('#calendarEditor').addEventListener('click', (e) => {
    const button = e.target.closest('[data-event-action="delete"]');
    if (!button) return;
    const card = button.closest('[data-event-id]');
    config.calendar = config.calendar.filter((event) => event.id !== card.dataset.eventId);
    renderCalendarEditor();
    setConfigDirty(true);
  });
}

function createPhotoTab() {
  try { readAllFromDom(); } catch (error) {}
  const count = config.tabs.filter((tab) => tab.type === 'photo').length;
  const name = count ? 'Photos ' + (count + 1) : 'Photos';
  config.tabs.push({ name, type: 'photo', src: '', poster: '', folderId: '', qualities: [], timecodes: [], photos: [] });
  renderTabs();
  renderPhotoTargetOptions();
  const selector = $('#photoTarget');
  const newIndex = config.tabs.length - 1;
  if (selector) selector.value = String(newIndex);
  setConfigDirty(true);
  toast('Onglet « ' + name + ' » créé. Ajoutez-y des photos puis enregistrez.', 'ok');
}

/* ---------- save / export / import ---------- */

function readAllFromDom() {
  config.siteTitle = $('#cfgTitle').value.trim() || 'CPV Cyclones Sport';
  config.siteSubtitle = $('#cfgSubtitle').value.trim() || 'Étude Vidéo Viewer 2000';
  config.adminTitle = $('#cfgAdminTitle').value.trim() || 'Administration du viewer';
  config.logoPageTitle = $('#cfgLogoPageTitle').value.trim() || 'Logo — CPV Cyclones Viewer 2000';
  config.accentColor = $('#cfgAccentText').value.trim() || '#4d7ea6';
  config.hint = $('#cfgHint').value.trim();

  const calendar = [];
  let calendarHasError = false;
  $$('.calendar-event-editor', $('#calendarEditor')).forEach((card) => {
    const field = (name) => $(`[data-field="${name}"]`, card);
    const title = field('title').value.trim();
    const date = field('date').value;
    if (!title || !date) {
      calendarHasError = true;
      field(!title ? 'title' : 'date').classList.add('err');
    } else {
      field('title').classList.remove('err');
      field('date').classList.remove('err');
    }
    calendar.push({
      id: card.dataset.eventId,
      title,
      date,
      startTime: field('startTime').value,
      endTime: field('endTime').value,
      location: field('location').value.trim(),
      category: field('category').value,
      description: field('description').value.trim(),
      targetIds: $$('[data-field="targetIds"]:checked', card).map((input) => input.value)
    });
  });
  if (calendarHasError) {
    showAdminSection('calendar');
    toast('Chaque activité doit avoir un nom et une date.', 'err');
    return false;
  }
  config.calendar = calendar;

  const tabs = [];
  let hasError = false;
  $$('.tab-card', tabsEditor).forEach((card) => {
    let autoFound = false;
    const name = $('.name', card).value.trim() || 'Vidéo';
    const type = card.dataset.tabType === 'photo' ? 'photo' : 'video';
    const src = $('.srcPath', card)?.value.trim() || '';
    const poster = $('.poster', card)?.value.trim() || '';
    const folderId = $('.folderId', card).value;
    const timecodes = [];
    $$('.tc-table tbody tr', card).forEach((tr) => {
      if (tr.classList.contains('placeholder')) return;
      const label = $('.tc-label-input', tr).value.trim() || 'Timecode';
      const timeStr = $('.tc-time-input', tr).value.trim();
      const color = $('.tc-color-input', tr).value;
      const t = parseTime(timeStr);
      if (!Number.isFinite(t)) {
        hasError = true;
        $('.tc-time-input', tr).classList.add('err');
      } else {
        $('.tc-time-input', tr).classList.remove('err');
      }
      timecodes.push({ t: Number.isFinite(t) ? t : 0, label, color });
    });
    const qualities = [];
    $$('.q-row', card).forEach((row, qi) => {
      const qname = $('.q-name', row).value.trim() || 'Qualité ' + (qi + 1);
      const qsrc = $('.qPath', row).value.trim();
      if (!qsrc) return;
      let isAuto = $('.q-auto-cb', row)?.checked || false;
      if (isAuto && autoFound) isAuto = false;
      if (isAuto) autoFound = true;
      qualities.push({ name: qname, src: qsrc, auto: isAuto });
    });
    const photos = [];
    if (type === 'photo') {
      $$('.photo-row', card).forEach((row) => {
        const psrc = $('.photo-src', row).value.trim();
        if (!psrc) return;
        const alt = $('.photo-alt', row).value.trim();
        const caption = $('.photo-caption', row).value.trim();
        photos.push({ src: psrc, alt, caption });
      });
    }
    tabs.push({ name, type, src, poster, folderId, qualities, timecodes, photos });
  });
  config.tabs = tabs;
  return !hasError;
}

async function saveConfig() {
  if (!readAllFromDom()) {
    toast('Certains timecodes ont un temps invalide (champs en rouge).', 'err');
    return;
  }
  const btn = $('#saveBtn');
  btn.disabled = true;
  try {
    const res = await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    config = res.config;
    render();
    setConfigDirty(false);
    recordAction('Configuration enregistrée', 'ok');
    toast('Configuration enregistrée avec succès.', 'ok');
  } catch (e) {
    toast('Erreur d\'enregistrement : ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

function exportConfig() {
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'cpv-config.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function importConfig(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || typeof data !== 'object' || !Array.isArray(data.tabs)) throw new Error('Structure invalide');
      config = {
        siteTitle: data.siteTitle || 'CPV Cyclones Sport',
        siteSubtitle: data.siteSubtitle || 'Étude Vidéo Viewer 2000',
        adminTitle: data.adminTitle || 'Administration du viewer',
        logoPageTitle: data.logoPageTitle || 'Logo — CPV Cyclones Viewer 2000',
        accentColor: data.accentColor || '#4d7ea6',
        hint: data.hint || '',
        folders: Array.isArray(data.folders) ? data.folders : DEFAULT_FOLDERS.map((folder) => ({ ...folder, children: [] })),
        calendar: Array.isArray(data.calendar) ? data.calendar : (config.calendar || []),
        tabs: data.tabs
      };
      render();
      setConfigDirty(true);
      toast('Configuration importée. Pensez à l\'enregistrer.', 'ok');
    } catch (err) {
      toast('Fichier JSON invalide : ' + err.message, 'err');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

async function changePassword() {
  const cur = prompt('Mot de passe actuel :');
  if (cur === null) return;
  const n1 = prompt('Nouveau mot de passe (6 caractères min.) :');
  if (n1 === null) return;
  const n2 = prompt('Confirmez le nouveau mot de passe :');
  if (n1 !== n2) { toast('Les mots de passe ne correspondent pas.', 'err'); return; }
  if (n1.length < 6) { toast('Le mot de passe doit faire au moins 6 caractères.', 'err'); return; }
  try {
    await api('/api/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: cur, newPassword: n1 })
    });
    pass = n1;
    toast('Mot de passe modifié.', 'ok');
  } catch (err) {
    toast('Erreur : ' + err.message, 'err');
  }
}

/* ---------- boot ---------- */

bindVideoList();
init();