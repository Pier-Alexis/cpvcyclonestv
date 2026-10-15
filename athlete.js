'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
let athleteId = new URLSearchParams(location.search).get('id') || '';
const loginPanel = $('#loginPanel');
const athletePanel = $('#athletePanel');
const pageError = $('#pageError');

function formatDate(value) {
  if (!value) return '';
  const parts = value.split('-').map(Number);
  if (parts.length !== 3 || parts.some((part) => !part)) return '';
  return new Intl.DateTimeFormat('fr-CA', { dateStyle: 'long' }).format(new Date(parts[0], parts[1] - 1, parts[2]));
}

function renderRecords(records) {
  const list = $('#records');
  if (!records.length) {
    list.innerHTML = '<p class="empty-state">Aucun temps personnel enregistré.</p>';
    return;
  }
  list.innerHTML = records.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).map((record) => `
    <article class="entry">
      <div class="entry-top"><span class="entry-title">${esc(record.distance || 'Record personnel')}</span><span class="entry-result">${esc(record.time || '')}</span></div>
      <div class="entry-meta">${[formatDate(record.date), record.competition].filter(Boolean).map(esc).join(' · ')}</div>
      ${record.notes ? `<p class="entry-notes">${esc(record.notes)}</p>` : ''}
    </article>`).join('');
}

function renderTrainings(trainings) {
  const list = $('#trainings');
  if (!trainings.length) {
    list.innerHTML = '<p class="empty-state">Aucun entraînement enregistré.</p>';
    return;
  }
  list.innerHTML = trainings.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).map((training) => `
    <article class="entry">
      <div class="entry-top"><span class="entry-title">${esc(training.type || 'Entraînement')}</span><span class="entry-date">${esc(formatDate(training.date))}</span></div>
      <div class="entry-meta">${[training.duration ? `${training.duration} min` : '', training.location].filter(Boolean).map(esc).join(' · ')}</div>
      ${training.notes ? `<p class="entry-notes">${esc(training.notes)}</p>` : ''}
    </article>`).join('');
}

function renderAthleteCalendar(events) {
  const list = $('#athleteCalendar');
  if (!events.length) {
    list.innerHTML = '<p class="empty-state">Aucune activité prévue.</p>';
    return;
  }
  list.innerHTML = events.slice().sort((a, b) => (a.date + (a.startTime || '')).localeCompare(b.date + (b.startTime || ''))).map((event) => `
    <article class="entry">
      <div class="entry-top"><span class="entry-title">${esc(event.title || 'Activité')}</span><span class="entry-date">${esc(formatDate(event.date))}</span></div>
      <div class="entry-meta">${[event.category, [event.startTime, event.endTime].filter(Boolean).join(' – '), event.location].filter(Boolean).map(esc).join(' · ')}</div>
      ${event.description ? `<p class="entry-notes">${esc(event.description)}</p>` : ''}
    </article>`).join('');
}

let otherCalendars = [];

async function loadAthleteCalendar() {
  const list = $('#athleteCalendar');
  list.innerHTML = '<p class="empty-state">Chargement du calendrier…</p>';
  try {
    const response = await fetch('/api/athlete/calendar', { cache: 'no-store', credentials: 'same-origin' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Calendrier indisponible');
    renderAthleteCalendar(data.events || []);
    otherCalendars = data.otherCalendars || [];
    $('#otherCalendarSelect').innerHTML = '<option value="">Choisir un athlète</option>' + otherCalendars.map((other) => `<option value="${esc(other.id)}">${esc(other.name)}</option>`).join('');
  } catch (error) {
    list.innerHTML = `<p class="empty-state">${esc(error.message || 'Impossible de charger le calendrier.')}</p>`;
  }
}

function showAthlete(athlete) {
  if (athleteId && athlete.id !== athleteId) {
    pageError.textContent = 'La session ouverte ne correspond pas à cette fiche. Déconnectez-vous puis reconnectez-vous avec le bon lien.';
    pageError.hidden = false;
    return;
  }
  athleteId = athlete.id;
  $('#athleteName').textContent = athlete.name;
  $('#athleteMeta').textContent = athlete.category || '';
  $('#athleteBio').textContent = athlete.bio || '';
  $('#athleteBio').hidden = !athlete.bio;
  renderRecords(Array.isArray(athlete.records) ? athlete.records : []);
  renderTrainings(Array.isArray(athlete.trainings) ? athlete.trainings : []);
  loadAthleteCalendar();
  loginPanel.hidden = true;
  athletePanel.hidden = false;
  $('#logoutBtn').hidden = false;
  document.title = athlete.name + ' — CyclonesTV';
}

async function loadSession() {
  if (!/^[a-z0-9_-]{1,64}$/.test(athleteId)) {
    athleteId = '';
  }
  try {
    const response = await fetch('/api/athlete/me', { cache: 'no-store', credentials: 'same-origin' });
    if (response.ok) showAthlete((await response.json()).athlete);
  } catch (error) {
    pageError.textContent = 'Impossible de joindre le serveur. Vérifiez votre connexion puis réessayez.';
    pageError.hidden = false;
  }
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('#loginError');
  error.hidden = true;
  try {
    const credentials = { password: $('#passwordInput').value };
    if (athleteId) credentials.id = athleteId;
    const response = await fetch('/api/athlete/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(credentials)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Connexion impossible');
    showAthlete(data.athlete);
  } catch (cause) {
    error.textContent = cause.message || 'Connexion impossible.';
    error.hidden = false;
  }
});

$$('[data-calendar-mode]').forEach((button) => button.addEventListener('click', () => {
  const showingOthers = button.dataset.calendarMode === 'others';
  $$('[data-calendar-mode]').forEach((item) => {
    const active = item === button;
    item.classList.toggle('active', active);
    item.setAttribute('aria-pressed', String(active));
  });
  $('#otherCalendarLabel').hidden = !showingOthers;
  if (!showingOthers) loadAthleteCalendar();
  else {
    const selected = otherCalendars.find((other) => other.id === $('#otherCalendarSelect').value);
    if (selected) renderAthleteCalendar(selected.events);
    else $('#athleteCalendar').innerHTML = '<p class="empty-state">Choisissez un athlète pour afficher son calendrier.</p>';
  }
}));

$('#otherCalendarSelect').addEventListener('change', () => {
  const selected = otherCalendars.find((other) => other.id === $('#otherCalendarSelect').value);
  if (selected) renderAthleteCalendar(selected.events);
  else $('#athleteCalendar').innerHTML = '<p class="empty-state">Choisissez un athlète pour afficher son calendrier.</p>';
});

$('#logoutBtn').addEventListener('click', async () => {
  try {
    await fetch('/api/athlete/logout', { method: 'POST', credentials: 'same-origin' });
    location.reload();
  } catch (error) {
    pageError.textContent = 'Impossible de fermer la session : ' + error.message;
    pageError.hidden = false;
  }
});

loadSession();
