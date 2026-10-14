'use strict';

const http2 = require('http2');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8080;
const BEHIND_CADDY = process.env.BEHIND_CADDY === '1';
const CONFIG_FILE = path.join(ROOT, 'config.json');
const AUTH_FILE = path.join(ROOT, 'auth.json');
const VIDEOS_DIR = path.join(ROOT, 'videos');
const TLS_DIR = path.join(ROOT, 'tls');
const TLS_KEY = path.join(TLS_DIR, 'key.pem');
const TLS_CERT = path.join(TLS_DIR, 'cert.pem');
const ADMIN_COOKIE = 'cpv_admin_session';
const ADMIN_SESSION_TTL = 30 * 24 * 60 * 60;

const MAX_UPLOAD = 6 * 1024 * 1024 * 1024;
const MAX_JSON = 2 * 1024 * 1024;
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm', '.ogv', '.ogg', '.mov', '.mkv', '.avi']);

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
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });
if (!fs.existsSync(CONFIG_FILE)) writeJSON(CONFIG_FILE, defaultConfig());
if (!fs.existsSync(AUTH_FILE)) writeJSON(AUTH_FILE, { password: 'cpvCyclones2026S-E' });

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
  return {
    name: str(raw.name, 'Vidéo ' + (i + 1), 80),
    src: str(raw.src, '', 500),
    poster: str(raw.poster, '', 500),
    folderId: folderIds.has(raw.folderId) ? raw.folderId : '',
    qualities,
    timecodes
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
      description: typeof item.description === 'string' ? item.description.slice(0, 1200).trim() : ''
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
  return videos.sort((a, b) => b.mtime - a.mtime);
}

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/config' && req.method === 'GET') {
    const config = sanitizeConfig(readJSON(CONFIG_FILE, defaultConfig()));
    if (!hasAccess(req)) config.calendar = [];
    return json(res, 200, config);
  }

  if (p === '/api/videos' && req.method === 'GET') {
    return json(res, 200, { ok: true, videos: listVideos() });
  }

  if (p === '/api/monitor' && req.method === 'GET') {
    const videos = listVideos();
    const disk = getDiskUsage();
    return json(res, 200, {
      ok: true,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      disk,
      videos: {
        count: videos.length,
        newest: videos.slice(0, 5).map((video) => ({ name: video.name, size: video.size, mtime: video.mtime }))
      },
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
    if (name === '.' || name === '..') return fail(res, 400, 'Nom de fichier invalide');
    if (/[\x00-\x1f<>:"|?*]/.test(name)) return fail(res, 400, 'Nom de fichier invalide');
    if (!VIDEO_EXT.has(ext)) return fail(res, 400, 'Extension non supportée : ' + ext);
    const target = safeJoin(VIDEOS_DIR, name);
    if (!target) return fail(res, 400, 'Chemin invalide');
    const ws = fs.createWriteStream(target);
    let size = 0;
    let aborted = false;
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
    ws.on('error', () => {
      if (!res.headersSent) fail(res, 500, "Erreur d'écriture");
    });
    return;
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
      if (!['GET', 'POST', 'DELETE'].includes(req.method)) return fail(res, 405, 'Méthode interdite');
      return await handleApi(req, res, url);
    }
    if (!['GET', 'HEAD'].includes(req.method)) return fail(res, 405, 'Méthode interdite');

    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    else if (rel === '/logo') rel = '/logo.html';
    if (rel === '/calendar.html' && !hasAccess(req)) {
      res.writeHead(302, { Location: '/admin.html', 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (rel === '/deploy' || rel.startsWith('/deploy/')) return notFound(res);
    const target = safeJoin(ROOT, rel.slice(1));
    if (!target) return notFound(res, 'Chemin interdit');
    if (path.basename(target) === 'auth.json' || target.endsWith('.tmp')) return notFound(res);

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
