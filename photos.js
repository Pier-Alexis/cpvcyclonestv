'use strict';

const $ = (selector, root) => (root || document).querySelector(selector);

const grid = $('#photoGrid');
const status = $('#galleryStatus');
const count = $('#photoCount');
const search = $('#photoSearch');
const dialog = $('#photoDialog');
const dialogImage = $('#dialogImage');
const dialogName = $('#dialogName');
const downloadLink = $('#photoDownload');
let photos = [];
let lastFocusedCard = null;

function photoUrl(name) {
  return '/photos/' + name.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function renderPhotos() {
  const query = search.value.trim().toLocaleLowerCase();
  const matches = photos.filter((photo) => photo.name.toLocaleLowerCase().includes(query));
  grid.replaceChildren();
  count.textContent = `${matches.length} photo${matches.length === 1 ? '' : 's'}${query ? ' correspondante' + (matches.length === 1 ? '' : 's') : ''}`;

  if (!matches.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-gallery';
    empty.textContent = photos.length ? 'Aucune photo ne correspond à votre recherche.' : 'Aucune photo publiée pour le moment.';
    grid.appendChild(empty);
    status.textContent = '';
    return;
  }
  status.textContent = '';

  matches.forEach((photo) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'photo-card';
    card.setAttribute('aria-label', 'Agrandir la photo ' + photo.name);
    const image = document.createElement('img');
    image.src = photoUrl(photo.name);
    image.alt = photo.name;
    image.loading = 'lazy';
    const label = document.createElement('span');
    label.textContent = photo.name;
    card.append(image, label);
    card.addEventListener('click', () => openPhoto(photo, card));
    grid.appendChild(card);
  });
}

function openPhoto(photo, card) {
  lastFocusedCard = card;
  const url = photoUrl(photo.name);
  dialogImage.src = url;
  dialogImage.alt = photo.name;
  dialogName.textContent = photo.name;
  downloadLink.href = url;
  downloadLink.download = photo.name.split('/').pop();
  dialog.showModal();
  $('#dialogClose').focus();
}

$('#dialogClose').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});
dialog.addEventListener('close', () => {
  dialogImage.removeAttribute('src');
  if (lastFocusedCard && lastFocusedCard.isConnected) lastFocusedCard.focus();
});
search.addEventListener('input', renderPhotos);

async function loadPhotos() {
  try {
    const response = await fetch('/api/photos', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status);
    photos = Array.isArray(data.photos) ? data.photos : [];
    renderPhotos();
  } catch (error) {
    status.textContent = 'Impossible de charger les photos. Réessayez plus tard.';
    status.classList.add('error');
    count.textContent = '';
    console.error('Impossible de charger les photos :', error);
  }
}

loadPhotos();
