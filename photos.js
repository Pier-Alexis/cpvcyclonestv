'use strict';

const $ = (selector, root) => (root || document).querySelector(selector);

const grid = $('#photoGrid');
const folderGrid = $('#folderGrid');
const folderNav = $('#folderNav');
const status = $('#galleryStatus');
const count = $('#photoCount');
const search = $('#photoSearch');
const dialog = $('#photoDialog');
const dialogImage = $('#dialogImage');
const dialogName = $('#dialogName');
const downloadLink = $('#photoDownload');
let photos = [];
let folders = [];
let currentFolder = '';
let lastFocusedCard = null;

function photoUrl(name) {
  return '/photos/' + name.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function renderPhotos() {
  const query = search.value.trim().toLocaleLowerCase();
  const childFolders = folders.filter((folder) => {
    const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
    return parent === currentFolder;
  });
  const matches = photos.filter((photo) => {
    const parent = photo.name.includes('/') ? photo.name.slice(0, photo.name.lastIndexOf('/')) : '';
    const name = photo.name.slice(photo.name.lastIndexOf('/') + 1);
    return parent === currentFolder && name.toLocaleLowerCase().includes(query);
  });
  renderFolderNav();
  renderFolderCards(childFolders);
  grid.replaceChildren();
  count.textContent = `${matches.length} photo${matches.length === 1 ? '' : 's'}${query ? ' correspondante' + (matches.length === 1 ? '' : 's') : ''}`;

  if (!matches.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-gallery';
    empty.textContent = query
      ? 'Aucune photo ne correspond à votre recherche dans ce dossier.'
      : childFolders.length
        ? 'Aucune photo dans ce dossier. Ouvrez un sous-dossier pour parcourir ses images.'
        : 'Aucune photo publiée dans ce dossier pour le moment.';
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
    image.alt = photo.name.slice(photo.name.lastIndexOf('/') + 1);
    image.loading = 'lazy';
    const label = document.createElement('span');
    label.textContent = photo.name.slice(photo.name.lastIndexOf('/') + 1);
    card.append(image, label);
    card.addEventListener('click', () => openPhoto(photo, card));
    grid.appendChild(card);
  });
}

function renderFolderNav() {
  folderNav.replaceChildren();
  const parts = currentFolder ? currentFolder.split('/') : [];
  const root = document.createElement('button');
  root.type = 'button';
  root.className = 'folder-crumb';
  root.textContent = 'Toutes les photos';
  if (!currentFolder) root.setAttribute('aria-current', 'page');
  root.addEventListener('click', () => {
    currentFolder = '';
    renderPhotos();
  });
  folderNav.appendChild(root);
  let path = '';
  parts.forEach((part, index) => {
    const separator = document.createElement('span');
    separator.className = 'folder-separator';
    separator.textContent = '›';
    separator.setAttribute('aria-hidden', 'true');
    folderNav.appendChild(separator);
    path = path ? path + '/' + part : part;
    if (index === parts.length - 1) {
      const current = document.createElement('span');
      current.className = 'folder-crumb current';
      current.textContent = part;
      current.setAttribute('aria-current', 'page');
      folderNav.appendChild(current);
    } else {
      const ancestor = path;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'folder-crumb';
      button.textContent = part;
      button.addEventListener('click', () => {
        currentFolder = ancestor;
        renderPhotos();
      });
      folderNav.appendChild(button);
    }
  });
}

function renderFolderCards(childFolders) {
  folderGrid.replaceChildren();
  childFolders.forEach((folder) => {
    const name = folder.slice(folder.lastIndexOf('/') + 1);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'folder-card';
    const icon = document.createElement('span');
    icon.className = 'folder-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'Dossier';
    const label = document.createElement('strong');
    label.textContent = name;
    const total = photos.filter((photo) => photo.name.startsWith(folder + '/')).length;
    const detail = document.createElement('small');
    detail.textContent = `${total} photo${total === 1 ? '' : 's'}`;
    card.append(icon, label, detail);
    card.setAttribute('aria-label', `Ouvrir le dossier ${name}, ${detail.textContent}`);
    card.addEventListener('click', () => {
      currentFolder = folder;
      renderPhotos();
    });
    folderGrid.appendChild(card);
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
    folders = Array.isArray(data.folders) ? data.folders : [];
    renderPhotos();
  } catch (error) {
    status.textContent = 'Impossible de charger les photos. Réessayez plus tard.';
    status.classList.add('error');
    count.textContent = '';
    console.error('Impossible de charger les photos :', error);
  }
}

loadPhotos();
