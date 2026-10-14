'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const monthTitle = $('#monthTitle');
const content = $('#calendarContent');
const categoryFilter = $('#categoryFilter');
let events = [];
let currentMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let view = 'month';

function dateFromKey(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function dateKey(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function formatDate(key, options) {
  return new Intl.DateTimeFormat('fr-CA', options).format(dateFromKey(key));
}

function visibleEvents() {
  const category = categoryFilter.value;
  return events.filter((event) => {
    const eventDate = dateFromKey(event.date);
    return (category === 'Toutes' || event.category === category) && eventDate.getFullYear() === currentMonth.getFullYear() && eventDate.getMonth() === currentMonth.getMonth();
  });
}

function eventMarkup(event) {
  const time = [event.startTime, event.endTime].filter(Boolean).join(' – ');
  return `<article class="event-row"><div class="event-date"><strong>${esc(formatDate(event.date, { day: '2-digit' }))}</strong><span>${esc(formatDate(event.date, { weekday: 'short' }))}</span></div><div class="event-info"><span class="event-category">${esc(event.category)}</span><h3>${esc(event.title)}</h3>${event.description ? `<p>${esc(event.description)}</p>` : ''}<div class="event-meta">${time ? `<span>${esc(time)}</span>` : ''}${event.location ? `<span>${esc(event.location)}</span>` : ''}</div></div></article>`;
}

function render() {
  monthTitle.textContent = new Intl.DateTimeFormat('fr-CA', { month: 'long', year: 'numeric' }).format(currentMonth);
  const monthEvents = visibleEvents();
  if (view === 'list') {
    content.className = 'calendar-content list-view';
    content.innerHTML = monthEvents.length ? monthEvents.map(eventMarkup).join('') : '<p class="empty-state">Aucune activité pour ce mois.</p>';
    return;
  }
  content.className = 'calendar-content month-view';
  const offset = (new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1).getDay() + 6) % 7;
  const days = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0).getDate();
  const cells = [];
  for (let index = 0; index < offset; index += 1) cells.push('<div class="day-cell outside" aria-hidden="true"></div>');
  for (let day = 1; day <= days; day += 1) {
    const key = dateKey(new Date(currentMonth.getFullYear(), currentMonth.getMonth(), day));
    const todaysEvents = monthEvents.filter((event) => event.date === key);
    cells.push(`<div class="day-cell"><time datetime="${key}">${day}</time><div class="day-events">${todaysEvents.map((event) => `<div class="day-event" title="${esc(event.title)}"><span>${event.startTime ? esc(event.startTime) + ' ' : ''}${esc(event.title)}</span></div>`).join('')}</div></div>`);
  }
  const remainder = cells.length % 7;
  if (remainder) for (let index = remainder; index < 7; index += 1) cells.push('<div class="day-cell outside" aria-hidden="true"></div>');
  content.innerHTML = `<div class="month-grid"><div class="weekday-row">${['Lun.', 'Mar.', 'Mer.', 'Jeu.', 'Ven.', 'Sam.', 'Dim.'].map((day) => `<span>${day}</span>`).join('')}</div><div class="day-grid">${cells.join('')}</div></div>${monthEvents.length ? `<div class="month-agenda"><h2>Activités du mois</h2>${monthEvents.map(eventMarkup).join('')}</div>` : '<p class="empty-state">Aucune activité prévue pour ce mois.</p>'}`;
}

async function load() {
  content.innerHTML = '<p class="empty-state">Chargement du calendrier…</p>';
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const config = await response.json();
    events = Array.isArray(config.calendar) ? config.calendar : [];
    render();
  } catch (error) {
    content.innerHTML = '<p class="empty-state error-state">Le calendrier n’a pas pu être chargé. Actualisez la page pour réessayer.</p>';
  }
}

$('#previousMonth').addEventListener('click', () => { currentMonth.setMonth(currentMonth.getMonth() - 1); render(); });
$('#nextMonth').addEventListener('click', () => { currentMonth.setMonth(currentMonth.getMonth() + 1); render(); });
$('#todayButton').addEventListener('click', () => { currentMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1); render(); });
categoryFilter.addEventListener('change', render);
$$('.view-switch button').forEach((button) => button.addEventListener('click', () => {
  view = button.dataset.view;
  $$('.view-switch button').forEach((item) => {
    const selected = item === button;
    item.classList.toggle('selected', selected);
    item.setAttribute('aria-pressed', String(selected));
  });
  render();
}));
load();
