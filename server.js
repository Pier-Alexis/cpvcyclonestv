'use strict';

const http2 = require('http2');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8080;
const BEHIND_CADDY = process.env.BEHIND_CADDY === '1';
const CONFIG_FILE = path.join(ROOT, 'config.json');
const AUTH_FILE = path.join(ROOT, 'auth.json');
const ATHLETES_FILE = path.join(ROOT, 'athletes.json');
const VIDEOS_DIR = path.join(ROOT, 'videos');
const YOUTUBE_DIR = path.join(VIDEOS_DIR, 'youtube');
const PHOTOS_DIR = path.join(ROOT, 'photos');
const TLS_DIR = path.join(ROOT, 'tls');
const TLS_KEY = path.join(TLS_DIR, 'key.pem');
const TLS_CERT = path.join(TLS_DIR, 'cert.pem');
const ADMIN_COOKIE = 'cpv_admin_session';
const ADMIN_SESSION_TTL = 30 * 24 * 60 * 60;
const ATHLETE_COOKIE = 'cpv_athlete_session';
const ATHLETE_SESSION_TTL = 14 * 24 * 60 * 60;
const athleteLoginAttempts = new Map();

const MAX_UPLOAD = 6 * 1024 * 1024 * 1024;
const MAX_JSON = 2 * 1024 * 1024;
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm', '.ogv', '.ogg', '.mov', '.mkv', '.avi']);
const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });
if (!fs.existsSync(YOUTUBE_DIR)) fs.mkdirSync(YOUTUBE_DIR, { recursive: true });
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
if (!fs.existsSync(CONFIG_FILE)) writeJSON(CONFIG_FILE, defaultConfig());
if (!fs.existsSync(AUTH_FILE)) writeJSON(AUTH_FILE, { password: 'cpvCyclones2026S-E' });
if (!fs.existsSync(ATHLETES_FILE)) writeJSON(ATHLETES_FILE, []);

function defaultConfig() {
  return {
    siteTitle: 'CPV Cyclones Sport',
    siteSubtitle: 'Étude Vidéo Viewer 2000',
    adminTitle: 'Administration du viewer',
    logoPageTitle: 'Logo — CPV Cyclones Viewer 2000',
    accentColor: '#4d7ea6',
    hint: 'Cliquez sur la vidéo pour afficher les timecodes',
    folders: defaultFolders(),
    calendar: [],
    tabs: []
  };
}

function defaultFolders() {
  return [
    { id: 'courte-piste', name: 'Courte Piste', children: [] },
    { id: 'longue-piste', name: 'Longue Piste', children: [] },
    { id: 'entrainement', name: 'Entraînement', children: [] }
  ];
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJSON(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function auth() {
  const a = readJSON(AUTH_FILE, null);
  return a && typeof a.password === 'string' ? a.password : 'cpvCyclones2026S-E';
}

function hasAccess(req) {
  const p = req.headers['x-admin-pass'];
  if (typeof p === 'string' && p.length > 0 && p === auth()) return true;
  return hasValidAdminCookie(req);
}

function adminCookieOptions(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const secure = Boolean(req.socket.encrypted) || forwardedProto === 'https';
  return `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64 + '='.repeat((4 - base64.length % 4) % 4), 'base64');
}

function createAdminToken(password, expiresAt) {
  const payload = base64UrlEncode(JSON.stringify({ expiresAt, nonce: crypto.randomBytes(16).toString('hex') }));
  const signature = base64UrlEncode(crypto.createHmac('sha256', password).update(payload).digest());
  return payload + '.' + signature;
}

function hasValidAdminCookie(req) {
  const cookieHeader = req.headers.cookie || '';
  const cookie = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(ADMIN_COOKIE + '='));
  if (!cookie) return false;

  const token = cookie.slice(ADMIN_COOKIE.length + 1);
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;

  const expected = crypto.createHmac('sha256', auth()).update(payload).digest();
  let actual;
  try {
    actual = base64UrlDecode(signature);
  } catch (e) {
    return false;
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;

  try {
    const session = JSON.parse(base64UrlDecode(payload).toString('utf8'));
    return Number.isSafeInteger(session.expiresAt) && session.expiresAt > Math.floor(Date.now() / 1000);
  } catch (e) {
    return false;
  }
}

function setAdminCookie(res, req, password) {
  const expiresAt = Math.floor(Date.now() / 1000) + ADMIN_SESSION_TTL;
  const token = createAdminToken(password, expiresAt);
  res.setHeader('set-cookie', `${ADMIN_COOKIE}=${token}; Max-Age=${ADMIN_SESSION_TTL}; ${adminCookieOptions(req)}`);
}

function clearAdminCookie(res, req) {
  res.setHeader('set-cookie', `${ADMIN_COOKIE}=; Max-Age=0; ${adminCookieOptions(req)}`);
}

function readAthletes() {
  const athletes = readJSON(ATHLETES_FILE, []);
  return Array.isArray(athletes) ? athletes : [];
}

function createDataBackup() {
  const directory = path.join(ROOT, 'backups');
  fs.mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeJSON(path.join(directory, `backup-${stamp}.json`), {
    createdAt: new Date().toISOString(),
    config: readJSON(CONFIG_FILE, defaultConfig()),
    athletes: readAthletes()
  });
  const backups = fs.readdirSync(directory)
    .filter((name) => /^backup-.*\.json$/.test(name))
    .sort()
    .reverse();
  backups.slice(20).forEach((name) => fs.unlinkSync(path.join(directory, name)));
}

function athletePublicData(athlete) {
  return {
    id: athlete.id,
    name: athlete.name,
    category: athlete.category,
    bio: athlete.bio,
    records: athlete.records,
    trainings: athlete.trainings,
    hasPassword: Boolean(athlete.passwordSalt && athlete.passwordHash)
  };
}

function athleteSessionToken(athlete, expiresAt) {
  const payload = base64UrlEncode(JSON.stringify({
    id: athlete.id,
    expiresAt,
    nonce: crypto.randomBytes(16).toString('hex')
  }));
  const signature = base64UrlEncode(crypto.createHmac('sha256', athlete.passwordHash).update(payload).digest());
  return payload + '.' + signature;
}

function findAthleteSession(req) {
  const cookieHeader = req.headers.cookie || '';
  const cookie = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(ATHLETE_COOKIE + '='));
  if (!cookie) return null;
  const [payload, signature] = cookie.slice(ATHLETE_COOKIE.length + 1).split('.');
  if (!payload || !signature) return null;
  try {
    const session = JSON.parse(base64UrlDecode(payload).toString('utf8'));
    if (typeof session.id !== 'string' || !Number.isSafeInteger(session.expiresAt) || session.expiresAt <= Math.floor(Date.now() / 1000)) return null;
    const athlete = readAthletes().find((item) => item.id === session.id);
    if (!athlete || !athlete.passwordHash) return null;
    const expected = crypto.createHmac('sha256', athlete.passwordHash).update(payload).digest();
    const actual = base64UrlDecode(signature);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected) ? athlete : null;
  } catch (e) {
    return null;
  }
}

function setAthleteCookie(res, req, athlete) {
  const expiresAt = Math.floor(Date.now() / 1000) + ATHLETE_SESSION_TTL;
  const token = athleteSessionToken(athlete, expiresAt);
  res.setHeader('set-cookie', `${ATHLETE_COOKIE}=${token}; Max-Age=${ATHLETE_SESSION_TTL}; ${adminCookieOptions(req)}`);
}

function clearAthleteCookie(res, req) {
  res.setHeader('set-cookie', `${ATHLETE_COOKIE}=; Max-Age=0; ${adminCookieOptions(req)}`);
}

function clientAddress(req) {
  if (BEHIND_CADDY) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const date = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : '';
}

function sanitizeAthlete(raw, index) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const id = typeof raw.id === 'string' && /^[a-z0-9_-]{1,64}$/.test(raw.id) ? raw.id : '';
  if (!id) throw new Error('Identifiant d’athlète invalide');
  const name = str(raw.name, '', 100);
  if (!name) throw new Error('Le nom de chaque athlète est obligatoire');
  const records = (Array.isArray(raw.records) ? raw.records : []).slice(0, 300).map((record, i) => {
    record = record && typeof record === 'object' ? record : {};
    return {
      id: typeof record.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(record.id) ? record.id : `record-${index}-${i}`,
      distance: str(record.distance, '', 60),
      time: str(record.time, '', 40),
      date: validDate(record.date),
      competition: str(record.competition, '', 120),
      notes: str(record.notes, '', 500)
    };
  }).filter((record) => record.distance || record.time || record.date || record.competition || record.notes);
  const trainings = (Array.isArray(raw.trainings) ? raw.trainings : []).slice(0, 500).map((training, i) => {
    training = training && typeof training === 'object' ? training : {};
    return {
      id: typeof training.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(training.id) ? training.id : `training-${index}-${i}`,
      date: validDate(training.date),
      type: str(training.type, '', 100),
      duration: num(training.duration, 0),
      location: str(training.location, '', 120),
      notes: str(training.notes, '', 1200)
    };
  }).filter((training) => training.date || training.type || training.duration || training.location || training.notes);
  return {
    id,
    name,
    category: str(raw.category, '', 80),
    bio: typeof raw.bio === 'string' ? raw.bio.slice(0, 2000).trim() : '',
    records,
    trainings
  };
}

function passwordDigest(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key.toString('hex'));
    });
  });
}

function setAthletePassword(athlete, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return passwordDigest(password, salt).then((passwordHash) => Object.assign(athlete, { passwordSalt: salt, passwordHash }));
}

function athleteLoginAllowed(req) {
  const now = Date.now();
  const key = clientAddress(req);
  const attempt = athleteLoginAttempts.get(key);
  if (attempt && attempt.blockedUntil > now) return false;
  if (athleteLoginAttempts.size > 5000) {
    for (const [entry, value] of athleteLoginAttempts) {
      if (value.blockedUntil <= now && now - value.lastAttempt > 15 * 60 * 1000) athleteLoginAttempts.delete(entry);
    }
  }
  return true;
}

function recordAthleteLoginFailure(req) {
  const key = clientAddress(req);
  const now = Date.now();
  const attempt = athleteLoginAttempts.get(key);
  const failures = attempt && now - attempt.lastAttempt < 15 * 60 * 1000 ? attempt.failures + 1 : 1;
  athleteLoginAttempts.set(key, {
    failures,
    lastAttempt: now,
    blockedUntil: failures >= 8 ? now + 15 * 60 * 1000 : 0
  });
}

function findOpenssl() {
  const candidates = [
    'openssl',
    path.join('C:', 'Program Files', 'Git', 'usr', 'bin', 'openssl.exe'),
    path.join('C:', 'Program Files', 'OpenSSL-Win64', 'bin', 'openssl.exe'),
    path.join('C:', 'Program Files (x86)', 'Git', 'usr', 'bin', 'openssl.exe')
  ];
  for (const c of candidates) {
    try {
      execFileSync(c, ['version'], { stdio: 'ignore' });
      return c;
    } catch (e) { /* suivant */ }
  }
  return null;
}

function lanIPv4() {
  let ip = '127.0.0.1';
  try {
    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces)) {
      for (const iface of list) {
        if (iface.family === 'IPv4' && !iface.internal) {
          ip = iface.address;
          break;
        }
      }
      if (ip !== '127.0.0.1') break;
    }
  } catch (e) { /* silencieux */ }
  return ip;
}

function ensureTls() {
  if (fs.existsSync(TLS_KEY) && fs.existsSync(TLS_CERT)) return true;
  fs.mkdirSync(TLS_DIR, { recursive: true });
  const exe = findOpenssl();
  if (!exe) {
    console.error('[TLS] OpenSSL introuvable. Installez OpenSSL puis relancez, ou placez vous-même un certificat dans tls/key.pem et tls/cert.pem.');
    return false;
  }
  try {
    const san = 'DNS:localhost,IP:127.0.0.1,IP:' + lanIPv4();
    execFileSync(exe, [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', TLS_KEY, '-out', TLS_CERT, '-days', '3650',
      '-subj', '/CN=localhost',
      '-addext', `subjectAltName=${san}`
    ], { stdio: 'ignore' });
    console.log('[TLS] Certificat auto-signé généré dans ' + TLS_DIR);
    return true;
  } catch (e) {
    console.error('[TLS] Impossible de générer le certificat :', e.message);
    return false;
  }
}

function str(v, fallback, max) {
  if (typeof v !== 'string') return fallback;
  const s = v.slice(0, max || 300).trim();
  return s || fallback;
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function color(v, fallback) {
  if (typeof v === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim())) return v.trim();
  if (typeof v === 'string' && /^(rgb|hsl)a?\([\d\s,.%]+\)$/.test(v.trim())) return v.trim();
  return fallback;
}

function sanitizeTab(raw, i, folderIds) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const tcs = Array.isArray(raw.timecodes) ? raw.timecodes : [];
  const timecodes = tcs
    .map((tc, j) => ({
      t: num(tc && tc.t, 0),
      label: str(tc && tc.label, 'Timecode ' + (j + 1), 120),
      color: color(tc && tc.color, '')
    }))
    .sort((a, b) => a.t - b.t)
    .slice(0, 300);
  const qRaw = Array.isArray(raw.qualities) ? raw.qualities : [];
  const qualities = qRaw
    .map((q, j) => ({
      name: str(q && q.name, 'Qualité ' + (j + 1), 40),
      src: str(q && q.src, '', 500),
      auto: !!(q && q.auto)
    }))
    .filter((q) => q.src)
    .slice(0, 10);
  const pRaw = Array.isArray(raw.photos) ? raw.photos : [];
  const photos = pRaw
    .map((p) => ({
      src: str(p && p.src, '', 500),
      alt: str(p && p.alt, '', 200),
      caption: str(p && p.caption, '', 300)
    }))
    .filter((p) => p.src)
    .slice(0, 200);
  return {
    name: str(raw.name, 'Vidéo ' + (i + 1), 80),
    type: raw.type === 'photo' ? 'photo' : 'video',
    src: str(raw.src, '', 500),
    poster: str(raw.poster, '', 500),
    folderId: folderIds.has(raw.folderId) ? raw.folderId : '',
    qualities,
    timecodes,
    photos
  };
}

function sanitizeFolders(raw) {
  if (!Array.isArray(raw)) return defaultFolders();
  const ids = new Set();
  let count = 0;
  const visit = (items, depth) => {
    if (depth >= 5 || count >= 100) return [];
    const folders = [];
    for (const item of items) {
      if (!item || typeof item !== 'object' || count >= 100) continue;
      let id = typeof item.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(item.id) ? item.id : '';
      if (!id || ids.has(id)) {
        id = 'folder-' + (count + 1);
        while (ids.has(id)) id += '-new';
      }
      ids.add(id);
      count++;
      folders.push({
        id,
        name: str(item.name, 'Nouveau dossier', 80),
        children: visit(Array.isArray(item.children) ? item.children : [], depth + 1)
      });
    }
    return folders;
  };
  return visit(raw, 0);
}

function sanitizeCalendar(raw) {
  if (!Array.isArray(raw)) return [];
  const ids = new Set();
  return raw.slice(0, 500).map((item, i) => {
    item = item && typeof item === 'object' ? item : {};
    let id = typeof item.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(item.id) ? item.id : '';
    if (!id || ids.has(id)) id = 'event-' + (i + 1);
    while (ids.has(id)) id += '-new';
    ids.add(id);
    const date = typeof item.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.date) && !Number.isNaN(Date.parse(item.date + 'T00:00:00Z')) ? item.date : '';
    const time = (value) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : '';
    return {
      id,
      title: str(item.title, 'Activité du club', 120),
      date,
      startTime: time(item.startTime),
      endTime: time(item.endTime),
      location: str(item.location, '', 160),
      category: str(item.category, 'Autre', 40),
      description: typeof item.description === 'string' ? item.description.slice(0, 1200).trim() : '',
      targetIds: Array.isArray(item.targetIds)
        ? [...new Set(item.targetIds.filter((targetId) => typeof targetId === 'string' && /^[a-z0-9_-]{1,64}$/.test(targetId)))].slice(0, 500)
        : []
    };
  }).filter((item) => item.date).sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
}

function sanitizeConfig(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const def = defaultConfig();
  const folders = sanitizeFolders(raw.folders);
  const folderIds = new Set();
  const collectFolderIds = (items) => items.forEach((folder) => {
    folderIds.add(folder.id);
    collectFolderIds(folder.children);
  });
  collectFolderIds(folders);
  let tabs = Array.isArray(raw.tabs) ? raw.tabs : [];
  tabs = tabs.map((tab, i) => sanitizeTab(tab, i, folderIds));
  return {
    siteTitle: str(raw.siteTitle, def.siteTitle, 120),
    siteSubtitle: str(raw.siteSubtitle, def.siteSubtitle, 160),
    adminTitle: str(raw.adminTitle, def.adminTitle, 120),
    logoPageTitle: str(raw.logoPageTitle, def.logoPageTitle, 120),
    accentColor: color(raw.accentColor, def.accentColor),
    hint: str(raw.hint, def.hint, 200),
    folders,
    calendar: sanitizeCalendar(raw.calendar),
    tabs
  };
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function fail(res, code, message) {
  json(res, code, { ok: false, error: message });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Trop volumineux'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function safeJoin(base, rel) {
  const target = path.normalize(path.join(base, rel));
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

function validVideoName(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\\')) return false;
  const parts = value.split('/');
  return parts.every((part) =>
    part && part !== '.' && part !== '..' && !/[\x00-\x1f<>:"|?*]/.test(part)
  ) && VIDEO_EXT.has(path.extname(value).toLowerCase());
}

function validPhotoName(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\\')) return false;
  const parts = value.split('/');
  return parts.every((part) =>
    part && part !== '.' && part !== '..' && !/[\x00-\x1f<>:"|?*]/.test(part)
  ) && PHOTO_EXT.has(path.extname(value).toLowerCase());
}

function validPhotoDirectory(value) {
  if (typeof value !== 'string' || value.includes('\\')) return false;
  return !value || value.split('/').every((part) =>
    part && part !== '.' && part !== '..' && !/[\x00-\x1f<>:"|?*]/.test(part)
  );
}

function photoReferenceName(value) {
  if (typeof value !== 'string') return '';
  const match = /^(?:\.\/)?\/?photos\/(.+)$/i.exec(value.trim());
  if (!match) return '';
  try {
    return match[1].split('/').map((part) => decodeURIComponent(part)).join('/');
  } catch (error) {
    return '';
  }
}

function videoWebPath(name) {
  return 'videos/' + name.split('/').map(encodeURIComponent).join('/');
}

function replaceVideoReferences(config, oldName, newName) {
  const oldPath = videoWebPath(oldName);
  const newPath = videoWebPath(newName);
  (config.tabs || []).forEach((tab) => {
    if (tab.src === oldPath || tab.src === 'videos/' + oldName) tab.src = newPath;
    (tab.qualities || []).forEach((quality) => {
      if (quality.src === oldPath || quality.src === 'videos/' + oldName) quality.src = newPath;
    });
  });
}

function sendFile(req, res, filePath, immutable) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': immutable ? 'public, max-age=10800, immutable' : 'no-cache',
      'Last-Modified': st.mtime.toUTCString()
    };
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!m || (!m[1] && !m[2])) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }

      const requestedStart = m[1] ? Number(m[1]) : null;
      const requestedEnd = m[2] ? Number(m[2]) : null;
      let start;
      let end;
      if (requestedStart === null) {
        const suffixLength = requestedEnd;
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
          return res.end();
        }
        start = Math.max(st.size - suffixLength, 0);
        end = st.size - 1;
      } else {
        start = requestedStart;
        end = requestedEnd === null ? st.size - 1 : requestedEnd;
      }

      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      end = Math.min(end, st.size - 1);
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(filePath, { start, end });
      stream.on('error', (streamError) => {
        console.error('[lecture fichier]', streamError);
        if (!res.destroyed) res.destroy();
      });
      return stream.pipe(res);
    }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(filePath);
    stream.on('error', (streamError) => {
      console.error('[lecture fichier]', streamError);
      if (!res.destroyed) res.destroy();
    });
    stream.pipe(res);
  });
}

function notFound(res, msg) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(msg || '404 Introuvable');
}

function getDiskUsage() {
  try {
    const stat = fs.statfsSync(ROOT);
    const total = stat.blocks * stat.bsize;
    const free = stat.bavail * stat.bsize;
    return { total, free, used: total - free };
  } catch (e) {
    return { total: 0, free: 0, used: 0 };
  }
}

function listVideos() {
  const videos = [];
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return;
    fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
        return;
      }
      if (!entry.isFile() || !VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) return;
      const st = fs.statSync(filePath);
      videos.push({
        name: path.relative(VIDEOS_DIR, filePath).split(path.sep).join('/'),
        size: st.size,
        mtime: st.mtimeMs
      });
    });
  };
  visit(VIDEOS_DIR);
  return videos.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
}

function listPhotos() {
  const photos = [];
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return;
    fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
        return;
      }
      if (!entry.isFile() || !PHOTO_EXT.has(path.extname(entry.name).toLowerCase())) return;
      const st = fs.statSync(filePath);
      photos.push({
        name: path.relative(PHOTOS_DIR, filePath).split(path.sep).join('/'),
        size: st.size,
        mtime: st.mtimeMs
      });
    });
  };
  visit(PHOTOS_DIR);
  return photos.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
}

function listPhotoFolders() {
  const folders = [];
  const visit = (directory, relative) => {
    fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
      if (!entry.isDirectory()) return;
      const name = relative ? relative + '/' + entry.name : entry.name;
      folders.push(name);
      visit(path.join(directory, entry.name), name);
    });
  };
  visit(PHOTOS_DIR, '');
  return folders.sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
}

/* ---------- YouTube / direct ---------- */

const youtubeJobs = new Map();
const YOUTUBE_MAX_ACTIVE = 2;
const YOUTUBE_STAGES_ACTIVE = new Set(['preparing', 'downloading', 'merging', 'transcoding']);
let youtubeToolsCache = { at: 0, value: null };
let av1EncoderCache;

function findTool(name, versionArgs) {
  const custom = process.env[name.toUpperCase().replace(/-/g, '_') + '_PATH'];
  const candidates = [custom, name, name + '.exe'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, versionArgs, { stdio: 'ignore', windowsHide: true, timeout: 15000 });
      return candidate;
    } catch (e) { /* suivant */ }
  }
  return null;
}

function youtubeTools() {
  const now = Date.now();
  if (youtubeToolsCache.value && now - youtubeToolsCache.at < 60000) return youtubeToolsCache.value;
  const value = {
    ytdlp: findTool('yt-dlp', ['--version']),
    ffmpeg: findTool('ffmpeg', ['-version']),
    ffprobe: findTool('ffprobe', ['-version'])
  };
  youtubeToolsCache = { at: now, value };
  return value;
}

function normalizeYoutubeUrl(value) {
  if (typeof value !== 'string' || value.length > 600) return '';
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch (e) {
    return '';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const allowed = ['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'youtube-nocookie.com'];
  return allowed.includes(host) ? parsed.toString() : '';
}

function safeFileName(text, fallback) {
  let base = String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  base = base.replace(/['’]/g, '').replace(/[^\w\s.-]/g, ' ').replace(/\s+/g, ' ').trim();
  base = base.replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 90);
  return base || fallback;
}

function uniqueVideoPath(base) {
  let candidate = path.join(YOUTUBE_DIR, base + '.mp4');
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(YOUTUBE_DIR, base + ' ' + suffix + '.mp4');
    suffix += 1;
  }
  return candidate;
}

function findJobFile(baseId) {
  let entries;
  try {
    entries = fs.readdirSync(YOUTUBE_DIR);
  } catch (e) {
    return null;
  }
  const files = entries
    .filter((name) => name.startsWith(baseId + '.') && VIDEO_EXT.has(path.extname(name).toLowerCase()))
    .map((name) => path.join(YOUTUBE_DIR, name))
    .filter((file) => {
      try { return fs.statSync(file).isFile() && fs.statSync(file).size > 0; } catch (e) { return false; }
    })
    .sort((a, b) => {
      const aMp4 = path.extname(a).toLowerCase() === '.mp4' ? 1 : 0;
      const bMp4 = path.extname(b).toLowerCase() === '.mp4' ? 1 : 0;
      if (aMp4 !== bMp4) return bMp4 - aMp4;
      return fs.statSync(b).size - fs.statSync(a).size;
    });
  return files[0] || null;
}

function readJobTitle(baseId) {
  const infoFile = path.join(YOUTUBE_DIR, baseId + '.info.json');
  const info = readJSON(infoFile, null);
  return info && typeof info.title === 'string' ? info.title.trim() : '';
}

function cleanupJobFiles(baseId, keep) {
  let entries;
  try {
    entries = fs.readdirSync(YOUTUBE_DIR);
  } catch (e) {
    return;
  }
  entries
    .filter((name) => name.startsWith(baseId + '.') || name.startsWith(baseId + '-'))
    .forEach((name) => {
      const file = path.join(YOUTUBE_DIR, name);
      if (keep && path.resolve(file) === path.resolve(keep)) return;
      try { fs.unlinkSync(file); } catch (e) { /* silencieux */ }
    });
}

function spawnJobProcess(job, command, args, onLine) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (error) {
      resolve({ code: -1, error: error.message, stdout: '', stderr: '' });
      return;
    }
    job.child = child;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      job.child = null;
      resolve(result);
    };
    const read = (stream, isError) => {
      let rest = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        if (isError) stderr += chunk;
        else stdout += chunk;
        if (!onLine) return;
        rest += chunk;
        const lines = rest.split(/\r?\n/);
        rest = lines.pop();
        lines.forEach((line) => {
          if (line.trim()) onLine(line.trim(), isError);
        });
      });
      stream.on('end', () => {
        if (onLine && rest.trim()) onLine(rest.trim(), isError);
      });
    };
    read(child.stdout, false);
    read(child.stderr, true);
    child.on('error', (error) => finish({ code: -1, error: error.message, stdout, stderr }));
    child.on('close', (code, signal) => finish({ code, signal, stdout, stderr }));
  });
}

function av1Encoder(ffmpeg) {
  if (av1EncoderCache !== undefined) return av1EncoderCache;
  av1EncoderCache = null;
  try {
    const out = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    if (/\blibsvtav1\b/.test(out)) {
      av1EncoderCache = { name: 'libsvtav1', args: ['-preset', '8', '-crf', '32'] };
    } else if (/\blibaom-av1\b/.test(out)) {
      av1EncoderCache = { name: 'libaom-av1', args: ['-strict', '-2', '-cpu-used', '8', '-row-mt', '1', '-crf', '32', '-b:v', '0'] };
    }
  } catch (e) { /* aucun encodeur */ }
  return av1EncoderCache;
}

function probeCodec(ffprobe, file) {
  try {
    return execFileSync(ffprobe, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name', '-of', 'default=nw=1:nk=1', file
    ], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim().toLowerCase();
  } catch (e) {
    return '';
  }
}

function processError(result, label) {
  const detail = String(result.stderr || result.stdout || '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
  return label + ' a échoué' + (result.code != null ? ' (code ' + result.code + ')' : '') + (detail ? ' : ' + detail : '');
}

function finishCancelled(job) {
  job.stage = 'cancelled';
  job.message = 'Téléchargement annulé.';
  job.finishedAt = Date.now();
  cleanupJobFiles(job.id, null);
}

function addYoutubeTab(job, title, relative) {
  const config = sanitizeConfig(readJSON(CONFIG_FILE, defaultConfig()));
  config.tabs.push({
    name: (job.name || title || 'Vidéo YouTube').slice(0, 80),
    src: videoWebPath(relative),
    poster: '',
    folderId: job.folderId || '',
    qualities: [],
    timecodes: []
  });
  createDataBackup();
  writeJSON(CONFIG_FILE, config);
}

async function runYoutubeJob(job, tools) {
  try {
    const baseId = job.id;
    const outputTemplate = path.join(YOUTUBE_DIR, baseId + '.%(ext)s');
    const args = [
      '--no-playlist',
      '--newline',
      '--progress',
      '--no-part',
      '--write-info-json',
      '--js-runtimes', 'node',
      '-f', 'bv*+ba/b',
      '-o', outputTemplate
    ];
    if (tools.ffmpeg) {
      const ffmpegDir = path.dirname(tools.ffmpeg);
      if (ffmpegDir && ffmpegDir !== '.') args.push('--ffmpeg-location', ffmpegDir);
    }
    args.push(job.url);

    job.stage = 'downloading';
    job.progress = 0;
    job.message = 'Connexion à YouTube…';
    const download = await spawnJobProcess(job, tools.ytdlp, args, (line) => {
      const match = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line);
      if (match) {
        const percent = Math.min(100, parseFloat(match[1]));
        job.progress = Math.round(percent * 0.8);
        job.message = 'Téléchargement ' + percent.toFixed(1) + ' %';
      } else if (/\[download\] Destination:/.test(line)) {
        job.message = 'Téléchargement en cours…';
      }
    });
    if (job.cancelled) return finishCancelled(job);
    if (download.code !== 0) throw new Error(processError(download, 'yt-dlp'));

    job.stage = 'merging';
    job.progress = 82;
    job.message = 'Fichier téléchargé. Analyse du codec…';
    const downloaded = findJobFile(baseId);
    if (!downloaded) throw new Error('Le fichier téléchargé est introuvable.');
    const title = readJobTitle(baseId) || job.name || 'Vidéo YouTube';
    job.title = title;

    const codec = tools.ffprobe ? probeCodec(tools.ffprobe, downloaded) : '';
    const finalFile = path.join(YOUTUBE_DIR, baseId + '-final.mp4');
    if (codec === 'av1') {
      job.stage = 'merging';
      job.progress = 88;
      job.message = 'AV1 natif détecté. Remuxage en MP4…';
      const remux = await spawnJobProcess(job, tools.ffmpeg, [
        '-y', '-hide_banner', '-loglevel', 'error', '-i', downloaded,
        '-map', '0:v:0', '-map', '0:a?', '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', finalFile
      ], null);
      if (job.cancelled) return finishCancelled(job);
      if (remux.code !== 0 || !fs.existsSync(finalFile)) throw new Error(processError(remux, 'ffmpeg (remux)'));
    } else {
      const encoder = av1Encoder(tools.ffmpeg);
      if (!encoder) throw new Error('Aucun encodeur AV1 disponible dans ffmpeg (libsvtav1 ou libaom-av1 requis).');
      job.stage = 'transcoding';
      job.progress = 85;
      job.message = 'Conversion en AV1 avec ' + encoder.name + '… (peut prendre du temps)';
      const transcode = await spawnJobProcess(job, tools.ffmpeg, [
        '-y', '-hide_banner', '-loglevel', 'error', '-i', downloaded,
        '-map', '0:v:0', '-map', '0:a?', '-c:v', encoder.name, ...encoder.args,
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart', finalFile
      ], null);
      if (job.cancelled) return finishCancelled(job);
      if (transcode.code !== 0 || !fs.existsSync(finalFile)) throw new Error(processError(transcode, 'ffmpeg (AV1)'));
    }

    const slug = safeFileName(title, job.id);
    const target = uniqueVideoPath(slug);
    fs.renameSync(finalFile, target);
    cleanupJobFiles(baseId, target);
    addYoutubeTab(job, title, 'youtube/' + path.basename(target));

    job.fileName = path.basename(target);
    job.tabName = job.name || title;
    job.stage = 'done';
    job.progress = 100;
    job.message = 'Vidéo ajoutée à la configuration.';
    job.finishedAt = Date.now();
    console.log('[YouTube] Terminé :', target);
  } catch (error) {
    if (job.cancelled) return finishCancelled(job);
    job.stage = 'error';
    job.error = error.message || 'Erreur inconnue';
    job.message = job.error;
    job.finishedAt = Date.now();
    cleanupJobFiles(job.id, null);
    console.error('[YouTube]', job.id, error);
  }
}

function publicYoutubeJob(job) {
  return {
    id: job.id,
    url: job.url,
    name: job.name,
    title: job.title,
    folderId: job.folderId,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    fileName: job.fileName,
    tabName: job.tabName,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error
  };
}

function pruneYoutubeJobs() {
  const finished = [...youtubeJobs.values()]
    .filter((job) => !YOUTUBE_STAGES_ACTIVE.has(job.stage))
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  while (finished.length > 30) {
    const job = finished.shift();
    youtubeJobs.delete(job.id);
  }
}

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/athlete/login' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8'));
    } catch (e) {
      return fail(res, 400, 'Requête invalide');
    }
    body = body && typeof body === 'object' ? body : {};
    const id = typeof body.id === 'string' ? body.id : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if ((id && !/^[a-z0-9_-]{1,64}$/.test(id)) || !password) return fail(res, 401, 'Mot de passe incorrect');
    if (!athleteLoginAllowed(req)) return fail(res, 429, 'Trop de tentatives. Réessayez dans 15 minutes.');
    const athletes = readAthletes();
    const candidates = id ? [athletes.find((item) => item.id === id)].filter(Boolean) : athletes.filter((item) => item.passwordSalt && item.passwordHash);
    let athlete = null;
    for (const candidate of candidates.length ? candidates : [null]) {
      const salt = candidate && candidate.passwordSalt ? candidate.passwordSalt : '00000000000000000000000000000000';
      const digest = await passwordDigest(password, salt);
      const expected = candidate && /^[a-f0-9]{128}$/i.test(candidate.passwordHash || '')
        ? Buffer.from(candidate.passwordHash, 'hex')
        : Buffer.alloc(64);
      const actual = Buffer.from(digest, 'hex');
      if (candidate && expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) {
        athlete = candidate;
        break;
      }
    }
    if (!athlete) {
      recordAthleteLoginFailure(req);
      return fail(res, 401, 'Mot de passe incorrect');
    }
    athleteLoginAttempts.delete(clientAddress(req));
    setAthleteCookie(res, req, athlete);
    return json(res, 200, { ok: true, athlete: athletePublicData(athlete) });
  }

  if (p === '/api/athlete/me' && req.method === 'GET') {
    const athlete = findAthleteSession(req);
    return athlete
      ? json(res, 200, { ok: true, athlete: athletePublicData(athlete) })
      : fail(res, 401, 'Connexion requise');
  }

  if (p === '/api/athlete/calendar' && req.method === 'GET') {
    const athlete = findAthleteSession(req);
    if (!athlete) return fail(res, 401, 'Connexion requise');
    const events = sanitizeConfig(readJSON(CONFIG_FILE, defaultConfig())).calendar;
    const visibleEvent = (event) => {
      const { targetIds, ...publicEvent } = event;
      return publicEvent;
    };
    return json(res, 200, {
      ok: true,
      events: events.filter((event) => event.targetIds.length === 0 || event.targetIds.includes(athlete.id)).map(visibleEvent),
      otherCalendars: readAthletes()
        .filter((other) => other.id !== athlete.id && other.passwordSalt && other.passwordHash)
        .map((other) => ({
          id: other.id,
          name: other.name,
          events: events.filter((event) => event.targetIds.length === 0 || event.targetIds.includes(other.id)).map(visibleEvent)
        }))
    });
  }

  if (p === '/api/athlete/logout' && req.method === 'POST') {
    clearAthleteCookie(res, req);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/athletes' && req.method === 'GET') {
    if (!hasAccess(req)) return fail(res, 401, 'Non autorisé');
    return json(res, 200, { ok: true, athletes: readAthletes().map(athletePublicData) });
  }

  if (p === '/api/athletes' && req.method === 'POST') {
    if (!hasAccess(req)) return fail(res, 401, 'Non autorisé');
    let body;
    try {
      body = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8'));
    } catch (e) {
      return fail(res, 400, 'JSON invalide');
    }
    body = body && typeof body === 'object' ? body : {};
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 8) return fail(res, 400, 'Le mot de passe doit contenir au moins 8 caractères');
    const athletes = readAthletes();
    if (athletes.length >= 500) return fail(res, 400, 'La limite de fiches athlètes est atteinte');
    let athlete;
    try {
      athlete = sanitizeAthlete(body, 0);
    } catch (e) {
      return fail(res, 400, e.message);
    }
    if (athletes.some((item) => item.id === athlete.id)) return fail(res, 409, 'Cet identifiant existe déjà');
    await setAthletePassword(athlete, password);
    createDataBackup();
    athletes.push(athlete);
    writeJSON(ATHLETES_FILE, athletes);
    return json(res, 201, { ok: true, athlete: athletePublicData(athlete) });
  }

  const athleteRoute = /^\/api\/athletes\/([a-z0-9_-]{1,64})$/.exec(p);
  if (athleteRoute && ['PUT', 'DELETE'].includes(req.method)) {
    if (!hasAccess(req)) return fail(res, 401, 'Non autorisé');
    const athletes = readAthletes();
    const index = athletes.findIndex((item) => item.id === athleteRoute[1]);
    if (index < 0) return fail(res, 404, 'Athlète introuvable');
    if (req.method === 'DELETE') {
      createDataBackup();
      athletes.splice(index, 1);
      writeJSON(ATHLETES_FILE, athletes);
      return json(res, 200, { ok: true });
    }
    let body;
    try {
      body = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8'));
    } catch (e) {
      return fail(res, 400, 'JSON invalide');
    }
    body = body && typeof body === 'object' ? body : {};
    let updated;
    try {
      updated = sanitizeAthlete(Object.assign({}, body, { id: athleteRoute[1] }), index);
    } catch (e) {
      return fail(res, 400, e.message);
    }
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (newPassword && newPassword.length < 8) return fail(res, 400, 'Le mot de passe doit contenir au moins 8 caractères');
    if (!newPassword) {
      updated.passwordSalt = athletes[index].passwordSalt;
      updated.passwordHash = athletes[index].passwordHash;
    }
    createDataBackup();
    if (newPassword) await setAthletePassword(updated, newPassword);
    athletes[index] = updated;
    writeJSON(ATHLETES_FILE, athletes);
    return json(res, 200, { ok: true, athlete: athletePublicData(updated) });
  }

  if (p === '/api/backup' && req.method === 'GET') {
    if (!hasAccess(req)) return fail(res, 401, 'Non autorisé');
    return json(res, 200, {
      ok: true,
      backup: {
        createdAt: new Date().toISOString(),
        config: readJSON(CONFIG_FILE, defaultConfig()),
        athletes: readAthletes()
      }
    });
  }

  if (p === '/api/config' && req.method === 'GET') {
    const config = sanitizeConfig(readJSON(CONFIG_FILE, defaultConfig()));
    if (!hasAccess(req)) config.calendar = config.calendar.filter((event) => event.targetIds.length === 0);
    return json(res, 200, config);
  }

  if (p === '/api/videos' && req.method === 'GET') {
    return json(res, 200, { ok: true, videos: listVideos() });
  }

  if (p === '/api/photos' && req.method === 'GET') {
    return json(res, 200, { ok: true, photos: listPhotos(), folders: listPhotoFolders() });
  }

  if (p === '/api/photos/folders' && req.method === 'POST') {
    if (!hasAccess(req)) return fail(res, 401, 'Non autorisé');
    let body;
    try {
      body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8'));
    } catch (e) {
      return fail(res, 400, 'Requête invalide');
    }
    body = body && typeof body === 'object' ? body : {};
    const parent = typeof body.parent === 'string' ? body.parent.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!validPhotoDirectory(parent) || (parent && parent.split('/').length >= 8)) return fail(res, 400, 'Chemin de dossier invalide');
    if (!name || name.length > 100 || name === '.' || name === '..' || /[\/\\\x00-\x1f<>:"|?*]/.test(name)) {
      return fail(res, 400, 'Nom de dossier invalide');
    }
    const parentPath = safeJoin(PHOTOS_DIR, parent);
    if (!parentPath || !fs.existsSync(parentPath) || !fs.statSync(parentPath).isDirectory()) {
      return fail(res, 400, 'Le dossier parent n’existe pas');
    }
    const folder = parent ? parent + '/' + name : name;
    const target = safeJoin(PHOTOS_DIR, folder);
    if (!target) return fail(res, 400, 'Chemin de dossier invalide');
    try {
      fs.mkdirSync(target);
    } catch (error) {
      if (error.code === 'EEXIST') return fail(res, 409, 'Un dossier porte déjà ce nom');
      throw error;
    }
    return json(res, 201, { ok: true, folder });
  }

  if (p === '/api/photos/move' && req.method === 'PUT') {
    if (!hasAccess(req)) return fail(res, 401, 'Non autorisé');
    let body;
    try {
      body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8'));
    } catch (e) {
      return fail(res, 400, 'Requête invalide');
    }
    body = body && typeof body === 'object' ? body : {};
    const source = typeof body.source === 'string' ? body.source.trim() : '';
    const folder = typeof body.folder === 'string' ? body.folder.trim() : '';
    if (!validPhotoName(source) || !validPhotoDirectory(folder) || (folder && folder.split('/').length > 8)) {
      return fail(res, 400, 'Chemin de photo invalide');
    }
    const sourcePath = safeJoin(PHOTOS_DIR, source);
    const destinationName = folder ? folder + '/' + path.basename(source) : path.basename(source);
    const destinationPath = safeJoin(PHOTOS_DIR, destinationName);
    const folderPath = safeJoin(PHOTOS_DIR, folder);
    if (!sourcePath || !destinationPath || !folderPath) return fail(res, 400, 'Chemin de photo invalide');
    let sourceStat;
    try {
      sourceStat = fs.lstatSync(sourcePath);
    } catch (error) {
      if (error.code === 'ENOENT') return fail(res, 404, 'Photo introuvable');
      throw error;
    }
    if (!sourceStat.isFile()) return fail(res, 404, 'Photo introuvable');
    if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
      return fail(res, 400, 'Le dossier de destination n’existe pas');
    }
    if (source === destinationName) return json(res, 200, { ok: true, name: destinationName });
    if (fs.existsSync(destinationPath)) return fail(res, 409, 'Une photo porte déjà ce nom dans ce dossier');

    const config = sanitizeConfig(readJSON(CONFIG_FILE, defaultConfig()));
    let updatedReferences = 0;
    config.tabs.forEach((tab) => {
      if (tab.type !== 'photo') return;
      tab.photos.forEach((photo) => {
        if (photoReferenceName(photo.src) !== source) return;
        photo.src = '/photos/' + destinationName.split('/').map(encodeURIComponent).join('/');
        updatedReferences += 1;
      });
    });
    if (updatedReferences) createDataBackup();
    try {
      fs.renameSync(sourcePath, destinationPath);
      if (updatedReferences) writeJSON(CONFIG_FILE, config);
    } catch (error) {
      if (fs.existsSync(destinationPath) && !fs.existsSync(sourcePath)) {
        try { fs.renameSync(destinationPath, sourcePath); } catch (rollbackError) {
          console.error('[déplacement photo] Échec du retour arrière :', rollbackError);
        }
      }
      throw error;
    }
    return json(res, 200, { ok: true, name: destinationName, updatedReferences });
  }

  if (p === '/api/photos' && req.method === 'DELETE') {
    if (!hasAccess(req)) return fail(res, 401, 'Non autorisé');
    const name = (url.searchParams.get('name') || '').trim();
    if (!validPhotoName(name)) return fail(res, 400, 'Nom de photo invalide');
    const target = safeJoin(PHOTOS_DIR, name);
    if (!target) return fail(res, 400, 'Chemin de photo invalide');

    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch (error) {
      if (error.code === 'ENOENT') return fail(res, 404, 'Photo introuvable');
      throw error;
    }
    if (!stat.isFile()) return fail(res, 404, 'Photo introuvable');

    const config = sanitizeConfig(readJSON(CONFIG_FILE, defaultConfig()));
    let removedReferences = 0;
    config.tabs.forEach((tab) => {
      if (tab.type !== 'photo') return;
      const kept = tab.photos.filter((photo) => photoReferenceName(photo.src) !== name);
      removedReferences += tab.photos.length - kept.length;
      tab.photos = kept;
    });
    if (removedReferences) createDataBackup();

    fs.unlinkSync(target);
    if (removedReferences) {
      try {
        writeJSON(CONFIG_FILE, config);
      } catch (error) {
        console.error('[suppression photo] Impossible de mettre à jour la configuration :', error);
        return fail(res, 500, 'Photo supprimée, mais impossible de mettre à jour les galeries configurées.');
      }
    }
    return json(res, 200, { ok: true, removedReferences });
  }

  if (p === '/api/youtube/jobs' && req.method === 'GET') {
    if (!hasAccess(req)) return fail(res, 401, 'Non autorisé');
    const tools = youtubeTools();
    return json(res, 200, {
      ok: true,
      available: Boolean(tools.ytdlp && tools.ffmpeg),
      tools: { ytDlp: Boolean(tools.ytdlp), ffmpeg: Boolean(tools.ffmpeg), ffprobe: Boolean(tools.ffprobe) },
      jobs: [...youtubeJobs.values()]
        .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
        .map(publicYoutubeJob)
    });
  }

  if (p === '/api/youtube/start' && req.method === 'POST') {
    if (!hasAccess(req)) return fail(res, 401, 'Non autorisé');
    let body;
    try {
      body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8'));
    } catch (e) {
      return fail(res, 400, 'Requête invalide');
    }
    body = body && typeof body === 'object' ? body : {};
    const youtubeUrl = normalizeYoutubeUrl(body.url);
    if (!youtubeUrl) return fail(res, 400, 'Lien YouTube invalide.');
    const tools = youtubeTools();
    if (!tools.ytdlp) return fail(res, 503, 'yt-dlp est introuvable sur le serveur.');
    if (!tools.ffmpeg) return fail(res, 503, 'ffmpeg est introuvable sur le serveur.');
    const name = str(body.name, '', 80);
    const folderId = typeof body.folderId === 'string' ? body.folderId : '';
    if (folderId) {
      const folderIds = new Set();
      const visit = (folders) => folders.forEach((folder) => { folderIds.add(folder.id); visit(folder.children); });
      visit(sanitizeConfig(readJSON(CONFIG_FILE, defaultConfig())).folders);
      if (!folderIds.has(folderId)) return fail(res, 400, 'Dossier de destination inconnu.');
    }
    const active = [...youtubeJobs.values()].filter((job) => YOUTUBE_STAGES_ACTIVE.has(job.stage)).length;
    if (active >= YOUTUBE_MAX_ACTIVE) return fail(res, 429, 'Trop de téléchargements en cours. Réessayez quand un se termine.');
    pruneYoutubeJobs();
    const id = 'yt-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
    const job = {
      id,
      url: youtubeUrl,
      name,
      title: '',
      folderId,
      stage: 'preparing',
      progress: 0,
      message: 'En file d’attente…',
      fileName: '',
      tabName: '',
      error: '',
      startedAt: Date.now(),
      finishedAt: null,
      child: null,
      cancelled: false
    };
    youtubeJobs.set(id, job);
    runYoutubeJob(job, tools).catch((error) => console.error('[YouTube]', error));
    return json(res, 201, { ok: true, job: publicYoutubeJob(job) });
  }

  if (p === '/api/youtube/cancel' && req.method === 'POST') {
    if (!hasAccess(req)) return fail(res, 401, 'Non autorisé');
    let body;
    try {
      body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8'));
    } catch (e) {
      return fail(res, 400, 'Requête invalide');
    }
    const job = body && typeof body.id === 'string' ? youtubeJobs.get(body.id) : null;
    if (!job) return fail(res, 404, 'Téléchargement introuvable.');
    if (!YOUTUBE_STAGES_ACTIVE.has(job.stage)) return fail(res, 400, 'Ce téléchargement est déjà terminé.');
    job.cancelled = true;
    job.message = 'Annulation…';
    if (job.child) {
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(job.child.pid), '/T', '/F'], { stdio: 'ignore' });
        else job.child.kill('SIGTERM');
      } catch (e) {
        try { job.child.kill('SIGKILL'); } catch (killError) { /* silencieux */ }
      }
    } else {
      finishCancelled(job);
    }
    return json(res, 200, { ok: true });
  }

  if (p === '/api/monitor' && req.method === 'GET') {
    const videos = listVideos();
    const disk = getDiskUsage();
    const totalVideoBytes = videos.reduce((sum, video) => sum + video.size, 0);
    return json(res, 200, {
      ok: true,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      disk,
      videos: {
        count: videos.length,
        totalSize: totalVideoBytes,
        newest: videos.slice(0, 5).map((video) => ({ name: video.name, size: video.size, mtime: video.mtime }))
      },
      athletes: readAthletes().length,
      ping: 'ok'
    });
  }

  if (p === '/api/verify' && req.method === 'GET') {
    const suppliedPassword = req.headers['x-admin-pass'];
    if (typeof suppliedPassword === 'string' && suppliedPassword.length > 0 && suppliedPassword === auth()) {
      setAdminCookie(res, req, suppliedPassword);
      return json(res, 200, { ok: true });
    }
    return hasValidAdminCookie(req) ? json(res, 200, { ok: true }) : fail(res, 401, 'Mot de passe incorrect');
  }

  if (p === '/api/logout' && req.method === 'POST') {
    clearAdminCookie(res, req);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/config' && req.method === 'POST') {
    if (!hasAccess(req)) return fail(res, 401, 'Non autorisé');
    let body;
    try {
      body = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8'));
    } catch (e) {
      return fail(res, 400, 'JSON invalide : ' + e.message);
    }
    const cfg = sanitizeConfig(body);
    createDataBackup();
    writeJSON(CONFIG_FILE, cfg);
    return json(res, 200, { ok: true, config: cfg });
  }

  if (p === '/api/password' && req.method === 'POST') {
    if (!hasAccess(req)) return fail(res, 401, 'Non autorisé');
    let body;
    try {
      body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
    } catch (e) {
      return fail(res, 400, 'JSON invalide');
    }
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const neu = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (currentPassword !== auth()) return fail(res, 401, 'Mot de passe actuel incorrect');
    if (neu.length < 6) return fail(res, 400, 'Le nouveau mot de passe doit faire au moins 6 caractères');
    writeJSON(AUTH_FILE, { password: neu });
    setAdminCookie(res, req, neu);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/upload' && req.method === 'POST') {
    if (!hasAccess(req)) return fail(res, 401, 'Non autorisé');
    const raw = (url.searchParams.get('name') || '').trim();
    if (!raw) return fail(res, 400, 'Nom de fichier invalide');
    if (raw.includes('..') || raw.includes('/') || raw.includes('\\')) return fail(res, 400, 'Nom de fichier invalide');
    const name = path.basename(raw);
    const ext = path.extname(name).toLowerCase();
    if (!validVideoName(name)) return fail(res, 400, VIDEO_EXT.has(ext) ? 'Nom de fichier invalide' : 'Extension non supportée : ' + ext);
    const target = safeJoin(VIDEOS_DIR, name);
    if (!target) return fail(res, 400, 'Chemin invalide');
    const ws = fs.createWriteStream(target, { flags: 'wx' });
    let size = 0;
    let aborted = false;
    let opened = false;
    ws.on('open', () => { opened = true; });
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD) {
        aborted = true;
        ws.destroy();
        fs.unlink(target, () => {});
        req.destroy();
      }
    });
    req.pipe(ws);
    ws.on('finish', () => {
      if (aborted) return;
      json(res, 200, { ok: true, name, size });
    });
    ws.on('error', (error) => {
      if (opened) fs.unlink(target, () => {});
      req.unpipe(ws);
      req.resume();
      if (!res.headersSent) fail(res, error.code === 'EEXIST' ? 409 : 500, error.code === 'EEXIST' ? 'Un fichier porte déjà ce nom' : "Erreur d'écriture");
    });
    return;
  }

  if (p === '/api/upload/photo' && req.method === 'POST') {
    if (!hasAccess(req)) return fail(res, 401, 'Non autorisé');
    const raw = (url.searchParams.get('name') || '').trim();
    const folder = (url.searchParams.get('folder') || '').trim();
    if (!raw) return fail(res, 400, 'Nom de fichier invalide');
    if (raw.includes('..') || raw.includes('/') || raw.includes('\\')) return fail(res, 400, 'Nom de fichier invalide');
    const name = path.basename(raw);
    const ext = path.extname(name).toLowerCase();
    if (!validPhotoName(name)) return fail(res, 400, PHOTO_EXT.has(ext) ? 'Nom de fichier invalide' : 'Extension non supportée : ' + ext);
    if (!validPhotoDirectory(folder) || (folder && folder.split('/').length > 8)) return fail(res, 400, 'Chemin de dossier invalide');
    const folderPath = safeJoin(PHOTOS_DIR, folder);
    if (!folderPath || !fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
      return fail(res, 400, 'Le dossier de destination n’existe pas');
    }
    const target = safeJoin(PHOTOS_DIR, folder ? folder + '/' + name : name);
    if (!target) return fail(res, 400, 'Chemin invalide');
    const ws = fs.createWriteStream(target, { flags: 'wx' });
    let size = 0;
    let aborted = false;
    let opened = false;
    ws.on('open', () => { opened = true; });
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD) {
        aborted = true;
        ws.destroy();
        fs.unlink(target, () => {});
        req.destroy();
      }
    });
    req.pipe(ws);
    ws.on('finish', () => {
      if (aborted) return;
      json(res, 200, { ok: true, name, size });
    });
    ws.on('error', (error) => {
      if (opened) fs.unlink(target, () => {});
      req.unpipe(ws);
      req.resume();
      if (!res.headersSent) fail(res, error.code === 'EEXIST' ? 409 : 500, error.code === 'EEXIST' ? 'Un fichier porte déjà ce nom' : "Erreur d'écriture");
    });
    return;
  }

  if (p === '/api/video' && req.method === 'PUT') {
    if (!hasAccess(req)) return fail(res, 401, 'Non autorisé');
    let body;
    try {
      body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8'));
    } catch (e) {
      return fail(res, 400, 'Requête invalide');
    }
    body = body && typeof body === 'object' ? body : {};
    const source = typeof body.source === 'string' ? body.source.trim() : '';
    const destination = typeof body.destination === 'string' ? body.destination.trim() : '';
    if (!validVideoName(source) || !validVideoName(destination)) return fail(res, 400, 'Chemin vidéo invalide');
    const sourcePath = safeJoin(VIDEOS_DIR, source);
    const destinationPath = safeJoin(VIDEOS_DIR, destination);
    if (!sourcePath || !destinationPath) return fail(res, 400, 'Chemin vidéo invalide');
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) return fail(res, 404, 'Fichier source introuvable');
    if (!fs.existsSync(path.dirname(destinationPath)) || !fs.statSync(path.dirname(destinationPath)).isDirectory()) {
      return fail(res, 400, 'Le dossier de destination n’existe pas');
    }
    if (source === destination) return json(res, 200, { ok: true, name: destination });
    if (fs.existsSync(destinationPath)) return fail(res, 409, 'Un fichier porte déjà ce nom');
    const config = sanitizeConfig(readJSON(CONFIG_FILE, defaultConfig()));
    replaceVideoReferences(config, source, destination);
    createDataBackup();
    try {
      fs.renameSync(sourcePath, destinationPath);
      writeJSON(CONFIG_FILE, config);
    } catch (error) {
      if (fs.existsSync(destinationPath) && !fs.existsSync(sourcePath)) {
        try { fs.renameSync(destinationPath, sourcePath); } catch (rollbackError) {
          console.error('[déplacement vidéo] Échec du retour arrière :', rollbackError);
        }
      }
      throw error;
    }
    return json(res, 200, { ok: true, name: destination });
  }

  if (p === '/api/video' && req.method === 'DELETE') {
    if (!hasAccess(req)) return fail(res, 401, 'Non autorisé');
    const name = (url.searchParams.get('name') || '').trim();
    if (!name || name.includes('\\') || name.split('/').some((part) => !part || part === '.' || part === '..')) {
      return fail(res, 400, 'Nom invalide');
    }
    const target = safeJoin(VIDEOS_DIR, name);
    if (!target || !VIDEO_EXT.has(path.extname(name).toLowerCase())) return fail(res, 400, 'Nom invalide');
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return fail(res, 404, 'Fichier introuvable');
    fs.unlinkSync(target);
    return json(res, 200, { ok: true });
  }

  return fail(res, 404, 'Endpoint inconnu');
}

function sendIndex(req, res, filePath) {
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end();
  }
  let html;
  try {
    html = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    console.error('[index.html]', e);
    return fail(res, 500, 'Impossible de lire index.html');
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(html);
}

if (!BEHIND_CADDY && !ensureTls()) process.exit(1);

const handleRequest = async (req, res) => {
  const t0 = Date.now();
  res.on('finish', () => {
    console.log(req.method, req.url, '->', res.statusCode, '(' + (Date.now() - t0) + ' ms)');
  });
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) return fail(res, 405, 'Méthode interdite');
      return await handleApi(req, res, url);
    }
    if (!['GET', 'HEAD'].includes(req.method)) return fail(res, 405, 'Méthode interdite');

    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    else if (rel === '/logo') rel = '/logo.html';
    else if (rel === '/athlete') rel = '/athlete.html';
    if (rel === '/calendar.html' && !hasAccess(req)) {
      res.writeHead(302, { Location: '/admin.html', 'Cache-Control': 'no-store' });
      return res.end();
    }
    const lowerRel = rel.toLowerCase();
    if (lowerRel === '/deploy' || lowerRel.startsWith('/deploy/') || lowerRel === '/backups' || lowerRel.startsWith('/backups/')) return notFound(res);
    const target = safeJoin(ROOT, rel.slice(1));
    if (!target) return notFound(res, 'Chemin interdit');
    const targetParts = path.relative(ROOT, target).split(path.sep);
    if (targetParts[0].toLowerCase() === 'backups') return notFound(res);
    const basename = path.basename(target).toLowerCase();
    if (['auth.json', 'athletes.json'].includes(basename) || target.toLowerCase().endsWith('.tmp')) return notFound(res);

    if (path.basename(target) === 'index.html' && fs.existsSync(target)) {
      return sendIndex(req, res, target);
    }

    const ext = path.extname(target).toLowerCase();
    const isMedia = VIDEO_EXT.has(ext);
    sendFile(req, res, target, isMedia);
  } catch (e) {
    console.error('[ERREUR]', e);
    if (!res.headersSent) fail(res, 500, 'Erreur serveur');
  }
};

const server = BEHIND_CADDY
  ? http.createServer(handleRequest)
  : http2.createSecureServer(
    {
      key: fs.readFileSync(TLS_KEY),
      cert: fs.readFileSync(TLS_CERT),
      allowHTTP1: true,
      settings: { maxConcurrentStreams: 100, initialWindowSize: 4 * 1024 * 1024 }
    },
    handleRequest
  );

process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

const onListening = () => {
  console.log('CPV Cyclones Viewer 2000 démarré');
  if (BEHIND_CADDY) {
    console.log('Mode proxy Caddy -> http://127.0.0.1:' + PORT);
  } else {
    console.log('URL locale       -> https://localhost:' + PORT);
    try {
      const ifaces = os.networkInterfaces();
      Object.keys(ifaces).forEach((k) => {
        ifaces[k].forEach((iface) => {
          if (iface.family === 'IPv4' && !iface.internal) {
            console.log('URL réseau       -> https://' + iface.address + ':' + PORT);
          }
        });
      });
    } catch (e) { /* silencieux */ }
  }
  console.log('Admin            -> /admin.html (mot de passe requis)');
  if (!BEHIND_CADDY) {
    console.log('Certificat auto-signé : la première visite demande d\'accepter l\'avertissement du navigateur.');
  }
};

if (BEHIND_CADDY) server.listen(PORT, '127.0.0.1', onListening);
else server.listen(PORT, onListening);
