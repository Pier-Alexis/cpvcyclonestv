const initialMessages = [
  { id: 1, sender: "Sophie Martin", email: "sophie.martin@cpvcyclonestv.live", initials: "SM", avatar: "avatar-sage", subject: "Planning des entraînements — semaine 43", snippet: "Bonjour à tous, voici les horaires mis à jour pour la semaine prochaine…", date: "10:42", body: "Bonjour à tous,\n\nVoici les horaires mis à jour pour la semaine prochaine. Le créneau du mercredi passe à 18 h 30, toujours au gymnase municipal.\n\nMerci de me confirmer votre présence avant vendredi soir.\n\nÀ bientôt,\nSophie", tags: ["Club", "À lire"], unread: true, starred: false, folder: "inbox" },
  { id: 2, sender: "Thomas Bernard", email: "thomas.bernard@cpvcyclonestv.live", initials: "TB", avatar: "avatar-sky", subject: "Photos du tournoi régional", snippet: "J’ai ajouté les photos dans le dossier partagé. Il y en a quelques-unes…", date: "09:18", body: "Salut,\n\nJ’ai ajouté les photos du tournoi dans le dossier partagé. Il y en a quelques-unes vraiment réussies, notamment celles de la finale.\n\nTu peux les récupérer quand tu veux.\n\nThomas", tags: ["Club"], unread: true, starred: true, folder: "inbox" },
  { id: 3, sender: "Camille Durand", email: "camille.durand@exemple.fr", initials: "CD", avatar: "avatar-coral", subject: "Re: Réservation de la salle polyvalente", snippet: "C’est confirmé pour le samedi 25 octobre, de 14 h à 19 h…", date: "Hier", body: "Bonjour,\n\nC’est confirmé pour le samedi 25 octobre, de 14 h à 19 h. La salle sera ouverte à partir de 13 h 30 pour l’installation.\n\nBonne journée,\nCamille", tags: ["Événements"], unread: true, starred: false, folder: "inbox" },
  { id: 4, sender: "Léo Petit", email: "leo.petit@cpvcyclonestv.live", initials: "LP", avatar: "avatar-lilac", subject: "Compte rendu du bureau", snippet: "Vous trouverez ci-joint les points abordés pendant notre réunion…", date: "Hier", body: "Bonsoir,\n\nVous trouverez les points abordés pendant notre réunion : budget des équipements, dates des prochains matchs et organisation de la journée portes ouvertes.\n\nN’hésitez pas à compléter le document partagé.\n\nLéo", tags: ["Club"], unread: false, starred: false, folder: "inbox" },
  { id: 5, sender: "Nadia Moreau", email: "nadia.moreau@exemple.fr", initials: "NM", avatar: "avatar-gold", subject: "Affiche de la journée portes ouvertes", snippet: "Voici une première version de l’affiche. Dis-moi si tu souhaites…", date: "16 oct.", body: "Bonjour,\n\nVoici une première version de l’affiche pour la journée portes ouvertes. Dis-moi si tu souhaites modifier le texte ou les couleurs avant impression.\n\nBonne soirée,\nNadia", tags: ["Événements"], unread: false, starred: true, folder: "inbox" },
  { id: 6, sender: "Alexandre Roux", email: "alexandre.roux@cpvcyclonestv.live", initials: "AR", avatar: "avatar-sky", subject: "Reçus des nouvelles licences", snippet: "J’ai bien reçu les dossiers, merci ! Je reviens vers vous dès que…", date: "15 oct.", body: "Bonjour,\n\nJ’ai bien reçu les dossiers de licence, merci ! Je reviens vers vous dès que les inscriptions sont enregistrées.\n\nAlexandre", tags: ["À lire"], unread: false, starred: false, folder: "inbox" }
];

const storageKey = "cpvmail-preview-messages-v1";
let messages;
try {
  const saved = JSON.parse(localStorage.getItem(storageKey));
  messages = Array.isArray(saved) ? saved : initialMessages;
} catch {
  messages = initialMessages;
}

let activeFolder = "inbox";
let activeFilter = "all";
let searchQuery = "";
let selectedId = null;
let selectedIds = new Set();
let toastTimer;

const list = document.querySelector("#message-list");
const detail = document.querySelector("#message-detail");
const readingEmpty = document.querySelector("#reading-empty");
const readingColumn = document.querySelector("#reading-column");
const dialog = document.querySelector("#compose-dialog");

function saveMessages() {
  localStorage.setItem(storageKey, JSON.stringify(messages));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function currentFolderMessages() {
  let result = messages.filter((message) => {
    if (activeFolder === "starred") return message.starred && message.folder !== "trash";
    return message.folder === activeFolder;
  });
  if (activeFilter === "unread") result = result.filter((message) => message.unread);
  if (searchQuery) {
    const query = searchQuery.toLocaleLowerCase("fr");
    result = result.filter((message) => `${message.sender} ${message.email} ${message.subject} ${message.snippet} ${message.body} ${message.tags.join(" ")}`.toLocaleLowerCase("fr").includes(query));
  }
  return result;
}

function tagClass(tag) {
  if (tag === "Événements") return "tag-orange";
  if (tag === "À lire") return "tag-blue";
  return "";
}

function updateUnreadCount() {
  const unread = messages.filter((message) => message.folder === "inbox" && message.unread).length;
  document.querySelector("#unread-count").textContent = unread;
  document.querySelector("#unread-count").classList.toggle("hidden", unread === 0);
}

function renderList() {
  const visibleMessages = currentFolderMessages();
  document.querySelector("#result-count").textContent = visibleMessages.length ? `${visibleMessages.length} courriel${visibleMessages.length > 1 ? "s" : ""}` : "";
  document.querySelector("#empty-state").classList.toggle("hidden", visibleMessages.length > 0);
  list.classList.toggle("hidden", visibleMessages.length === 0);
  list.innerHTML = visibleMessages.map((message, index) => `
    <article class="message-row ${message.unread ? "unread" : ""} ${selectedId === message.id ? "selected" : ""}" role="listitem" tabindex="0" data-id="${message.id}" style="animation-delay:${index * 35}ms">
      <button class="row-check ${selectedIds.has(message.id) ? "checked" : ""}" data-action="select" aria-label="Sélectionner ${escapeHtml(message.subject)}"><i data-lucide="${selectedIds.has(message.id) ? "check-square" : "square"}"></i></button>
      <span class="avatar sender-avatar ${message.avatar}">${escapeHtml(message.initials)}</span>
      <span class="message-copy"><span class="message-topline"><strong class="sender-name">${escapeHtml(message.sender)}</strong><time class="message-time">${escapeHtml(message.date)}</time></span><span class="message-subject">${escapeHtml(message.subject)}</span><span class="message-snippet">${escapeHtml(message.snippet)}</span><span>${message.tags.map((tag) => `<span class="message-tag ${tagClass(tag)}">${escapeHtml(tag)}</span>`).join("")}</span></span>
      <button class="row-star ${message.starred ? "starred" : ""}" data-action="star" aria-label="${message.starred ? "Retirer des suivis" : "Ajouter aux suivis"}"><i data-lucide="star"></i></button>
    </article>`).join("");
  if (window.lucide) lucide.createIcons();
  updateUnreadCount();
}

function renderDetail() {
  const message = messages.find((item) => item.id === selectedId);
  if (!message) {
    detail.classList.add("hidden");
    readingEmpty.classList.remove("hidden");
    readingColumn.classList.remove("mobile-reading-open");
    return;
  }
  readingEmpty.classList.add("hidden");
  detail.classList.remove("hidden");
  readingColumn.classList.add("mobile-reading-open");
  detail.innerHTML = `
    <div class="detail-actions">
      <button class="icon-button" data-detail-action="back" aria-label="Retour à la liste" title="Retour"><i data-lucide="arrow-left"></i></button>
      <span class="action-spacer"></span>
      <button class="icon-button" data-detail-action="unread" aria-label="${message.unread ? "Marquer comme lu" : "Marquer comme non lu"}" title="${message.unread ? "Marquer comme lu" : "Marquer comme non lu"}"><i data-lucide="mail-${message.unread ? "open" : "check"}"></i></button>
      <button class="icon-button" data-detail-action="archive" aria-label="Archiver" title="Archiver"><i data-lucide="archive"></i></button>
      <button class="icon-button" data-detail-action="trash" aria-label="Supprimer" title="Supprimer"><i data-lucide="trash-2"></i></button>
      <button class="icon-button" data-detail-action="star" aria-label="${message.starred ? "Retirer des suivis" : "Ajouter aux suivis"}" title="Suivi"><i data-lucide="star"></i></button>
    </div>
    <h2 class="detail-subject">${escapeHtml(message.subject)}</h2>
    <div class="detail-tags">${message.tags.map((tag) => `<span class="message-tag ${tagClass(tag)}">${escapeHtml(tag)}</span>`).join("")}</div>
    <div class="detail-sender"><span class="avatar sender-avatar ${message.avatar}">${escapeHtml(message.initials)}</span><span class="detail-sender-copy"><strong>${escapeHtml(message.sender)}</strong><span>à moi · ${escapeHtml(message.email)}</span></span><time class="detail-date">${escapeHtml(message.date)}</time></div>
    <div class="detail-body">${escapeHtml(message.body)}</div>
    <button class="reply-button" data-detail-action="reply"><i data-lucide="reply"></i>Répondre</button>`;
  if (window.lucide) lucide.createIcons();
}

const folderNames = { inbox: "Boîte de réception", starred: "Suivis", sent: "Envoyés", drafts: "Brouillons", archive: "Archives", trash: "Corbeille" };

function render() {
  document.querySelector("#folder-title").textContent = folderNames[activeFolder];
  document.querySelector("#breadcrumb-folder").textContent = folderNames[activeFolder];
  renderList();
  renderDetail();
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3400);
}

document.querySelector("#folder-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-folder]");
  if (!button) return;
  activeFolder = button.dataset.folder;
  selectedId = null;
  document.querySelectorAll(".folder-link").forEach((item) => item.classList.toggle("active", item === button));
  render();
  document.querySelector(".sidebar").classList.remove("mobile-open");
  document.querySelector("#mobile-backdrop").classList.add("hidden");
});

document.querySelector("#folder-list").addEventListener("click", (event) => {
  if (event.target.closest("[data-folder]")) return;
});

document.querySelector("#message-list").addEventListener("click", (event) => {
  const row = event.target.closest(".message-row");
  if (!row) return;
  const message = messages.find((item) => item.id === Number(row.dataset.id));
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "star") {
    message.starred = !message.starred;
    saveMessages();
    render();
    return;
  }
  if (action === "select") {
    selectedIds.has(message.id) ? selectedIds.delete(message.id) : selectedIds.add(message.id);
    renderList();
    return;
  }
  selectedId = message.id;
  message.unread = false;
  saveMessages();
  render();
});

list.addEventListener("keydown", (event) => {
  const row = event.target.closest(".message-row");
  if (row && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    row.click();
  }
});

detail.addEventListener("click", (event) => {
  const button = event.target.closest("[data-detail-action]");
  if (!button) return;
  const action = button.dataset.detailAction;
  const message = messages.find((item) => item.id === selectedId);
  if (!message) return;
  if (action === "back") {
    readingColumn.classList.remove("mobile-reading-open");
    return;
  }
  if (action === "reply") {
    dialog.querySelector("[name=to]").value = message.email;
    dialog.querySelector("[name=subject]").value = `Re: ${message.subject}`;
    dialog.querySelector("[name=body]").value = "\n\n\n--- Message original ---\n";
    dialog.showModal();
    return;
  }
  if (action === "unread") message.unread = !message.unread;
  if (action === "star") message.starred = !message.starred;
  if (action === "archive" || action === "trash") {
    message.folder = action;
    selectedId = null;
    showToast(action === "archive" ? "Message déplacé dans les archives." : "Message déplacé dans la corbeille.");
  }
  saveMessages();
  render();
});

document.querySelector("#search-input").addEventListener("input", (event) => {
  searchQuery = event.target.value.trim();
  renderList();
});

document.querySelectorAll(".filter-button").forEach((button) => button.addEventListener("click", () => {
  activeFilter = button.dataset.filter;
  document.querySelectorAll(".filter-button").forEach((item) => item.classList.toggle("selected", item === button));
  renderList();
}));

document.querySelectorAll(".label-link").forEach((button) => button.addEventListener("click", () => {
  activeFolder = "inbox";
  document.querySelectorAll(".folder-link").forEach((item) => item.classList.toggle("active", item.dataset.folder === "inbox"));
  document.querySelector("#search-input").value = button.dataset.label;
  searchQuery = button.dataset.label;
  render();
}));

document.querySelector("#select-all").addEventListener("click", (event) => {
  const visible = currentFolderMessages();
  const allSelected = visible.length > 0 && visible.every((message) => selectedIds.has(message.id));
  visible.forEach((message) => allSelected ? selectedIds.delete(message.id) : selectedIds.add(message.id));
  event.currentTarget.innerHTML = `<i data-lucide="${allSelected ? "square" : "check-square"}"></i>`;
  if (window.lucide) lucide.createIcons();
  renderList();
});

document.querySelector("#refresh-button").addEventListener("click", () => showToast("Aucun serveur de messagerie n’est encore connecté."));
document.querySelector("#compose-open").addEventListener("click", () => dialog.showModal());
document.querySelector("#mobile-compose").addEventListener("click", () => dialog.showModal());
document.querySelector("#compose-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});

document.querySelector("#compose-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const draft = {
    id: Date.now(), sender: "CPV Cyclones", email: "contact@cpvcyclonestv.live", initials: "C", avatar: "avatar-user",
    subject: String(form.get("subject")), snippet: `À ${form.get("to")} · ${String(form.get("body")).slice(0, 76)}`,
    date: "À l’instant", body: String(form.get("body")), tags: [], unread: false, starred: false, folder: "drafts"
  };
  messages.unshift(draft);
  saveMessages();
  event.currentTarget.reset();
  dialog.close();
  activeFolder = "drafts";
  document.querySelectorAll(".folder-link").forEach((item) => item.classList.toggle("active", item.dataset.folder === "drafts"));
  selectedId = draft.id;
  render();
  showToast("Brouillon enregistré sur cet appareil. Aucun courriel n’a été envoyé.");
});

document.querySelector(".brand").addEventListener("click", () => {
  activeFolder = "inbox";
  selectedId = null;
  document.querySelectorAll(".folder-link").forEach((item) => item.classList.toggle("active", item.dataset.folder === "inbox"));
  render();
});

document.querySelector(".account-button").addEventListener("click", () => {
  document.querySelector(".sidebar").classList.add("mobile-open");
  document.querySelector("#mobile-backdrop").classList.remove("hidden");
});
document.querySelector("#mobile-nav-open").addEventListener("click", () => {
  document.querySelector(".sidebar").classList.add("mobile-open");
  document.querySelector("#mobile-backdrop").classList.remove("hidden");
});
document.querySelector("#mobile-backdrop").addEventListener("click", () => {
  document.querySelector(".sidebar").classList.remove("mobile-open");
  document.querySelector("#mobile-backdrop").classList.add("hidden");
});
document.querySelector(".help-button").addEventListener("click", () => showToast("Aperçu local : la connexion au serveur sera configurée ensuite."));
document.querySelector(".settings-button").addEventListener("click", () => showToast("Les paramètres seront disponibles après la configuration du serveur."));

document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    document.querySelector("#search-input").focus();
  }
  if ((event.key === "c" || event.key === "C") && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName) && !dialog.open) dialog.showModal();
  if (event.key === "Escape" && readingColumn.classList.contains("mobile-reading-open")) readingColumn.classList.remove("mobile-reading-open");
});

if (window.lucide) lucide.createIcons();
render();