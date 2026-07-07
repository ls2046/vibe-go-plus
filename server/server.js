#!/usr/bin/env node
'use strict';

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { URL } = require('url');

const APP_NAME = 'VibeGo Codex Bridge';
const VERSION = '0.1.0';
const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadLocalEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] == null) process.env[key] = value;
  }
}

loadLocalEnvFile(path.join(__dirname, '.env'));
loadLocalEnvFile(path.join(__dirname, '.env.local'));

const { transcribeVolcengineAudio } = require('./volc-asr');

const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const CODEX_SESSION_INDEX = path.join(os.homedir(), '.codex', 'session_index.jsonl');
const CODEX_THREAD_SCOPE_OVERRIDES_FILE = path.join(os.homedir(), '.codex', 'vibego_thread_scope_overrides.json');
const MAX_BODY_BYTES = Number(process.env.VIBEGO_MAX_BODY_BYTES || 80 * 1024 * 1024);
const MAX_TEXT_FILE_BYTES = Number(process.env.VIBEGO_MAX_TEXT_FILE_BYTES || 2 * 1024 * 1024);
const HISTORY_TAIL_BYTES = Number(process.env.VIBEGO_HISTORY_TAIL_BYTES || 16 * 1024 * 1024);
const STATUS_TAIL_BYTES = Number(process.env.VIBEGO_STATUS_TAIL_BYTES || 4 * 1024 * 1024);
const ACCEPT_TIMEOUT_MS = Number(process.env.VIBEGO_CODEX_ACCEPT_TIMEOUT_MS || 8000);
const CODEX_THREAD_SYNC_FRESH_MS = Number(process.env.VIBEGO_CODEX_THREAD_SYNC_FRESH_MS || 5000);
const CODEX_DEEPLINK_SETTLE_MS = Number(process.env.VIBEGO_CODEX_DEEPLINK_SETTLE_MS || 560);
const CODEX_APP_FOCUS_SETTLE_MS = Number(process.env.VIBEGO_CODEX_APP_FOCUS_SETTLE_MS || 100);
const CODEX_CLICK_SETTLE_MS = Number(process.env.VIBEGO_CODEX_CLICK_SETTLE_MS || 60);
const TEXT_PASTE_SETTLE_MS = Number(process.env.VIBEGO_CODEX_TEXT_PASTE_SETTLE_MS || 140);
const CODEX_DIRECT_PROJECT_ID = 'codex-direct-conversations';
const CODEX_DIRECT_PROJECT_NAME = '对话';
const CODEX_DIRECT_CWD_ROOT = path.join(os.homedir(), 'Documents', 'Codex');
const PREPARED_CODEX_NEW_THREAD_TTL_MS = Number(process.env.VIBEGO_PREPARED_CODEX_NEW_THREAD_TTL_MS || 5 * 60 * 1000);

let lastCodexThreadActivation = { threadId: '', at: 0 };
let lastCodexSidebarSnapshot = { projects: [], threads: [], at: 0 };
let preparedCodexNewThread = null;
const recentSends = new Map();
const mobileAutomationResults = [];

function textPreview(value, max = 120) {
  const textValue = String(value || '').replace(/\s+/g, ' ').trim();
  return textValue.length > max ? `${textValue.slice(0, max)}...` : textValue;
}

function errorInfo(error) {
  const combined = `${error && error.message ? error.message : ''}\n${error && error.stdout ? error.stdout : ''}\n${error && error.stderr ? error.stderr : ''}`;
  let friendly = '';
  if (combined.includes('-25211') || combined.includes('不允许辅助访问') || combined.includes('not allowed assistive access')) {
    friendly = 'Codex CDP 自动化未能完成。请确认 Codex Desktop 已用 --remote-debugging-port=9222 启动，并重启 VibeGo server 后重试。';
  }
  return {
    name: error && error.name ? error.name : '',
    message: friendly || (error && error.message ? error.message : String(error)),
    rawMessage: error && error.message ? error.message : String(error),
    code: error && error.code ? error.code : '',
    stdout: error && error.stdout ? textPreview(error.stdout, 240) : '',
    stderr: error && error.stderr ? textPreview(error.stderr, 240) : '',
    stack: error && error.stack ? String(error.stack).split('\n').slice(0, 8).join('\n') : '',
  };
}

function debugLog(scope, payload = {}) {
  const line = {
    at: new Date().toISOString(),
    scope,
    ...payload,
  };
  try {
    console.log('[vibego-debug]', JSON.stringify(line));
  } catch {
    console.log('[vibego-debug]', scope, payload);
  }
}

function debugError(scope, error, payload = {}) {
  try {
    console.error('[vibego-error]', JSON.stringify({
      at: new Date().toISOString(),
      scope,
      ...payload,
      error: errorInfo(error),
    }));
  } catch {
    console.error('[vibego-error]', scope, error);
  }
}

function readConfig() {
  const fallback = {
    port: 8790,
    host: '0.0.0.0',
    token: '',
    codexBundleId: 'com.openai.codex',
    projects: [],
  };
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return { ...fallback, ...data, projects: normalizeProjects(data.projects || []) };
  } catch {
    return { ...fallback, projects: [] };
  }
}

function normalizeProjects(projects) {
  return projects
    .map((item, index) => {
      const rawPath = expandHome(String(item.path || ''));
      const resolved = path.resolve(rawPath);
      return {
        id: sanitizeId(item.id || item.name || path.basename(resolved) || `project-${index + 1}`),
        name: String(item.name || path.basename(resolved) || `Project ${index + 1}`),
        path: resolved,
      };
    })
    .filter((item) => {
      try {
        return fs.statSync(item.path).isDirectory();
      } catch {
        return false;
      }
    });
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function sanitizeId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || crypto.randomBytes(4).toString('hex');
}

const config = readConfig();
const PORT = Number(process.env.PORT || config.port || 8790);
const HOST = process.env.HOST || config.host || '0.0.0.0';
const TOKEN = process.env.VIBEGO_TOKEN || config.token || '';
const CODEX_CDP_ENDPOINT = process.env.VIBEGO_CODEX_CDP_ENDPOINT || config.codexCdpEndpoint || 'http://127.0.0.1:9222';
const CODEX_BACKEND = 'cdp';
const CODEX_BUSY_WAIT_TIMEOUT_MS = Number(process.env.VIBEGO_CODEX_BUSY_WAIT_TIMEOUT_MS || config.codexBusyWaitTimeoutMs || 120000);
const CODEX_BUSY_WAIT_INTERVAL_MS = Number(process.env.VIBEGO_CODEX_BUSY_WAIT_INTERVAL_MS || config.codexBusyWaitIntervalMs || 1200);
const CODEX_NEW_THREAD_READY_TIMEOUT_MS = Number(process.env.VIBEGO_CODEX_NEW_THREAD_READY_TIMEOUT_MS || config.codexNewThreadReadyTimeoutMs || 30000);

function publicBaseUrl(req) {
  const requestedBase = String(req.headers['x-vibego-server-url'] || '').trim();
  if (requestedBase) {
    try {
      const normalized = requestedBase.startsWith('http://') || requestedBase.startsWith('https://') ? requestedBase : `http://${requestedBase}`;
      const parsed = new URL(normalized);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {}
  }
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  return `http://${host}`;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-vibego-token,x-vibego-server-url',
    'access-control-allow-private-network': 'true',
  });
  res.end(body);
}

function contentTypeForFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.pdf') return 'application/pdf';
  return 'application/octet-stream';
}

function uploadUrl(req, filePath) {
  const relative = path.relative(path.join(__dirname, 'uploads'), filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return '';
  return `${publicBaseUrl(req)}/uploads/${relative.split(path.sep).map(encodeURIComponent).join('/')}`;
}

function serveUpload(req, res, pathname) {
	const encoded = pathname.slice('/uploads/'.length);
	const decoded = decodeURIComponent(encoded);
	const fullPath = path.resolve(path.join(__dirname, 'uploads'), decoded);
  const root = path.resolve(path.join(__dirname, 'uploads'));
  if (!fullPath.startsWith(root + path.sep) || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    return json(res, 404, { ok: false, error: 'not found' });
  }
  const body = fs.readFileSync(fullPath);
  res.writeHead(200, {
    'content-type': contentTypeForFile(fullPath),
    'content-length': body.length,
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=3600',
	});
	res.end(body);
}

function isImageFilePath(filePath) {
  const type = contentTypeForFile(filePath);
  return type.startsWith('image/');
}

function serveLocalImage(req, res, filePath) {
  const expanded = expandHome(String(filePath || ''));
  if (!expanded) return json(res, 400, { ok: false, error: 'missing path' });
  const fullPath = path.resolve(expanded);
  if (!isImageFilePath(fullPath)) return json(res, 415, { ok: false, error: 'not image' });
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    return json(res, 404, { ok: false, error: 'not found' });
  }
  const body = fs.readFileSync(fullPath);
  res.writeHead(200, {
    'content-type': contentTypeForFile(fullPath),
    'content-length': body.length,
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=60',
  });
  res.end(body);
}

function text(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function isAuthorized(req) {
  if (!TOKEN) return true;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  return req.headers['x-vibego-token'] === TOKEN || url.searchParams.get('token') === TOKEN;
}

function requireAuth(req, res) {
  if (isAuthorized(req)) return true;
  json(res, 401, { ok: false, error: 'UNAUTHORIZED' });
  return false;
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`Request body too large (${maxBytes} bytes max)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buffer = await readBody(req);
  if (!buffer.length) return {};
  return JSON.parse(buffer.toString('utf8'));
}

function getProject(projectId = '') {
  const projects = config.projects || [];
  if (!projects.length) throw new Error('No projects configured');
  const found = projects.find((item) => item.id === projectId) || projects[0];
  return found;
}

function projectForPath(filePath) {
  const resolved = path.resolve(filePath);
  return (config.projects || []).find((project) => {
    const root = path.resolve(project.path);
    return resolved === root || resolved.startsWith(root + path.sep);
  }) || null;
}

function resolveProjectPath(projectId, targetPath = '') {
  const raw = String(targetPath || '');
  let project = getProject(projectId);
  if (!projectId && path.isAbsolute(raw)) {
    project = projectForPath(raw) || project;
  }
  const base = path.resolve(project.path);
  const resolved = path.resolve(path.isAbsolute(raw) ? raw : path.join(base, raw));
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error('Path is outside project root');
  }
  return { project, path: resolved };
}

function listDir(projectId, targetPath = '') {
  const resolved = resolveProjectPath(projectId, targetPath);
  const stat = fs.statSync(resolved.path);
  if (!stat.isDirectory()) throw new Error('Path is not a directory');
  const entries = fs.readdirSync(resolved.path, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.git'))
    .map((entry) => {
      const full = path.join(resolved.path, entry.name);
      const itemStat = fs.statSync(full);
      return {
        name: entry.name,
        path: full,
        relativePath: path.relative(resolved.project.path, full) || '.',
        type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
        size: itemStat.size,
        mtimeMs: itemStat.mtimeMs,
      };
    })
    .sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
  return { project: resolved.project, path: resolved.path, entries };
}

function readTextFile(projectId, targetPath) {
  const resolved = resolveProjectPath(projectId, targetPath);
  const stat = fs.statSync(resolved.path);
  if (!stat.isFile()) throw new Error('Path is not a file');
  if (stat.size > MAX_TEXT_FILE_BYTES) throw new Error(`File too large (${MAX_TEXT_FILE_BYTES} bytes max)`);
  return {
    project: resolved.project,
    path: resolved.path,
    relativePath: path.relative(resolved.project.path, resolved.path),
    text: fs.readFileSync(resolved.path, 'utf8'),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function writeTextFile(projectId, targetPath, value) {
  const resolved = resolveProjectPath(projectId, targetPath);
  fs.writeFileSync(resolved.path, String(value || ''), 'utf8');
  const stat = fs.statSync(resolved.path);
  return {
    project: resolved.project,
    path: resolved.path,
    relativePath: path.relative(resolved.project.path, resolved.path),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function cjkCount(value) {
  return (String(value || '').match(/[\u3400-\u9fff]/g) || []).length;
}

function maybeDecodeMojibake(value) {
  const raw = String(value || '');
  if (!raw) return raw;
  let decoded = raw;
  try {
    decoded = Buffer.from(raw, 'latin1').toString('utf8');
  } catch (_) {
    return raw;
  }
  if (!decoded || decoded.includes('\uFFFD') || decoded === raw) return raw;
  const hasMojibakeMarker = /[\u0080-\u009f]/.test(raw) || /[ÃÂÄÅÆÇÈÉäåæçèé][\u0080-\u00bf]/.test(raw);
  return hasMojibakeMarker || cjkCount(decoded) > cjkCount(raw) ? decoded : raw;
}

function decodeMultipartFilename(value) {
  const raw = String(value || '');
  if (!raw) return raw;
  const rfc5987 = raw.match(/^([^']*)''(.+)$/);
  if (rfc5987) {
    try {
      return decodeURIComponent(rfc5987[2]);
    } catch (_) {}
  }
  return maybeDecodeMojibake(raw);
}

function safeUploadName(name, fallback) {
  const fixedName = decodeMultipartFilename(name || fallback);
  const base = path.basename(String(fixedName || fallback)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  return base || fallback;
}

function uniquePath(dir, fileName) {
  const parsed = path.parse(fileName);
  let candidate = path.join(dir, fileName);
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${parsed.name}-${suffix}${parsed.ext}`);
    suffix += 1;
  }
  return candidate;
}

function inboxDir(projectId, _kind) {
  const project = getProject(projectId);
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const dir = path.join(__dirname, 'uploads', year, month);
  fs.mkdirSync(dir, { recursive: true });
  return { project, dir };
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw new Error('Missing multipart boundary');
  const boundary = `--${boundaryMatch[1] || boundaryMatch[2]}`;
  const raw = buffer.toString('binary');
  const parts = raw.split(boundary).slice(1, -1);
  const fields = {};
  const files = [];
  for (const part of parts) {
    const trimmed = part.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const sep = trimmed.indexOf('\r\n\r\n');
    if (sep < 0) continue;
    const headerText = trimmed.slice(0, sep);
    const bodyBinary = trimmed.slice(sep + 4);
    const dispositionLine = headerText.split(/\r?\n/).find((line) => /^content-disposition:/i.test(line)) || '';
    if (!dispositionLine) continue;
    const params = {};
    for (const match of dispositionLine.matchAll(/;\s*([^=;\s]+)="([^"]*)"/g)) {
      params[match[1].toLowerCase()] = match[2];
    }
    for (const match of dispositionLine.matchAll(/;\s*([^=;\s]+)=([^";\s][^;]*)/g)) {
      const key = match[1].toLowerCase();
      if (params[key] == null) params[key] = match[2].trim();
    }
    const name = params.name || '';
    const filename = params['filename*'] || params.filename || '';
    if (!name) continue;
    const mimeMatch = headerText.match(/content-type:\s*([^\r\n]+)/i);
    const body = Buffer.from(bodyBinary, 'binary');
    if (filename) {
      files.push({ fieldName: name, filename, mimeType: mimeMatch ? mimeMatch[1].trim() : 'application/octet-stream', data: body });
    } else {
      fields[name] = body.toString('utf8');
    }
  }
  return { fields, files };
}

async function saveMultipart(req, projectId, kind, expectedField, fallbackName) {
  const buffer = await readBody(req);
  const parsed = parseMultipart(buffer, req.headers['content-type']);
  const file = parsed.files.find((item) => item.fieldName === expectedField);
  if (!file) throw new Error(`Missing ${expectedField}`);
  const target = inboxDir(projectId || parsed.fields.projectId || '', kind);
  const name = safeUploadName(file.filename, fallbackName);
  const targetPath = uniquePath(target.dir, name);
  fs.writeFileSync(targetPath, file.data);
  return {
    project: target.project,
    fields: parsed.fields,
    file: {
      path: targetPath,
      name: path.basename(targetPath),
      mimeType: parsed.fields.mimeType || file.mimeType,
      size: file.data.length,
    },
  };
}

function walkJsonlFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonlFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function threadIdFromFile(file) {
  const match = path.basename(file).match(/([a-f0-9]{8}-[a-f0-9-]{27,})\.jsonl$/i);
  return match ? match[1] : '';
}

function readJsonlTail(file, maxBytes = HISTORY_TAIL_BYTES) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let textValue = buffer.toString('utf8');
    if (start > 0) {
      const index = textValue.indexOf('\n');
      textValue = index >= 0 ? textValue.slice(index + 1) : '';
    }
    return textValue.split('\n').filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

function readJsonlHead(file, maxBytes = 512 * 1024) {
  const stat = fs.statSync(file);
  const length = Math.min(stat.size, maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, 0);
    return buffer.toString('utf8').split('\n').filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

function readSessionHeader(file) {
  for (const item of readJsonlHead(file)) {
    if (item.type === 'session_meta' || item.type === 'session_meta_event') {
      const payload = item.payload || item;
      return {
        cwd: payload.cwd || payload.working_dir || '',
        timestamp: item.timestamp || payload.timestamp || '',
        model: payload.model || '',
      };
    }
  }
  const fallback = { cwd: '', timestamp: '', model: '' };
  for (const item of readJsonlTail(file, 512 * 1024)) {
    const payload = item.payload || {};
    if (item.type === 'turn_context' && payload.cwd && !fallback.cwd) {
      fallback.cwd = payload.cwd;
      fallback.timestamp = item.timestamp || '';
    }
  }
  return fallback;
}

function loadThreadNameIndex() {
  const byId = new Map();
  if (!fs.existsSync(CODEX_SESSION_INDEX)) return byId;
  const lines = fs.readFileSync(CODEX_SESSION_INDEX, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      const id = row.id || row.thread_id || row.threadId || row.conversation_id || '';
      if (!id) continue;
      byId.set(id, {
        id,
        name: row.thread_name || row.threadName || row.name || row.title || row.summary || '',
        updatedAt: row.updated_at || row.updatedAt || row.timestamp || '',
      });
    } catch {}
  }
  return byId;
}

function readThreadScopeOverrides() {
  if (!fs.existsSync(CODEX_THREAD_SCOPE_OVERRIDES_FILE)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(CODEX_THREAD_SCOPE_OVERRIDES_FILE, 'utf8'));
    const normalized = {};
    for (const [threadId, value] of Object.entries(raw || {})) {
      if (!isCodexThreadId(threadId) || !value || typeof value !== 'object') continue;
      const scope = String(value.scope || '').toLowerCase();
      if (scope !== 'direct' && scope !== 'project') continue;
      normalized[threadId] = {
        scope,
        projectId: String(value.projectId || ''),
        updatedAt: String(value.updatedAt || ''),
      };
    }
    return normalized;
  } catch {
    return {};
  }
}

function writeThreadScopeOverrides(overrides) {
  const dir = path.dirname(CODEX_THREAD_SCOPE_OVERRIDES_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${CODEX_THREAD_SCOPE_OVERRIDES_FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(overrides || {}, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, CODEX_THREAD_SCOPE_OVERRIDES_FILE);
}

function threadScopeOverride(threadId = '') {
  if (!isCodexThreadId(threadId)) return null;
  const overrides = readThreadScopeOverrides();
  return overrides[threadId] || null;
}

function persistThreadScopeOverride(threadId = '', scope = '', projectId = '') {
  if (!isCodexThreadId(threadId)) return null;
  const normalizedScope = String(scope || '').toLowerCase();
  const overrides = readThreadScopeOverrides();
  if (normalizedScope === 'direct') {
    overrides[threadId] = {
      scope: 'direct',
      projectId: '',
      updatedAt: new Date().toISOString(),
    };
  } else if (normalizedScope === 'project') {
    overrides[threadId] = {
      scope: 'project',
      projectId: String(projectId || ''),
      updatedAt: new Date().toISOString(),
    };
  } else {
    delete overrides[threadId];
  }
  writeThreadScopeOverrides(overrides);
  return overrides[threadId] || null;
}

function firstUserMessage(file) {
  for (const item of readJsonlTail(file, 2 * 1024 * 1024)) {
    const payload = item.payload || {};
    if (item.type === 'event_msg' && payload.type === 'user_message') {
      const textValue = cleanText(payload.message || '');
      if (textValue) return textValue.length > 80 ? `${textValue.slice(0, 80)}...` : textValue;
    }
  }
  return '';
}

function displayTitle(value, fallback = '未命名线程') {
  const title = String(value || fallback).replace(/\s+/g, ' ').trim() || fallback;
  return title.length > 72 ? `${title.slice(0, 72)}...` : title;
}

function isPathInside(base, target) {
  if (!base || !target) return false;
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(`${resolvedBase}${path.sep}`);
}

function isDirectCodexConversationCwd(cwd) {
  if (!cwd) return true;
  return isPathInside(CODEX_DIRECT_CWD_ROOT, cwd);
}

function projectForCwd(cwd) {
  if (isDirectCodexConversationCwd(cwd)) {
    return {
      id: CODEX_DIRECT_PROJECT_ID,
      name: CODEX_DIRECT_PROJECT_NAME,
      path: '',
    };
  }
  const resolved = path.resolve(cwd);
  return {
    id: `codex-${sanitizeId(resolved)}`,
    name: path.basename(resolved) || resolved,
    path: resolved,
  };
}

function projectForThread(threadId, cwd) {
  const override = threadScopeOverride(threadId);
  if (override) {
    if (override.scope === 'direct' && isDirectCodexConversationCwd(cwd)) return directCodexProject();
    if (override.scope === 'project') {
      const configured = findConfiguredProject(override.projectId);
      if (configured) return configured;
    }
  }
  return projectForCwd(cwd);
}

function readJsonlFull(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function parseJsonlLines(textValue) {
  const items = [];
  for (const line of textValue.split('\n').filter(Boolean)) {
    try {
      items.push(JSON.parse(line));
    } catch (error) {
      return { items, error };
    }
  }
  return { items, error: null };
}

function readJsonlFullComplete(file) {
  const buffer = fs.readFileSync(file);
  const textValue = buffer.toString('utf8');
  const endsWithNewline = textValue.endsWith('\n');
  const lastNewline = textValue.lastIndexOf('\n');
  const completeText = endsWithNewline || lastNewline < 0 ? textValue : textValue.slice(0, lastNewline + 1);
  const parsed = parseJsonlLines(completeText);
  if (parsed.error && !endsWithNewline && lastNewline < 0) {
    return { items: [], byteOffset: 0, error: null };
  }
  return {
    items: parsed.items,
    byteOffset: Buffer.byteLength(completeText),
    error: parsed.error,
  };
}

function readJsonlIncrement(file, byteOffset, stat) {
  const start = Math.max(0, Number(byteOffset) || 0);
  if (start >= stat.size) {
    return { items: [], byteOffset: start, error: null };
  }
  const length = stat.size - start;
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    const textValue = buffer.toString('utf8');
    const lastNewline = textValue.lastIndexOf('\n');
    if (lastNewline < 0) {
      return { items: [], byteOffset: start, error: null };
    }
    const completeText = textValue.slice(0, lastNewline + 1);
    const parsed = parseJsonlLines(completeText);
    return {
      items: parsed.items,
      byteOffset: start + Buffer.byteLength(completeText),
      error: parsed.error,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function timelineId(prefix, threadId, seq) {
  return `${prefix}-${threadId || 'thread'}-${seq}`;
}

function normalizeMessagePreview(textValue, max = 120) {
  return textPreview(textValue, max);
}

function buildChatMessage(threadId, seq, role, textValue, timestamp) {
  return {
    id: timelineId('msg', threadId, seq),
    role,
    label: role === 'user' ? 'You' : 'Codex',
    text: textValue,
    timestamp: timestamp || '',
  };
}

function codexImageResultToUploadPath(threadId, payload) {
  const raw = String(payload.result || payload.image || payload.data || '');
  if (!raw) return '';
  let mimeType = 'image/png';
  let base64 = raw;
  const dataUrlMatch = raw.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i);
  if (dataUrlMatch) {
    mimeType = dataUrlMatch[1].toLowerCase();
    base64 = dataUrlMatch[2];
  }
  const ext = mimeType === 'image/jpeg' || mimeType === 'image/jpg' ? '.jpg' : (mimeType === 'image/webp' ? '.webp' : '.png');
  const imageId = sanitizeId(payload.id || payload.call_id || crypto.createHash('sha1').update(base64.slice(0, 4096)).digest('hex'));
  const safeThreadId = sanitizeId(threadId || 'direct');
  const dir = path.join(__dirname, 'uploads', 'codex-images', safeThreadId);
  const fullPath = path.join(dir, `${imageId}${ext}`);
  const root = path.resolve(path.join(__dirname, 'uploads'));
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(root + path.sep)) return '';
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(fullPath)) {
      fs.writeFileSync(fullPath, Buffer.from(base64, 'base64'));
    }
    return `/uploads/codex-images/${encodeURIComponent(safeThreadId)}/${encodeURIComponent(`${imageId}${ext}`)}`;
  } catch (error) {
    debugError('codex.image.persist', error, { threadId, imageId });
    return '';
  }
}

function buildProcessEvent(threadId, seq, kind, type, textValue, time, extra = {}) {
  return {
    id: timelineId('proc', threadId, seq),
    kind,
    type,
    text: textValue,
    time: time || '',
    step: extra.step || '',
    callId: extra.callId || '',
    name: extra.name || '',
    status: extra.status || '',
  };
}

function parseCodexTimelineItems(items, threadId = '', options = {}) {
  const messages = [];
  const processEvents = [];
  let messageSeq = Math.max(0, Number(options.messageSeq) || 0);
  let processSeq = Math.max(0, Number(options.processSeq) || 0);
  const deferPendingAssistantMedia = options.deferPendingAssistantMedia === true;
  let currentTurn = options.openTurnStartedAt ? {
    startedAt: String(options.openTurnStartedAt || ''),
    hasAssistantFinal: options.openTurnHasAssistantFinal === true,
  } : null;
  let firstUserText = '';
  let active = currentTurn != null;
  let status = currentTurn != null ? 'running' : 'idle';
  let pendingAssistantMediaText = '';
  let pendingAssistantMediaTimestamp = '';
  const appendPendingAssistantMedia = (textValue, time) => {
    const clean = cleanText(textValue);
    if (!clean) return;
    pendingAssistantMediaText = pendingAssistantMediaText ? `${pendingAssistantMediaText}\n\n${clean}` : clean;
    if (!pendingAssistantMediaTimestamp) pendingAssistantMediaTimestamp = time || '';
  };
  const takePendingAssistantMedia = () => {
    const textValue = pendingAssistantMediaText;
    pendingAssistantMediaText = '';
    pendingAssistantMediaTimestamp = '';
    return textValue;
  };
  const combinedAssistantText = (textValue) => {
    const mediaText = takePendingAssistantMedia();
    const clean = cleanText(textValue);
    if (mediaText && clean) return `${mediaText}\n\n${clean}`;
    return mediaText || clean;
  };
  const flushPendingAssistantMedia = (time) => {
    const mediaTimestamp = pendingAssistantMediaTimestamp;
    const mediaText = takePendingAssistantMedia();
    if (mediaText) messages.push(buildChatMessage(threadId, messageSeq++, 'assistant', mediaText, time || mediaTimestamp || ''));
  };
  for (const item of items) {
    const payload = item.payload || {};
    const timestamp = item.timestamp || '';
    const failure = failureTextFromPayload(payload);
    if (failure) {
      processEvents.push(buildProcessEvent(
        threadId,
        processSeq++,
        'task_error',
        'task_error',
        failure,
        timestamp,
        { step: String(payload.type || ''), status: String(payload.status || ''), callId: payload.call_id || '' }
      ));
      active = false;
      status = 'error';
      if (item.type === 'event_msg' && payload.type === 'task_complete') currentTurn = null;
      continue;
    }
    if (item.type === 'event_msg') {
      if (payload.type === 'task_started') {
        flushPendingAssistantMedia(timestamp);
        processEvents.push(buildProcessEvent(threadId, processSeq++, 'task_started', 'task_started', '开始处理', timestamp));
        currentTurn = { startedAt: timestamp, hasAssistantFinal: false };
        active = true;
        status = 'running';
        continue;
      }
      if (payload.type === 'user_message') {
        flushPendingAssistantMedia(timestamp);
        const textValue = cleanText(payload.message || '');
        if (textValue) {
          messages.push(buildChatMessage(threadId, messageSeq++, 'user', textValue, timestamp));
          if (!firstUserText) firstUserText = textValue;
        }
        continue;
      }
      if (payload.type === 'agent_message') {
        const textValue = cleanText(payload.message || '');
        const phase = String(payload.phase || '');
        if (textValue && phase !== 'final_answer') {
          processEvents.push(buildProcessEvent(threadId, processSeq++, 'reasoning', 'reasoning', textValue, timestamp, { step: phase || 'commentary' }));
        }
        continue;
      }
      if (payload.type === 'task_complete') {
        if (currentTurn && !currentTurn.hasAssistantFinal) {
          const lastAgentMessage = cleanText(payload.last_agent_message || '');
          const textValue = combinedAssistantText(lastAgentMessage);
          if (textValue) {
            messages.push(buildChatMessage(threadId, messageSeq++, 'assistant', textValue, timestamp || currentTurn.startedAt || pendingAssistantMediaTimestamp || ''));
          }
        } else {
          flushPendingAssistantMedia(timestamp);
        }
        processEvents.push(buildProcessEvent(threadId, processSeq++, 'task_complete', 'task_complete', '回复完成', timestamp));
        currentTurn = null;
        active = false;
        status = 'complete';
        continue;
      }
    }
    if (item.type === 'response_item') {
      if (payload.type === 'reasoning') {
        const textValue = extractReasoningText(payload);
        if (textValue) {
          processEvents.push(buildProcessEvent(threadId, processSeq++, 'reasoning', 'reasoning', textValue, timestamp));
        }
        continue;
      }
      if (payload.type === 'function_call') {
        processEvents.push(buildProcessEvent(
          threadId,
          processSeq++,
          'tool_call',
          'tool_call',
          formatToolEvent(payload),
          timestamp,
          { callId: payload.call_id || '', name: payload.name || '' }
        ));
        continue;
      }
      if (payload.type === 'function_call_output') {
        processEvents.push(buildProcessEvent(
          threadId,
          processSeq++,
          'tool_result',
          'tool_result',
          '工具返回结果',
          timestamp,
          { callId: payload.call_id || '' }
        ));
        continue;
      }
      if (payload.type === 'image_generation_call') {
        const imagePath = codexImageResultToUploadPath(threadId, payload);
        if (imagePath) {
          appendPendingAssistantMedia(`![生成图片](${imagePath})`, timestamp);
        }
        continue;
      }
      if (payload.type === 'message' && payload.role === 'assistant') {
        const textValue = cleanText(extractMessageText(payload.content));
        if (!textValue) {
          flushPendingAssistantMedia(timestamp);
          continue;
        }
        if (!payload.phase || payload.phase === 'final_answer') {
          const mergedText = combinedAssistantText(textValue);
          messages.push(buildChatMessage(threadId, messageSeq++, 'assistant', mergedText, timestamp || pendingAssistantMediaTimestamp || ''));
          if (currentTurn) currentTurn.hasAssistantFinal = true;
        }
      }
    }
  }
  const pendingAssistantMediaDeferred = (
    deferPendingAssistantMedia &&
    pendingAssistantMediaText.length > 0 &&
    currentTurn != null &&
    currentTurn.hasAssistantFinal !== true
  );
  if (!pendingAssistantMediaDeferred) {
    flushPendingAssistantMedia('');
  }
  return {
    messages,
    processEvents,
    firstUserText,
    active,
    status,
    openTurnStartedAt: currentTurn ? currentTurn.startedAt : '',
    openTurnHasAssistantFinal: currentTurn ? currentTurn.hasAssistantFinal === true : false,
    pendingAssistantMediaDeferred,
  };
}

function quickRuntime(file) {
  const threadId = threadIdFromFile(file);
  const timeline = parseCodexTimelineItems(readJsonlTail(file, STATUS_TAIL_BYTES), threadId);
  return { active: timeline.active, status: timeline.status };
}

function quickThreadSummary(file) {
  const threadId = threadIdFromFile(file);
  const timeline = parseCodexTimelineItems(readJsonlTail(file, STATUS_TAIL_BYTES), threadId);
  const lastMessage = timeline.messages.length ? timeline.messages[timeline.messages.length - 1] : null;
  return {
    preview: lastMessage ? normalizeMessagePreview(lastMessage.text) : '',
    previewRole: lastMessage ? lastMessage.role : '',
    lastMessageAt: lastMessage ? lastMessage.timestamp : '',
    messageCount: timeline.messages.length,
    runtimeStatus: timeline.status,
    runtimeActive: timeline.active,
    firstUserText: timeline.firstUserText,
  };
}

function buildThreadSummary({ file, threadId, stat, meta, project, indexed, preview, previewRole, lastMessageAt, messageCount, runtimeStatus, runtimeActive, firstUserTextValue = '' }) {
  const title = displayTitle(indexed.name || firstUserTextValue || firstUserMessage(file) || '未命名线程');
  const updatedAt = lastMessageAt || indexed.updatedAt || meta.timestamp || new Date(stat.mtimeMs).toISOString();
  return {
    id: threadId,
    title,
    name: title,
    cwd: project && project.id === CODEX_DIRECT_PROJECT_ID ? '' : meta.cwd,
    projectId: project ? project.id : '',
    projectName: project ? project.name : '对话',
    sessionFile: path.basename(file),
    updatedAt,
    lastMessageAt,
    preview,
    previewRole,
    messageCount,
    mtimeMs: stat.mtimeMs,
    runtimeStatus,
    runtimeActive,
  };
}

function buildThreadCursor(threadId, file, stat, messages, processEvents, extra = {}) {
  return {
    threadId,
    sessionFile: path.basename(file),
    messageCount: messages.length,
    processCount: processEvents.length,
    fileSize: stat.size,
    byteOffset: Math.max(0, Number(extra.byteOffset) || stat.size),
    updatedAt: new Date(stat.mtimeMs).toISOString(),
    openTurnStartedAt: String(extra.openTurnStartedAt || ''),
    openTurnHasAssistantFinal: extra.openTurnHasAssistantFinal === true,
  };
}

function normalizeSnapshotProcessLimit(value) {
  if (value === undefined || value === null || value === '') return null;
  const limit = Number(value);
  if (!Number.isFinite(limit)) return null;
  return Math.max(0, Math.floor(limit));
}

function limitProcessEventsForSnapshot(processEvents, processLimit) {
  if (processLimit === null || processLimit === undefined) return processEvents;
  if (processLimit <= 0) return [];
  return processEvents.slice(-processLimit);
}

function parseCodexThreadSnapshot(threadId, options = {}) {
  const file = findSessionFile(threadId);
  if (!file) {
    return {
      ok: true,
      available: false,
      threadId,
      sessionFile: '',
      summary: null,
      threadSummary: null,
      messages: [],
      processEvents: [],
      cursor: null,
      active: false,
      status: 'missing',
      error: '',
    };
  }
  const stat = fs.statSync(file);
  const meta = readSessionHeader(file);
  const indexed = loadThreadNameIndex().get(threadId) || {};
  const project = projectForThread(threadId, meta.cwd);
  const full = readJsonlFullComplete(file);
  if (full.error) {
    return {
      ok: true,
      available: false,
      threadId,
      sessionFile: path.basename(file),
      summary: null,
      threadSummary: null,
      messages: [],
      processEvents: [],
      cursor: null,
      active: false,
      status: 'parse-failed',
      error: String(full.error && full.error.message || full.error),
    };
  }
  const timeline = parseCodexTimelineItems(full.items, threadId);
  const lastMessage = timeline.messages.length ? timeline.messages[timeline.messages.length - 1] : null;
  const summary = buildThreadSummary({
    file,
    threadId,
    stat,
    meta,
    project,
    indexed,
    preview: lastMessage ? normalizeMessagePreview(lastMessage.text) : '',
    previewRole: lastMessage ? lastMessage.role : '',
    lastMessageAt: lastMessage ? lastMessage.timestamp : '',
    messageCount: timeline.messages.length,
    runtimeStatus: timeline.status,
    runtimeActive: timeline.active,
    firstUserTextValue: timeline.firstUserText,
  });
  const cursor = buildThreadCursor(threadId, file, stat, timeline.messages, timeline.processEvents, {
    byteOffset: full.byteOffset,
    openTurnStartedAt: timeline.openTurnStartedAt,
    openTurnHasAssistantFinal: timeline.openTurnHasAssistantFinal,
  });
  const processLimit = normalizeSnapshotProcessLimit(options.processLimit);
  return {
    ok: true,
    available: true,
    threadId,
    sessionFile: path.basename(file),
    summary,
    threadSummary: summary,
    messages: timeline.messages,
    processEvents: limitProcessEventsForSnapshot(timeline.processEvents, processLimit),
    cursor,
    active: timeline.active,
    status: timeline.status,
    error: '',
  };
}

function parseCodexThreadUpdates(options = {}) {
  const threadId = String(options.threadId || '');
  const requestedSessionFile = String(options.sessionFile || '');
  const cursorMessageCount = Math.max(0, Number(options.messageCount) || 0);
  const cursorProcessCount = Math.max(0, Number(options.processCount) || 0);
  const cursorFileSize = Math.max(0, Number(options.fileSize) || 0);
  const cursorByteOffset = Math.max(0, Number(options.byteOffset) || 0);
  const openTurnStartedAt = String(options.openTurnStartedAt || '');
  const openTurnHasAssistantFinal = String(options.openTurnHasAssistantFinal || '') === 'true';
  const file = findSessionFile(threadId);
  if (!file) {
    return {
      ok: true,
      available: false,
      reset: false,
      threadId,
      sessionFile: '',
      summary: null,
      threadSummary: null,
      messagesDelta: [],
      processEventsDelta: [],
      cursor: null,
      active: false,
      status: 'missing',
      error: '',
    };
  }
  const stat = fs.statSync(file);
  const sessionFile = path.basename(file);
  const reset = (
    (requestedSessionFile && requestedSessionFile !== sessionFile) ||
    cursorFileSize > stat.size ||
    cursorByteOffset > stat.size ||
    (cursorByteOffset <= 0 && (cursorMessageCount > 0 || cursorProcessCount > 0))
  );
  if (reset) {
    const quickSummary = quickThreadSummary(file);
    const meta = readSessionHeader(file);
    const summary = buildThreadSummary({
      file,
      threadId,
      stat,
      meta,
      project: projectForThread(threadId, meta.cwd),
      indexed: loadThreadNameIndex().get(threadId) || {},
      preview: quickSummary.preview,
      previewRole: quickSummary.previewRole,
      lastMessageAt: quickSummary.lastMessageAt,
      messageCount: quickSummary.messageCount,
      runtimeStatus: quickSummary.runtimeStatus,
      runtimeActive: quickSummary.runtimeActive,
      firstUserTextValue: quickSummary.firstUserText,
    });
    return {
      ok: true,
      available: true,
      reset: true,
      threadId,
      sessionFile,
      summary,
      threadSummary: summary,
      messagesDelta: [],
      processEventsDelta: [],
      cursor: null,
      active: quickSummary.runtimeActive,
      status: quickSummary.runtimeStatus,
      error: '',
    };
  }
  if (cursorByteOffset >= stat.size && cursorMessageCount > 0) {
    const full = readJsonlFullComplete(file);
    if (!full.error) {
      const fullTimeline = parseCodexTimelineItems(full.items, threadId, {
        openTurnStartedAt,
        openTurnHasAssistantFinal,
      });
      if (cursorMessageCount > fullTimeline.messages.length) {
        const meta = readSessionHeader(file);
        const lastMessage = fullTimeline.messages.length ? fullTimeline.messages[fullTimeline.messages.length - 1] : null;
        const summary = buildThreadSummary({
          file,
          threadId,
          stat,
          meta,
          project: projectForThread(threadId, meta.cwd),
          indexed: loadThreadNameIndex().get(threadId) || {},
          preview: lastMessage ? normalizeMessagePreview(lastMessage.text) : '',
          previewRole: lastMessage ? lastMessage.role : '',
          lastMessageAt: lastMessage ? lastMessage.timestamp : '',
          messageCount: fullTimeline.messages.length,
          runtimeStatus: fullTimeline.status,
          runtimeActive: fullTimeline.active,
          firstUserTextValue: fullTimeline.firstUserText,
        });
        return {
          ok: true,
          available: true,
          reset: true,
          threadId,
          sessionFile,
          summary,
          threadSummary: summary,
          messagesDelta: [],
          processEventsDelta: [],
          cursor: null,
          active: fullTimeline.active,
          status: fullTimeline.status,
          error: '',
        };
      }
    }
  }
  if (cursorByteOffset >= stat.size) {
    const stillActive = openTurnStartedAt.length > 0;
    return {
      ok: true,
      available: true,
      reset: false,
      threadId,
      sessionFile,
      summary: null,
      threadSummary: null,
      messagesDelta: [],
      processEventsDelta: [],
      cursor: {
        threadId,
        sessionFile,
        messageCount: cursorMessageCount,
        processCount: cursorProcessCount,
        fileSize: stat.size,
        byteOffset: cursorByteOffset,
        updatedAt: new Date(stat.mtimeMs).toISOString(),
        openTurnStartedAt,
        openTurnHasAssistantFinal,
      },
      active: stillActive,
      status: stillActive ? 'running' : 'idle',
      error: '',
    };
  }
  const increment = readJsonlIncrement(file, cursorByteOffset, stat);
  if (increment.error) {
    const quickSummary = quickThreadSummary(file);
    const meta = readSessionHeader(file);
    const summary = buildThreadSummary({
      file,
      threadId,
      stat,
      meta,
      project: projectForThread(threadId, meta.cwd),
      indexed: loadThreadNameIndex().get(threadId) || {},
      preview: quickSummary.preview,
      previewRole: quickSummary.previewRole,
      lastMessageAt: quickSummary.lastMessageAt,
      messageCount: quickSummary.messageCount,
      runtimeStatus: quickSummary.runtimeStatus,
      runtimeActive: quickSummary.runtimeActive,
      firstUserTextValue: quickSummary.firstUserText,
    });
    return {
      ok: true,
      available: true,
      reset: true,
      threadId,
      sessionFile,
      summary,
      threadSummary: summary,
      messagesDelta: [],
      processEventsDelta: [],
      cursor: null,
      active: quickSummary.runtimeActive,
      status: quickSummary.runtimeStatus,
      error: String(increment.error && increment.error.message || increment.error),
    };
  }
  if (increment.byteOffset === cursorByteOffset && increment.items.length === 0) {
    const stillActive = openTurnStartedAt.length > 0;
    return {
      ok: true,
      available: true,
      reset: false,
      threadId,
      sessionFile,
      summary: null,
      threadSummary: null,
      messagesDelta: [],
      processEventsDelta: [],
      cursor: {
        threadId,
        sessionFile,
        messageCount: cursorMessageCount,
        processCount: cursorProcessCount,
        fileSize: stat.size,
        byteOffset: cursorByteOffset,
        updatedAt: new Date(stat.mtimeMs).toISOString(),
        openTurnStartedAt,
        openTurnHasAssistantFinal,
      },
      active: stillActive,
      status: stillActive ? 'running' : 'idle',
      error: '',
    };
  }
  const timeline = parseCodexTimelineItems(increment.items, threadId, {
    messageSeq: cursorMessageCount,
    processSeq: cursorProcessCount,
    openTurnStartedAt,
    openTurnHasAssistantFinal,
    deferPendingAssistantMedia: true,
  });
  if (timeline.pendingAssistantMediaDeferred === true) {
    return {
      ok: true,
      available: true,
      reset: false,
      threadId,
      sessionFile,
      summary: null,
      threadSummary: null,
      messagesDelta: [],
      processEventsDelta: [],
      cursor: {
        threadId,
        sessionFile,
        messageCount: cursorMessageCount,
        processCount: cursorProcessCount,
        fileSize: cursorFileSize,
        byteOffset: cursorByteOffset,
        updatedAt: new Date(stat.mtimeMs).toISOString(),
        openTurnStartedAt: timeline.openTurnStartedAt,
        openTurnHasAssistantFinal: timeline.openTurnHasAssistantFinal,
      },
      active: true,
      status: 'running',
      error: '',
    };
  }
  const messageCount = cursorMessageCount + timeline.messages.length;
  const processCount = cursorProcessCount + timeline.processEvents.length;
  const cursor = {
    threadId,
    sessionFile,
    messageCount,
    processCount,
    fileSize: stat.size,
    byteOffset: increment.byteOffset,
    updatedAt: new Date(stat.mtimeMs).toISOString(),
    openTurnStartedAt: timeline.openTurnStartedAt,
    openTurnHasAssistantFinal: timeline.openTurnHasAssistantFinal,
  };
  let summary = null;
  if (timeline.messages.length > 0 || timeline.processEvents.length > 0 || increment.byteOffset !== cursorByteOffset) {
    const quickSummary = quickThreadSummary(file);
    const meta = readSessionHeader(file);
    const lastMessage = timeline.messages.length ? timeline.messages[timeline.messages.length - 1] : null;
    summary = buildThreadSummary({
      file,
      threadId,
      stat,
      meta,
      project: projectForThread(threadId, meta.cwd),
      indexed: loadThreadNameIndex().get(threadId) || {},
      preview: lastMessage ? normalizeMessagePreview(lastMessage.text) : quickSummary.preview,
      previewRole: lastMessage ? lastMessage.role : quickSummary.previewRole,
      lastMessageAt: lastMessage ? lastMessage.timestamp : quickSummary.lastMessageAt,
      messageCount,
      runtimeStatus: timeline.status,
      runtimeActive: timeline.active,
      firstUserTextValue: quickSummary.firstUserText,
    });
  }
  return {
    ok: true,
    available: true,
    reset: false,
    threadId,
    sessionFile,
    summary,
    threadSummary: summary,
    messagesDelta: timeline.messages,
    processEventsDelta: timeline.processEvents,
    cursor,
    active: timeline.active,
    status: timeline.status,
    error: '',
  };
}

function listSessionThreadSummaries(projectId = '', limit = 500) {
  const files = walkJsonlFiles(CODEX_SESSIONS_DIR);
  const index = loadThreadNameIndex();
  const rows = [];
  for (const file of files) {
    const id = threadIdFromFile(file);
    if (!id) continue;
    try {
      const stat = fs.statSync(file);
      const meta = readSessionHeader(file);
      const project = projectForThread(id, meta.cwd);
      if (projectId && (!project || project.id !== projectId)) continue;
      const indexed = index.get(id) || {};
      const quickSummary = quickThreadSummary(file);
      rows.push(buildThreadSummary({
        file,
        threadId: id,
        stat,
        meta,
        project,
        indexed,
        preview: quickSummary.preview,
        previewRole: quickSummary.previewRole,
        lastMessageAt: quickSummary.lastMessageAt,
        messageCount: quickSummary.messageCount,
        runtimeStatus: quickSummary.runtimeStatus,
        runtimeActive: quickSummary.runtimeActive,
        firstUserTextValue: quickSummary.firstUserText,
      }));
    } catch {}
  }
  return rows
    .sort((a, b) => Math.max(Date.parse(b.updatedAt) || 0, b.mtimeMs) - Math.max(Date.parse(a.updatedAt) || 0, a.mtimeMs))
    .slice(0, Math.max(1, Math.min(Number(limit) || 500, 1000)));
}

function getCodexProject(projectId = '', threadId = '') {
  return getCodexProjectForScope(projectId, threadId, '');
}

function directCodexProject() {
  return {
    id: CODEX_DIRECT_PROJECT_ID,
    name: CODEX_DIRECT_PROJECT_NAME,
    path: '',
  };
}

function findConfiguredProject(projectId = '') {
  if (!projectId) return null;
  return (config.projects || []).find((project) => project.id === projectId) || null;
}

function findKnownCodexProject(projectId = '') {
  const configured = findConfiguredProject(projectId);
  if (configured) return configured;
  for (const item of lastCodexSidebarSnapshot.projects || []) {
    const project = projectFromCodexSidebarProject(item.rawId || item.path || '', item.name || '');
    if (project.id === projectId) return project;
  }
  for (const thread of listSessionThreadSummaries('', 1000)) {
    if (thread.projectId === projectId && thread.cwd) {
      return {
        id: thread.projectId,
        name: thread.projectName || path.basename(thread.cwd) || thread.cwd,
        path: path.resolve(thread.cwd),
      };
    }
  }
  return null;
}

function projectFromThreadSummary(summary) {
  const projectId = String(summary && summary.projectId || '');
  const cwd = String(summary && summary.cwd || '').trim();
  if (projectId === CODEX_DIRECT_PROJECT_ID || !cwd) return directCodexProject();
  const resolved = path.resolve(cwd);
  return {
    id: projectId || `codex-${sanitizeId(resolved)}`,
    name: String(summary && summary.projectName || '') || path.basename(resolved) || resolved,
    path: resolved,
  };
}

function assertRequestedProjectMatchesThread(requestedProjectId = '', threadSummary = null) {
  const expectedProjectId = String(threadSummary && threadSummary.projectId || '');
  const actualProjectId = String(requestedProjectId || '');
  if (!actualProjectId || !expectedProjectId || actualProjectId === expectedProjectId) return;
  const message = `当前会话属于 ${expectedProjectId}，但 App 请求发送到 ${actualProjectId}，已拦截以避免发到错误目录。`;
  const error = new Error(message);
  error.code = 'CODEX_THREAD_PROJECT_MISMATCH';
  error.expectedProjectId = expectedProjectId;
  error.requestedProjectId = actualProjectId;
  error.threadCwd = String(threadSummary && threadSummary.cwd || '');
  throw error;
}

function getCodexProjectForScope(projectId = '', threadId = '', newThreadScope = '') {
  if (!threadId) {
    if (newThreadScope === 'direct' || projectId === CODEX_DIRECT_PROJECT_ID || (!newThreadScope && !projectId)) {
      return directCodexProject();
    }
    if (newThreadScope === 'project' || projectId) {
      const configured = findKnownCodexProject(projectId);
      if (configured) return configured;
      const threads = listSessionThreadSummaries('', 200);
      const matched = threads.find((thread) => thread.projectId === projectId && thread.cwd);
      if (matched && matched.cwd) {
        return {
          id: matched.projectId || `codex-${sanitizeId(path.resolve(matched.cwd))}`,
          name: matched.projectName || path.basename(matched.cwd) || matched.cwd,
          path: path.resolve(matched.cwd),
        };
      }
      throw new Error(projectId ? `Unknown projectId: ${projectId}` : 'Missing projectId for project-scoped new thread');
    }
    return directCodexProject();
  }
  const snapshot = parseCodexThreadSnapshot(threadId, { processLimit: 0 });
  const summary = snapshot && (snapshot.summary || snapshot.threadSummary);
  if (!snapshot || snapshot.available !== true || !summary || !summary.id) {
    throw new Error(`Unknown threadId: ${threadId}`);
  }
  assertRequestedProjectMatchesThread(projectId, summary);
  return projectFromThreadSummary(summary);
}

function findSessionFile(threadId) {
  return walkJsonlFiles(CODEX_SESSIONS_DIR).find((file) => threadIdFromFile(file) === threadId) || '';
}

function isCodexThreadId(value) {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(value);
}

function findSessionFileByName(name) {
  const value = String(name || '');
  if (!value || value.includes('/') || value.includes('..')) return '';
  return walkJsonlFiles(CODEX_SESSIONS_DIR).find((file) => path.basename(file) === value) || '';
}

function findLatestSessionFile(options = {}) {
  const afterMs = Number(options.afterMs || 0);
  const excludeThreadId = isCodexThreadId(options.excludeThreadId) ? options.excludeThreadId : '';
  const expectedCwd = path.resolve(String(options.cwd || '') || os.homedir());
  const needsCwd = Boolean(options.cwd);
  const files = walkJsonlFiles(CODEX_SESSIONS_DIR);
  let best = null;
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      const threadId = threadIdFromFile(file);
      if (excludeThreadId && threadId === excludeThreadId) continue;
      if (afterMs && stat.mtimeMs < afterMs - 2500) continue;
      if (needsCwd) {
        const meta = readSessionHeader(file);
        const metaCwd = meta.cwd ? path.resolve(meta.cwd) : '';
        if (metaCwd !== expectedCwd) continue;
      }
      if (!best || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs };
    } catch {}
  }
  return best ? best.file : '';
}

function normalizeReceiptText(value) {
  return cleanText(value).replace(/\s+/g, ' ').trim();
}

function scoreReceiptText(expected, actual) {
  if (!expected) return actual ? 24 : 8;
  if (!actual) return -1;
  if (actual === expected) return 120;
  if (actual.includes(expected) || expected.includes(actual)) return 82;
  const expectedPrefix = expected.slice(0, 80);
  const actualPrefix = actual.slice(0, 80);
  return expectedPrefix && actualPrefix && expectedPrefix === actualPrefix ? 54 : 18;
}

function receiptTimeScore(timestamp, sinceMs = 0) {
  const eventMs = Date.parse(timestamp || '');
  if (!Number.isFinite(eventMs)) return sinceMs ? 0 : 10;
  if (sinceMs && eventMs < sinceMs - 2500) return -1;
  if (!sinceMs) return 18;
  const deltaSec = Math.round((eventMs - sinceMs) / 1000);
  return Math.max(0, Math.min(30, deltaSec + 24));
}

function scoreReceiptCandidate(file, sinceMs = 0, textValue = '') {
  const expected = normalizeReceiptText(textValue);
  let best = 0;
  const recentItems = readJsonlTail(file, 2 * 1024 * 1024);
  for (const item of recentItems) {
    const payload = item && item.payload ? item.payload : {};
    if (item.type !== 'event_msg' || payload.type !== 'user_message') continue;
    const timeScore = receiptTimeScore(item.timestamp, sinceMs);
    if (timeScore < 0) continue;
    const textScore = scoreReceiptText(expected, normalizeReceiptText(payload.message || ''));
    if (textScore < 0) continue;
    best = Math.max(best, textScore + timeScore);
  }
  return best;
}

function findUserMessageIndex(items, sinceMs = 0, textValue = '') {
  const expected = normalizeReceiptText(textValue);
  let fallbackIndex = -1;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const payload = item.payload || {};
    if (item.type !== 'event_msg' || payload.type !== 'user_message') continue;
    const t = Date.parse(item.timestamp || '');
    if (sinceMs && Number.isFinite(t) && t < sinceMs - 2500) continue;
    if (fallbackIndex < 0) fallbackIndex = index;
    if (!expected) continue;
    const actual = normalizeReceiptText(payload.message || '');
    if (actual === expected || actual.includes(expected) || expected.includes(actual)) return index;
  }
  return fallbackIndex;
}

function sliceItemsForSend(items, sinceMs = 0, textValue = '') {
  if (!sinceMs && !textValue) return items;
  const startIndex = findUserMessageIndex(items, sinceMs, textValue);
  if (startIndex < 0) {
    return sinceMs ? items.filter((item) => {
      const t = Date.parse(item.timestamp || '');
      return !Number.isFinite(t) || t >= sinceMs - 2500;
    }) : items;
  }
  let endIndex = items.length;
  for (let index = startIndex + 1; index < items.length; index++) {
    const item = items[index];
    const payload = item.payload || {};
    if (item.type === 'event_msg' && payload.type === 'task_complete') {
      endIndex = index + 1;
      break;
    }
  }
  return items.slice(startIndex, endIndex);
}

function findSessionFileForNewSend(options = {}) {
  const sinceMs = Number(options.sinceMs || 0);
  const textValue = String(options.text || '');
  const expectedCwd = options.cwd ? path.resolve(String(options.cwd)) : '';
  const excludeThreadId = isCodexThreadId(options.excludeThreadId) ? options.excludeThreadId : '';
  const files = walkJsonlFiles(CODEX_SESSIONS_DIR);
  debugLog('codex.findSessionForNewSend.start', {
    sinceMs,
    cwd: expectedCwd,
    excludeThreadId,
    textLength: textValue.length,
    files: files.length,
  });
  let best = null;
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      const threadId = threadIdFromFile(file);
      if (excludeThreadId && threadId === excludeThreadId) continue;
      if (sinceMs && stat.mtimeMs < sinceMs - 2500) continue;
      const receiptScore = scoreReceiptCandidate(file, sinceMs, textValue);
      if (receiptScore <= 0 && textValue.trim()) continue;
      let score = receiptScore;
      if (expectedCwd) {
        const meta = readSessionHeader(file);
        const metaCwd = meta.cwd ? path.resolve(meta.cwd) : '';
        if (metaCwd !== expectedCwd) continue;
        score += 35;
      }
      if (sinceMs) score += Math.max(0, Math.min(20, Math.round((stat.mtimeMs - sinceMs) / 1000) + 10));
      if (!best || score > best.score || (score === best.score && stat.mtimeMs > best.mtimeMs)) {
        best = { file, score, mtimeMs: stat.mtimeMs };
      }
    } catch {}
  }
  debugLog('codex.findSessionForNewSend.done', {
    found: Boolean(best),
    sessionFile: best ? path.basename(best.file) : '',
    threadId: best ? threadIdFromFile(best.file) : '',
    score: best ? best.score : 0,
  });
  return best ? best.file : '';
}

async function waitForSessionFileForNewSend(options = {}, timeoutMs = ACCEPT_TIMEOUT_MS) {
  debugLog('codex.waitNewSession.start', { timeoutMs, cwd: options.cwd || '', excludeThreadId: options.excludeThreadId || '' });
  const deadline = Date.now() + timeoutMs;
  let file = '';
  while (Date.now() <= deadline) {
    file = findSessionFileForNewSend(options);
    if (file) {
      debugLog('codex.waitNewSession.accepted', { sessionFile: path.basename(file), threadId: threadIdFromFile(file) });
      return file;
    }
    await delay(220);
  }
  file = findSessionFileForNewSend(options);
  debugLog('codex.waitNewSession.done', { found: Boolean(file), sessionFile: file ? path.basename(file) : '' });
  return file;
}

async function waitForUserMessageInFile(file, sinceMs, textValue, timeoutMs = ACCEPT_TIMEOUT_MS) {
  debugLog('codex.waitUserMessage.start', {
    sessionFile: file ? path.basename(file) : '',
    threadId: file ? threadIdFromFile(file) : '',
    sinceMs,
    textLength: String(textValue || '').length,
    timeoutMs,
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const score = file ? scoreReceiptCandidate(file, sinceMs, textValue) : 0;
    if (score > 0) {
      debugLog('codex.waitUserMessage.accepted', { sessionFile: path.basename(file), score });
      return true;
    }
    await delay(220);
  }
  const finalScore = file ? scoreReceiptCandidate(file, sinceMs, textValue) : 0;
  debugLog('codex.waitUserMessage.done', { accepted: finalScore > 0, sessionFile: file ? path.basename(file) : '', score: finalScore });
  return Boolean(finalScore > 0);
}

function pushSendEvent(sendId, kind, textValue, extra = {}) {
  if (!sendId) return null;
  const record = recentSends.get(sendId);
  if (!record) return null;
  const event = { kind, type: kind, text: textValue, time: new Date().toISOString(), ...extra };
  record.events.push(event);
  record.updatedAt = Date.now();
  return event;
}

function cleanupRecentSends() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [sendId, record] of recentSends) {
    if ((record.updatedAt || record.createdAt || 0) < cutoff) recentSends.delete(sendId);
  }
}

function createSendRecord({ clientRequestId, project, threadId, textValue, newThreadScope }) {
  cleanupRecentSends();
  const sendId = clientRequestId || crypto.randomUUID();
  const existing = recentSends.get(sendId);
  if (existing) return existing;
  const since = new Date(Date.now() - 750).toISOString();
  const sinceMs = Date.parse(since) || Date.now();
  const expectNewThread = !threadId;
  const scope = String(newThreadScope || '');
  const watchCwd = expectNewThread && scope === 'project' ? project.path : '';
  const excludeThreadId = expectNewThread && watchCwd ? (threadIdFromFile(findLatestSessionFile({ cwd: watchCwd })) || '') : '';
  const sessionFile = expectNewThread ? '' : findSessionFile(threadId);
  const watch = {
    sendId,
    since,
    threadId,
    sessionFile: sessionFile ? path.basename(sessionFile) : '',
    expectNewThread,
    excludeThreadId,
    cwd: watchCwd,
  };
  const record = {
    sendId,
    clientRequestId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sinceMs,
    projectId: project.id,
    textValue,
    newThreadScope: scope,
    accepted: false,
    threadId,
    sessionFile,
    watch,
    events: [],
  };
  recentSends.set(sendId, record);
  pushSendEvent(sendId, 'send_step', '准备发送到 Codex', { step: 'prepare' });
  debugLog('codex.sendRecord.created', {
    sendId,
    clientRequestId,
    projectId: project.id,
    threadId,
    newThreadScope: scope,
    expectNewThread,
    excludeThreadId,
    sessionFile: watch.sessionFile,
    cwd: watch.cwd,
    textLength: textValue.length,
    textPreview: textPreview(textValue),
  });
	return record;
}

function rememberPreparedCodexNewThread(scope, project) {
	const normalizedScope = scope === 'project' ? 'project' : 'direct';
	preparedCodexNewThread = {
		id: crypto.randomUUID(),
		scope: normalizedScope,
		projectId: normalizedScope === 'project' ? project.id : CODEX_DIRECT_PROJECT_ID,
		projectName: normalizedScope === 'project' ? project.name : CODEX_DIRECT_PROJECT_NAME,
		cwd: normalizedScope === 'project' ? project.path : '',
		createdAt: Date.now(),
	};
	return preparedCodexNewThread;
}

function consumePreparedCodexNewThread(scope, projectId) {
	if (!preparedCodexNewThread) return null;
	if (Date.now() - preparedCodexNewThread.createdAt > PREPARED_CODEX_NEW_THREAD_TTL_MS) {
		preparedCodexNewThread = null;
		return null;
	}
	const normalizedScope = scope === 'project' ? 'project' : 'direct';
	const expectedProjectId = normalizedScope === 'project' ? projectId : CODEX_DIRECT_PROJECT_ID;
	if (preparedCodexNewThread.scope !== normalizedScope || preparedCodexNewThread.projectId !== expectedProjectId) return null;
	const prepared = preparedCodexNewThread;
	preparedCodexNewThread = null;
	return prepared;
}

function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((item) => item && (item.text || item.message || '')).filter(Boolean).join('\n');
}

function cleanText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function extractReasoningText(payload) {
  const collectText = (value, keys) => {
    if (typeof value === 'string') return [value];
    if (!value || typeof value !== 'object') return [];
    for (const key of keys) {
      if (typeof value[key] === 'string') return [value[key]];
    }
    return [];
  };
  const rows = [
    ...(Array.isArray(payload.summary) ? payload.summary.flatMap((item) => collectText(item, ['text', 'summary'])) : []),
    ...(Array.isArray(payload.content) ? payload.content.flatMap((item) => collectText(item, ['text'])) : []),
    ...collectText(payload, ['text']),
  ];
  return cleanText(rows.filter(Boolean).join('\n'));
}

function formatToolEvent(payload) {
  const name = String(payload.name || 'tool').split('.').pop();
  let args = payload.arguments || payload.input || '';
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch {}
  }
  if (name === 'exec_command' && args && typeof args === 'object' && args.cmd) return `运行命令：${String(args.cmd).split('\n')[0].slice(0, 120)}`;
  if (name === 'apply_patch') return '编辑文件';
  return `调用工具：${name}`;
}

function failureTextFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const type = String(payload.type || '').toLowerCase();
  const status = String(payload.status || '').toLowerCase();
  const code = String(payload.code || '').toLowerCase();
  const looksBad = /error|fail|failed|failure|timeout|abort|cancel|interrupt|unavailable|overload/.test(`${type} ${status} ${code}`) || payload.error || payload.detail || payload.reason;
  if (!looksBad) return '';
  return cleanText(payload.message || payload.error || payload.detail || payload.reason || payload.code || payload.type || 'Codex 运行失败');
}

function codexEventFromItem(item) {
  const payload = item.payload || {};
  if (item.type === 'event_msg') {
    if (payload.type === 'user_message') return { kind: 'user_message_received', type: 'user_message_received', text: 'Codex 已接收消息', time: item.timestamp || '' };
    if (payload.type === 'task_started') return { kind: 'task_started', type: 'task_started', text: '开始处理', time: item.timestamp || '' };
    if (payload.type === 'task_complete') return { kind: 'task_complete', type: 'task_complete', text: '回复完成', time: item.timestamp || '' };
    const failure = failureTextFromPayload(payload);
    if (failure) return { kind: 'task_error', type: 'task_error', text: failure, time: item.timestamp || '' };
    if (payload.type === 'agent_message' && payload.message) return { kind: 'reasoning', type: 'reasoning', text: cleanText(payload.message), time: item.timestamp || '' };
  }
  if (item.type === 'response_item') {
    if (payload.type === 'reasoning') {
      const textValue = extractReasoningText(payload);
      return textValue ? { kind: 'reasoning', type: 'reasoning', text: textValue, time: item.timestamp || '' } : null;
    }
    if (payload.type === 'function_call') {
      return { kind: 'tool_call', type: 'tool_call', text: formatToolEvent(payload), time: item.timestamp || '', callId: payload.call_id || '', name: payload.name || '' };
    }
    if (payload.type === 'function_call_output') {
      return { kind: 'tool_result', type: 'tool_result', text: '工具返回结果', time: item.timestamp || '', callId: payload.call_id || '' };
    }
    if (payload.type === 'message' && payload.role === 'assistant') {
      const textValue = cleanText(extractMessageText(payload.content));
      if (textValue) return { kind: 'assistant_message', type: 'assistant_message', text: textValue, time: item.timestamp || '' };
    }
  }
  return null;
}

function parseCodexHistory(threadId, limit = 100) {
  const snapshot = parseCodexThreadSnapshot(threadId);
  if (!snapshot.available) return { ok: true, available: false, threadId, messages: [] };
  return {
    ok: true,
    available: true,
    threadId,
    sessionFile: snapshot.sessionFile,
    messages: snapshot.messages.slice(-limit),
  };
}

function buildThreadRunStatus(options = {}) {
  const sendId = String(options.sendId || '');
  const record = sendId ? recentSends.get(sendId) : null;
  const since = options.since || (record ? record.watch.since : '');
  const sinceMs = since ? (Date.parse(since) || 0) : 0;
  const threadId = options.threadId || (record ? record.watch.threadId : '');
  const sessionFileName = options.sessionFile || (record ? record.watch.sessionFile : '');
  const expectNewThread = options.expectNewThread === true || (record ? record.watch.expectNewThread : false);
  const excludeThreadId = options.excludeThreadId || (record ? record.watch.excludeThreadId : '');
  const cwd = options.cwd || (record ? record.watch.cwd : '');
  let file = threadId ? findSessionFile(threadId) : '';
  if (!file && sessionFileName) file = findSessionFileByName(sessionFileName);
  if (!file && expectNewThread) file = findSessionFileForNewSend({ sinceMs, text: record ? record.textValue : '', cwd, excludeThreadId });
  if (!file && !threadId && !sessionFileName && !expectNewThread) file = findLatestSessionFile();
  debugLog('codex.status.parse', {
    sendId,
    hasRecord: Boolean(record),
    since,
    threadId,
    sessionFileName,
    expectNewThread,
    excludeThreadId,
    cwd,
    resolvedFile: file ? path.basename(file) : '',
  });
  const baseEvents = record ? record.events.slice(-30) : [];
  if (!file) {
    return {
      ok: true,
      available: false,
      accepted: record ? record.accepted : false,
      active: Boolean(expectNewThread && sinceMs),
      status: expectNewThread && sinceMs ? 'waiting' : 'missing',
      threadId: threadId || '',
      sessionFile: sessionFileName || '',
      preview: expectNewThread && sinceMs ? '已发送，等待 Codex 创建新线程记录…' : '还没有找到 Codex 会话记录。',
      final: '',
      error: '',
      events: baseEvents,
      steps: baseEvents,
    };
  }
  const items = readJsonlTail(file, STATUS_TAIL_BYTES);
  const filteredItems = sendId || sinceMs
    ? sliceItemsForSend(items, sinceMs, record ? record.textValue || '' : '')
    : (sinceMs ? items.filter((item) => {
      const t = Date.parse(item.timestamp || '');
      return !Number.isFinite(t) || t >= sinceMs - 2500;
    }) : items);
  let final = '';
  let preview = '';
  const steps = [];
  let accepted = record ? record.accepted : false;
  let active = false;
  let status = filteredItems.length ? 'idle' : quickRuntime(file).status;
  let error = '';
  let sawTaskStarted = false;
  let sawTaskComplete = false;
  for (const item of filteredItems) {
    const payload = item.payload || {};
    const event = codexEventFromItem(item);
    if (event) steps.push(event);
    if (item.type === 'event_msg' && payload.type === 'user_message') accepted = true;
    if (item.type === 'event_msg' && payload.type === 'task_started') {
      sawTaskStarted = true;
      active = true;
      status = 'running';
    }
    if (item.type === 'event_msg' && payload.type === 'task_complete') {
      sawTaskComplete = true;
      active = false;
      status = 'complete';
      const lastAgentMessage = cleanText(payload.last_agent_message || '');
      if (lastAgentMessage) {
        preview = lastAgentMessage;
        if (!final) final = lastAgentMessage;
      }
    }
    const failure = failureTextFromPayload(payload);
    if (failure) {
      active = false;
      status = 'error';
      error = failure;
    }
    if (item.type === 'event_msg' && payload.type === 'agent_message') {
      const textValue = cleanText(payload.message || '');
      if (textValue) {
        preview = textValue;
        if (String(payload.phase || '') === 'final_answer' && !final) final = textValue;
      }
    }
    if (item.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
      const textValue = cleanText(extractMessageText(payload.content));
      if (textValue) {
        preview = textValue;
        if (!payload.phase || payload.phase === 'final_answer') final = textValue;
      }
    }
  }
  if (record && accepted && !record.accepted) {
    record.accepted = true;
    record.threadId = threadIdFromFile(file);
    record.sessionFile = file;
    record.watch.threadId = record.threadId;
    record.watch.sessionFile = path.basename(file);
    record.watch.expectNewThread = false;
    record.watch.excludeThreadId = '';
    record.updatedAt = Date.now();
  }
  const events = baseEvents.concat(steps).slice(-60);
  const waiting = sinceMs && !steps.some((event) => event.kind === 'task_started' || event.kind === 'assistant_message' || event.kind === 'task_complete' || event.kind === 'task_error');
  if (waiting && status !== 'error' && status !== 'complete') {
    active = true;
    status = accepted ? 'waiting' : 'pending';
  } else if (accepted && !sawTaskComplete && status !== 'error') {
    active = true;
    status = (sawTaskStarted || preview) ? 'running' : 'waiting';
  } else if (sawTaskStarted && !sawTaskComplete && status !== 'error') {
    active = true;
    status = 'running';
  } else if (sawTaskComplete && status !== 'error') {
    active = false;
    status = 'complete';
  }
  const displayPreview = active ? (preview || final) : (final || preview);
  return {
    ok: true,
    available: true,
    accepted,
    active,
    status,
    threadId: threadId || threadIdFromFile(file),
    sessionFile: path.basename(file),
    preview: displayPreview || error || (accepted ? 'Codex 已接收，等待开始处理…' : '正在确认 Codex 是否收到消息…'),
    final,
    error,
    events,
    steps: steps.slice(-30),
  };
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    debugLog('process.start', { command, args: args.map((item) => textPreview(item, 160)) });
    const timeoutMs = Number(options.timeoutMs || 0);
    const spawnOptions = { ...options };
    delete spawnOptions.timeoutMs;
    const child = spawn(command, args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch {}
      const error = new Error(`${command} timed out after ${timeoutMs}ms`);
      error.code = 'PROCESS_TIMEOUT';
      error.stdout = stdout;
      error.stderr = stderr;
      debugError('process.timeout', error, { command, timeoutMs, args: args.map((item) => textPreview(item, 160)) });
      reject(error);
    }, timeoutMs) : null;
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code === 0) {
        debugLog('process.done', { command, code, stdout: textPreview(stdout, 180), stderr: textPreview(stderr, 180) });
        resolve({ stdout, stderr });
      }
      else {
        const error = new Error(stderr || stdout || `${command} exited ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        debugError('process.failed', error, { command, code, args: args.map((item) => textPreview(item, 160)) });
        reject(error);
      }
    });
  });
}

function httpGetJson(urlValue, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(urlValue, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode} from ${urlValue}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`CDP request timed out after ${timeoutMs}ms`));
    });
  });
}

function makeCodexCdpError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function normalizeCdpEndpoint() {
  return String(CODEX_CDP_ENDPOINT || 'http://127.0.0.1:9222').replace(/\/+$/, '');
}

async function findCodexCdpTarget() {
  const endpoint = normalizeCdpEndpoint();
  let targets;
  try {
    targets = await httpGetJson(`${endpoint}/json`, 2500);
  } catch (error) {
    throw makeCodexCdpError(
      'CODEX_CDP_UNAVAILABLE',
      `Codex 未以 CDP 模式启动。请先运行：open -a Codex --args --remote-debugging-port=9222`,
      { cause: error }
    );
  }
  const list = Array.isArray(targets) ? targets : [];
  const target = list.find((item) => item.type === 'page' && item.url === 'app://-/index.html')
    || list.find((item) => item.type === 'page' && /(^app:\/\/-|Codex)/i.test(`${item.url || ''} ${item.title || ''}`));
  if (!target || !target.webSocketDebuggerUrl) {
    throw makeCodexCdpError('CODEX_CDP_TARGET_MISSING', 'CDP 已开启，但没有找到 Codex 页面 target。请确认 Codex Desktop 已打开。');
  }
  return {
    endpoint,
    id: target.id || '',
    title: target.title || '',
    url: target.url || '',
    webSocketDebuggerUrl: target.webSocketDebuggerUrl,
  };
}

class CodexCdpSession {
  constructor(target) {
    this.target = target;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async open() {
    if (typeof WebSocket !== 'function') {
      throw makeCodexCdpError('CODEX_CDP_WEBSOCKET_UNSUPPORTED', '当前 Node.js 不支持全局 WebSocket，请升级 Node 到 20+。');
    }
    this.ws = new WebSocket(this.target.webSocketDebuggerUrl);
    this.ws.onmessage = (event) => {
      let message = null;
      try {
        message = JSON.parse(String(event.data || ''));
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const item = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.error) item.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else item.resolve(message.result || {});
      }
    };
    this.ws.onerror = () => {};
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(makeCodexCdpError('CODEX_CDP_CONNECT_TIMEOUT', '连接 Codex CDP websocket 超时')), 3000);
      this.ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.ws.onclose = () => {
        clearTimeout(timer);
        reject(makeCodexCdpError('CODEX_CDP_CLOSED', 'Codex CDP websocket 已关闭'));
      };
    });
  }

  call(method, params = {}, timeoutMs = 5000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(makeCodexCdpError('CODEX_CDP_NOT_CONNECTED', 'CDP websocket 未连接'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(makeCodexCdpError('CODEX_CDP_COMMAND_TIMEOUT', `${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs = 5000) {
    const result = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, timeoutMs);
    if (result.exceptionDetails) {
      throw makeCodexCdpError('CODEX_CDP_EVALUATE_FAILED', 'Codex DOM 脚本执行失败', { details: result.exceptionDetails });
    }
    return result.result ? result.result.value : null;
  }

  async close() {
    for (const item of this.pending.values()) clearTimeout(item.timer);
    this.pending.clear();
    try {
      if (this.ws) this.ws.close();
    } catch {}
  }
}

async function withCodexCdp(fn) {
  const target = await findCodexCdpTarget();
  const session = new CodexCdpSession(target);
  await session.open();
  try {
    return await fn(session, target);
  } finally {
    await session.close();
  }
}

function projectFromCodexSidebarProject(rawId = '', name = '') {
  const rawPath = String(rawId || '').trim();
  const label = String(name || '').trim();
  if (!rawPath) return directCodexProject();
  const resolved = path.resolve(rawPath);
  return {
    id: `codex-${sanitizeId(resolved)}`,
    name: label || path.basename(resolved) || resolved,
    path: resolved,
  };
}

async function scanCodexSidebarForCdp() {
  return withCodexCdp(async (session) => {
    const snapshot = await session.evaluate(String.raw`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const stripTimeSuffix = (value) => normalize(value).replace(/\s*(刚刚|\d+\s*(秒|分|小时|天|周|个月|年))\s*$/u, '').trim();
      const textOf = (el) => normalize(el.getAttribute('aria-label') || el.innerText || el.textContent || '');
      const findScroller = () => {
        const candidates = [...document.querySelectorAll('div')]
          .filter((el) => {
            if (!visible(el)) return false;
            const rect = el.getBoundingClientRect();
            return rect.x < 90 && rect.width < Math.min(430, innerWidth * 0.5) && el.scrollHeight > el.clientHeight + 24;
          })
          .map((el) => {
            const rect = el.getBoundingClientRect();
            const score = (String(el.className || '').includes('overflow-y-auto') ? 1000 : 0)
              + (String(el.className || '').includes('vertical-scroll') ? 1000 : 0)
              + Math.min(el.scrollHeight - el.clientHeight, 5000)
              - rect.x;
            return { el, score };
          })
          .sort((a, b) => b.score - a.score);
        return candidates[0] ? candidates[0].el : null;
      };
      const scroller = findScroller();
      const threads = new Map();
      const projects = new Map();
      const collect = () => {
        const all = [...document.querySelectorAll('[data-app-action-sidebar-project-row],[data-app-action-sidebar-thread-row],button,[role="button"],.h-token-nav-row,.folder-row')]
          .filter(visible)
          .map((el) => {
            const rect = el.getBoundingClientRect();
            return {
              el,
              text: textOf(el),
              dataset: { ...el.dataset },
              className: String(el.className || ''),
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
          })
          .filter((item) => item.text && item.width > 10 && item.height > 10)
          .sort((a, b) => (a.y - b.y) || (a.x - b.x));
        let section = '';
        let project = { rawId: '', name: '', path: '' };
        for (const item of all) {
          const dataset = item.dataset || {};
          const label = item.text;
          if (/^对话(\s+对话)?$/.test(label)) {
            section = 'direct';
            project = { rawId: '', name: '', path: '' };
            continue;
          }
          if (/^项目(\s+项目)?$/.test(label)) {
            section = 'project';
            continue;
          }
          if (Object.prototype.hasOwnProperty.call(dataset, 'appActionSidebarProjectRow')) {
            section = 'project';
            const rawId = dataset.appActionSidebarProjectId || '';
            const name = dataset.appActionSidebarProjectLabel || label;
            project = { rawId, name, path: rawId };
            projects.set(rawId || name, {
              rawId,
              name,
              path: rawId,
              collapsed: dataset.appActionSidebarProjectCollapsed || '',
            });
            continue;
          }
          if (!Object.prototype.hasOwnProperty.call(dataset, 'appActionSidebarThreadRow')) continue;
          const rawThreadId = String(dataset.appActionSidebarThreadId || '');
          const threadId = rawThreadId.includes(':') ? rawThreadId.split(':').pop() : rawThreadId;
          if (!threadId) continue;
          const lines = label.split(/\n+/).map(stripTimeSuffix).filter(Boolean);
          const title = dataset.appActionSidebarThreadTitle || (lines.length > 0 ? lines[0] : stripTimeSuffix(label)) || '未命名线程';
          threads.set(threadId, {
            id: threadId,
            title,
            rawId: rawThreadId,
            section,
            projectRawId: section === 'project' ? project.path : '',
            projectName: section === 'project' ? project.name : '对话',
            active: dataset.appActionSidebarThreadActive === 'true',
          });
        }
      };
      collect();
      if (scroller) {
        const originalTop = scroller.scrollTop;
        const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const step = Math.max(240, Math.floor(scroller.clientHeight * 0.72));
        const positions = [];
        for (let pos = 0; pos <= maxScroll + 1; pos += step) positions.push(pos);
        positions.push(maxScroll);
        for (const pos of [...new Set(positions.map((value) => Math.max(0, Math.min(maxScroll, Math.round(value)))) )]) {
          scroller.scrollTop = pos;
          await sleep(80);
          collect();
        }
        scroller.scrollTop = originalTop;
      }
      return {
        ok: true,
        threads: [...threads.values()],
        projects: [...projects.values()],
      };
    })()`, 20000);
    const result = {
      ok: true,
      threads: Array.isArray(snapshot && snapshot.threads) ? snapshot.threads : [],
      projects: Array.isArray(snapshot && snapshot.projects) ? snapshot.projects : [],
      error: '',
    };
    lastCodexSidebarSnapshot = { projects: result.projects, threads: result.threads, at: Date.now() };
    return result;
  });
}

function sidebarProjectIdSet(sidebarProjects = []) {
  const ids = new Set();
  for (const item of sidebarProjects || []) {
    const project = projectFromCodexSidebarProject(item.rawId || item.path || '', item.name || '');
    if (project.id && project.id !== CODEX_DIRECT_PROJECT_ID) ids.add(project.id);
  }
  return ids;
}

function mergeCodexSidebarThreads(localThreads, sidebarThreads, sidebarProjects = [], projectId = '', limit = 500) {
	const localById = new Map();
	for (const thread of localThreads) {
		if (thread && thread.id) localById.set(thread.id, { ...thread });
	}
	const allowedProjectIds = sidebarProjectIdSet(sidebarProjects);
	const hasSidebarProjectFilter = allowedProjectIds.size > 0;
	const byId = new Map();
	const addThread = (thread) => {
		if (!thread || !thread.id) return;
		if (projectId && thread.projectId !== projectId) return;
		if (hasSidebarProjectFilter && thread.projectId !== CODEX_DIRECT_PROJECT_ID && !allowedProjectIds.has(thread.projectId)) return;
		if (!byId.has(thread.id)) byId.set(thread.id, thread);
	};
  for (const item of sidebarThreads || []) {
    const threadId = String(item.id || '').trim();
    if (!threadId) continue;
    const isDirect = String(item.section || '') === 'direct' || !item.projectRawId;
    const project = isDirect ? directCodexProject() : projectFromCodexSidebarProject(item.projectRawId, item.projectName);
    if (projectId && project.id !== projectId) continue;
    const existing = localById.get(threadId) || {};
    const title = displayTitle(String(item.title || existing.title || existing.name || '未命名线程'));
    addThread({
      id: threadId,
      title,
      name: title,
      cwd: project.id === CODEX_DIRECT_PROJECT_ID ? '' : project.path,
      projectId: project.id,
      projectName: project.name,
      sessionFile: existing.sessionFile || '',
      updatedAt: existing.updatedAt || '',
      lastMessageAt: existing.lastMessageAt || '',
      preview: existing.preview || '',
      previewRole: existing.previewRole || '',
      messageCount: Number(existing.messageCount || 0),
      mtimeMs: Number(existing.mtimeMs || 0),
      runtimeStatus: existing.runtimeStatus || '',
      runtimeActive: Boolean(existing.runtimeActive),
    });
  }
  for (const thread of localThreads || []) {
    addThread(thread);
  }
  return [...byId.values()]
    .sort((a, b) => Math.max(Date.parse(b.updatedAt) || 0, b.mtimeMs || 0) - Math.max(Date.parse(a.updatedAt) || 0, a.mtimeMs || 0))
    .slice(0, Math.max(1, Math.min(Number(limit) || 500, 1000)));
}

function listSidebarProjects(sidebarProjects = []) {
  const byId = new Map();
  for (const item of sidebarProjects || []) {
    const project = projectFromCodexSidebarProject(item.rawId || item.path || '', item.name || '');
    if (project.id && project.id !== CODEX_DIRECT_PROJECT_ID && !byId.has(project.id)) byId.set(project.id, project);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function listKnownProjects(sidebarProjects = []) {
  const byId = new Map();
  const addProject = (project) => {
    if (!project || !project.id || project.id === CODEX_DIRECT_PROJECT_ID) return;
    if (!byId.has(project.id)) byId.set(project.id, project);
  };
  for (const project of config.projects || []) addProject(project);
  for (const thread of listSessionThreadSummaries('', 1000)) {
    if (thread.projectId && thread.projectId !== CODEX_DIRECT_PROJECT_ID) {
      addProject({ id: thread.projectId, name: thread.projectName || path.basename(thread.cwd) || thread.projectId, path: thread.cwd || '' });
    }
  }
  for (const item of sidebarProjects || []) {
    const project = projectFromCodexSidebarProject(item.rawId || item.path || '', item.name || '');
    addProject(project);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function getCodexCdpStatus() {
  try {
    return await withCodexCdp(async (session, target) => {
      const snapshot = await session.evaluate(`(() => {
        const visible = (el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const composer = [...document.querySelectorAll('.ProseMirror, textarea, input, [contenteditable="true"]')]
          .filter(visible)
          .map((el) => {
            const rect = el.getBoundingClientRect();
            return {
              tag: el.tagName,
              aria: el.getAttribute('aria-label') || '',
              placeholder: el.getAttribute('placeholder') || '',
              text: (el.innerText || el.value || '').trim().slice(0, 80),
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              bottom: Math.round(innerHeight - rect.bottom),
              className: String(el.className || '').slice(0, 80),
            };
          })
          .sort((a, b) => a.bottom - b.bottom)[0] || null;
        return { title: document.title, url: location.href, composer };
      })()`);
      return {
        ok: true,
        available: true,
        endpoint: target.endpoint,
        pageTitle: snapshot && snapshot.title ? snapshot.title : target.title,
        pageUrl: snapshot && snapshot.url ? snapshot.url : target.url,
        targetId: target.id,
        composer: snapshot ? snapshot.composer : null,
        error: '',
      };
    });
  } catch (error) {
    return {
      ok: true,
      available: false,
      endpoint: normalizeCdpEndpoint(),
      pageTitle: '',
      pageUrl: '',
      targetId: '',
      error: error && error.message ? error.message : String(error),
      code: error && error.code ? error.code : '',
    };
  }
}

async function clickCodexNewThreadButtonForCdp(session, scope = 'direct', projectNames = [], sendId = '') {
  const normalizedScope = scope === 'project' ? 'project' : 'direct';
  const names = Array.isArray(projectNames) ? projectNames.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const result = await session.evaluate(`((scope, projectNames) => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0
        && rect.height > 0
        && rect.bottom > 0
        && rect.top < innerHeight
        && rect.right > 0
        && rect.left < innerWidth
        && style.display !== 'none'
        && style.visibility !== 'hidden';
    };
    const textOf = (el) => ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '') + ' ' + (el.textContent || '')).replace(/\\s+/g, ' ').trim();
    const exactDirectLabel = (label) => label === '新对话' || label === '新对话 ⌘N 新对话⌘N' || label === '新对话 ⌘N';
    const isProjectNewThread = (label) => /^在 .+ 中开始新对话$/.test(label);
    const buttons = [...document.querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const label = textOf(el);
        const disabled = Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true';
        return {
          el,
          label,
          disabled,
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })
      .filter((item) => item.label && !item.disabled);
    let candidate = null;
    if (scope === 'project') {
      const targets = projectNames.map((name) => '在 ' + name + ' 中开始新对话');
      candidate = buttons.find((item) => targets.includes(item.label)) || null;
    } else {
      const chatSection = document.querySelector('[data-app-action-sidebar-section-heading="Chats"]');
      if (chatSection) {
        try { chatSection.scrollIntoView({ block: 'start' }); } catch {}
        const sectionRect = chatSection.getBoundingClientRect();
        const sectionButtons = [...chatSection.querySelectorAll('button, [role="button"]')]
          .filter(visible)
          .map((el) => {
            const rect = el.getBoundingClientRect();
            const label = textOf(el);
            const disabled = Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true';
            return {
              el,
              label,
              disabled,
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              nearHeader: rect.y >= sectionRect.y - 8 && rect.y <= sectionRect.y + 64,
            };
          })
          .filter((item) => !item.disabled && item.nearHeader);
        candidate = sectionButtons
          .filter((item) => item.label === '新对话')
          .sort((a, b) => b.x - a.x)[0]
          || null;
      }
    }
    const snapshot = buttons
      .filter((item) => /新对话|开始新对话|New/i.test(item.label))
      .slice(0, 20)
      .map((item) => ({ label: item.label.slice(0, 120), x: item.x, y: item.y, width: item.width, height: item.height }));
    if (!candidate) {
      return {
        ok: false,
        code: scope === 'project' ? 'CODEX_PROJECT_NEW_THREAD_BUTTON_NOT_FOUND' : 'CODEX_DIRECT_NEW_THREAD_BUTTON_NOT_FOUND',
        error: scope === 'project' ? ('没有找到项目新对话按钮：' + projectNames.map((name) => '在 ' + name + ' 中开始新对话').join(' / ')) : '没有找到独立新对话按钮。',
        snapshot,
      };
    }
    candidate.el.click();
    return {
      ok: true,
      label: candidate.label.slice(0, 120),
      x: candidate.x,
      y: candidate.y,
      width: candidate.width,
      height: candidate.height,
      snapshot,
    };
  })(${JSON.stringify(normalizedScope)}, ${JSON.stringify(names)})`, 5000);
  if (!result || result.ok !== true) {
    const error = makeCodexCdpError(result && result.code ? result.code : 'CODEX_NEW_THREAD_BUTTON_NOT_FOUND', result && result.error ? result.error : '没有找到 Codex 新对话按钮', { snapshot: result && result.snapshot ? result.snapshot : [] });
    debugError('codex.cdp.newThreadButtonFailed', error, { sendId, newThreadScope: normalizedScope, projectNames: names, result });
    throw error;
  }
  debugLog('codex.cdp.newThreadButtonClicked', { sendId, newThreadScope: normalizedScope, projectNames: names, button: result });
  pushSendEvent(sendId, 'send_step', 'CDP 已点击 Codex 新对话', { step: 'new_thread_clicked', backend: 'cdp', scope: normalizedScope, button: result });
  return result;
}

async function waitForCodexNewThreadReadyForCdp(session, sendId = '', timeoutMs = CODEX_NEW_THREAD_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() <= deadline) {
    last = await session.evaluate(`(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0
          && rect.height > 0
          && rect.bottom > 0
          && rect.top < innerHeight
          && rect.right > 0
          && rect.left < innerWidth
          && style.display !== 'none'
          && style.visibility !== 'hidden';
      };
      const candidates = [...document.querySelectorAll('.ProseMirror, textarea, input, [contenteditable="true"]')]
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const text = (el.innerText || el.value || '').trim();
          const bottom = innerHeight - rect.bottom;
          const mainArea = rect.x > Math.min(260, innerWidth * 0.32);
          const welcomeComposer = rect.width >= Math.min(520, innerWidth * 0.48) && rect.x >= 48 && rect.right <= innerWidth - 48;
          const usableSize = rect.width >= 240 && rect.height >= 32;
          const composerBand = bottom >= 0 && bottom < 620;
          return { tag: el.tagName, className: String(el.className || '').slice(0, 120), aria: el.getAttribute('aria-label') || '', placeholder: el.getAttribute('placeholder') || '', textLength: text.length, textPreview: text.slice(0, 80), x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height), bottom: Math.round(bottom), mainArea, welcomeComposer, usableSize, composerBand, score: (composerBand ? 1600 : 0) + (mainArea || welcomeComposer ? 700 : 0) + (usableSize ? 500 : 0) + rect.y + rect.width / 10 };
        })
        .sort((a, b) => b.score - a.score);
      const composer = candidates.find((item) => (item.mainArea || item.welcomeComposer) && item.usableSize && item.composerBand) || null;
      return { ok: Boolean(composer), composer, candidates: candidates.slice(0, 5).map((item) => ({ tag: item.tag, className: item.className, aria: item.aria, placeholder: item.placeholder, textLength: item.textLength, textPreview: item.textPreview, x: item.x, y: item.y, width: item.width, height: item.height, bottom: item.bottom, mainArea: item.mainArea, welcomeComposer: item.welcomeComposer, usableSize: item.usableSize, composerBand: item.composerBand })) };
    })()`, 3000);
    if (last && last.ok === true) {
      debugLog('codex.cdp.newThreadReady', { sendId, composer: last.composer });
      pushSendEvent(sendId, 'send_step', 'Codex 新会话已准备', { step: 'new_thread_ready', backend: 'cdp', composer: last.composer });
      return last.composer;
    }
    await delay(160);
  }
  const error = makeCodexCdpError('CODEX_NEW_THREAD_NOT_READY', '点击新对话后，Codex 新会话输入框没有及时准备好。', { snapshot: last });
  debugError('codex.cdp.newThreadReadyTimeout', error, { sendId, snapshot: last });
  throw error;
}

async function createCodexThreadViaCdp(session, options = {}) {
  const scope = options.scope === 'project' ? 'project' : 'direct';
  const projectName = String(options.projectName || '');
  const projectPath = String(options.projectPath || '');
  const projectNames = [...new Set([projectName, projectPath ? path.basename(projectPath) : ''].map((item) => String(item || '').trim()).filter(Boolean))];
  const sendId = String(options.sendId || '');
  pushSendEvent(sendId, 'send_step', scope === 'project' ? '通过 CDP 打开项目新对话' : '通过 CDP 打开独立新对话', { step: 'new_thread_start', backend: 'cdp', scope });
  await clickCodexNewThreadButtonForCdp(session, scope, projectNames, sendId);
  await delay(CODEX_DEEPLINK_SETTLE_MS);
  const composer = await waitForCodexNewThreadReadyForCdp(session, sendId);
  if (scope === 'direct') {
    await ensureCodexNoProjectForCdp(session, sendId, composer);
  }
  lastCodexThreadActivation = { threadId: '', at: 0 };
  return composer;
}

async function ensureCodexNoProjectForCdp(session, sendId = '', composer = null) {
  const opened = await session.evaluate(`(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0
        && rect.height > 0
        && rect.bottom > 0
        && rect.top < innerHeight
        && rect.right > 0
        && rect.left < innerWidth
        && style.display !== 'none'
        && style.visibility !== 'hidden';
    };
    const textOf = (el) => [
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
      el.innerText || '',
      el.textContent || '',
    ].join(' ').replace(/\\s+/g, ' ').trim();
    const buttons = [...document.querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const label = textOf(el);
        return { el, label, x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
      });
    const projectButtons = buttons
      .filter((item) => /^Project:\\s*.+/i.test(item.label))
      .sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const candidate = projectButtons[0] || null;
    if (!candidate) {
      return {
        ok: true,
        alreadyNoProject: true,
        projectButtons: [],
      };
    }
    candidate.el.click();
    return {
      ok: true,
      clicked: true,
      button: { label: candidate.label.slice(0, 120), x: candidate.x, y: candidate.y, width: candidate.width, height: candidate.height },
      projectButtons: projectButtons.slice(0, 5).map((item) => ({ label: item.label.slice(0, 120), x: item.x, y: item.y, width: item.width, height: item.height })),
    };
  })()`, 5000);
  if (!opened || opened.ok !== true) {
    const error = makeCodexCdpError('CODEX_PROJECT_SELECTOR_NOT_FOUND', '没有找到 Codex 项目选择器，无法创建无工作区 AI 助手会话。', { opened });
    debugError('codex.cdp.noProject.openSelectorFailed', error, { sendId, opened });
    pushSendEvent(sendId, 'send_step', 'Codex 项目选择器未打开，继续发送', { step: 'direct_project_selector_skipped', backend: 'cdp', reason: 'open_failed' });
    return { ok: false, skipped: true, reason: 'open_failed', opened };
  }
  if (opened.alreadyNoProject === true) {
    pushSendEvent(sendId, 'send_step', 'Codex 新会话未绑定项目', { step: 'direct_project_already_none', backend: 'cdp', selector: opened });
    return opened;
  }
  await delay(220);
  const selected = await session.evaluate(`((composer) => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0
        && rect.height > 0
        && rect.bottom > 0
        && rect.top < innerHeight
        && rect.right > 0
        && rect.left < innerWidth
        && style.display !== 'none'
        && style.visibility !== 'hidden';
    };
    const textOf = (el) => [
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
      el.innerText || '',
      el.textContent || '',
    ].join(' ').replace(/\\s+/g, ' ').trim();
    const clickTargetFor = (el) => el.closest('button, [role="button"], [role="option"], [cmdk-item], [data-radix-collection-item]') || el;
    const all = [...document.querySelectorAll('button, [role="button"], [role="option"], [cmdk-item], [data-radix-collection-item], div, span')]
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const label = textOf(el);
        return { el, label, x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
      });
    const noProject = all
      .filter((item) => item.label === '不使用项目' || item.label.includes('不使用项目'))
      .sort((a, b) => (a.y - b.y) || (a.x - b.x))[0] || null;
    if (noProject) {
      const target = clickTargetFor(noProject.el);
      const rect = target.getBoundingClientRect();
      target.click();
      return {
        ok: true,
        strategy: 'project_menu_no_project',
        item: { label: noProject.label.slice(0, 120), x: noProject.x, y: noProject.y, width: noProject.width, height: noProject.height },
        target: { label: textOf(target).slice(0, 120), x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        menuItems: all.filter((item) => /不使用项目|New project|搜索项目|Project:|项目/.test(item.label)).slice(0, 20).map((item) => ({ label: item.label.slice(0, 120), x: item.x, y: item.y, width: item.width, height: item.height })),
      };
    }

    const composerRect = {
      x: Number(composer && composer.x) || 0,
      y: Number(composer && composer.y) || 0,
      width: Number(composer && composer.width) || 0,
      height: Number(composer && composer.height) || 0,
    };
    const inComposerFooter = (item) => {
      if (!composerRect.width || !composerRect.height) return false;
      return item.x >= composerRect.x - 40
        && item.x <= composerRect.x + composerRect.width + 40
        && item.y >= composerRect.y + composerRect.height - 24
        && item.y <= composerRect.y + composerRect.height + 120;
    };
    const removeChip = all
      .filter((item) => inComposerFooter(item) && /不使用项目|Project:|vivo_remote_app|cover|项目/.test(item.label))
      .find((item) => item.width <= 48 && item.height <= 48) || null;
    if (removeChip) {
      const target = clickTargetFor(removeChip.el);
      const rect = target.getBoundingClientRect();
      target.click();
      return {
        ok: true,
        strategy: 'composer_project_chip_remove',
        item: { label: removeChip.label.slice(0, 120), x: removeChip.x, y: removeChip.y, width: removeChip.width, height: removeChip.height },
        target: { label: textOf(target).slice(0, 120), x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      };
    }

    return {
      ok: false,
      code: 'CODEX_NO_PROJECT_OPTION_NOT_FOUND',
      menuItems: all.filter((item) => /不使用项目|New project|搜索项目|Project:|项目|vivo_remote_app/.test(item.label)).slice(0, 30).map((item) => ({ label: item.label.slice(0, 120), x: item.x, y: item.y, width: item.width, height: item.height })),
    };
  })(${JSON.stringify(composer || {})})`, 5000);
  if (!selected || selected.ok !== true) {
    debugLog('codex.cdp.noProject.selectSkipped', { sendId, opened, selected });
    pushSendEvent(sendId, 'send_step', '未找到“不使用项目”，继续使用 Codex 当前项目状态发送', {
      step: 'direct_project_option_skipped',
      backend: 'cdp',
      code: selected && selected.code ? selected.code : 'CODEX_NO_PROJECT_OPTION_NOT_FOUND',
    });
    return { ok: false, skipped: true, reason: 'option_not_found', opened, selected };
  }
  pushSendEvent(sendId, 'send_step', 'Codex 新会话已切换为不使用项目', { step: 'direct_project_disabled', backend: 'cdp', selector: opened, selection: selected });
  debugLog('codex.cdp.noProject.selected', { sendId, opened, selected });
  await delay(260);
  return selected;
}

function codexThreadSummaryForCdp(threadId = '') {
  const snapshot = parseCodexThreadSnapshot(threadId, { processLimit: 0 });
  const summary = snapshot && (snapshot.summary || snapshot.threadSummary);
  if (!snapshot || snapshot.available !== true || !summary || !summary.id) {
    throw makeCodexCdpError('CODEX_THREAD_NOT_FOUND', `没有找到 Codex 线程：${threadId}`);
  }
  return summary;
}

async function confirmCodexThreadSelectedForCdp(session, expected, selected = null) {
  return session.evaluate(`((expected, selected) => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const normalizeThreadId = (value) => {
      const normalized = normalize(value);
      if (!normalized) return '';
      const parts = normalized.split(':').filter(Boolean);
      return normalize(parts.length > 0 ? parts[parts.length - 1] : normalized);
    };
    const stripTimeSuffix = (value) => normalize(value).replace(/\\s*(刚刚|\\d+\\s*(秒|分|小时|天|周|个月|年))\\s*$/u, '').trim();
    const textOf = (el) => normalize(el.getAttribute('aria-label') || el.innerText || el.textContent || '');
    const expectedThreadId = normalizeThreadId(expected.id);
    const expectedTitle = normalize(expected.title);
    const expectedProject = normalize(expected.projectName);
    const wantsDirect = expected.projectId === expected.directProjectId || !expected.cwd;
    const projectCandidates = [...new Set([expectedProject, ...(expected.projectCandidates || [])].map(normalize).filter(Boolean))];
    const timePrefix = /^(刚刚|\\d+\\s*(秒|分|小时|天|周|个月|年))(\\s|$)/u;
    const cleanProjectLabel = (label) => normalize(label).replace(/^(展开项目|折叠项目)\\s*/u, '').trim();
    const exactProjectName = (label) => {
      const normalized = cleanProjectLabel(label);
      for (const name of projectCandidates) {
        if (normalized === name || normalized.startsWith(name + ' ')) return name;
      }
      const parts = normalized.split(/\\s+/).filter(Boolean);
      return parts[0] || normalized;
    };
    const matchesProject = (value) => {
      const normalized = normalize(value);
      if (!normalized) return false;
      return projectCandidates.some((name) => normalized === name || normalized.startsWith(name + ' ') || name.startsWith(normalized + ' '));
    };
    const rowMatchesId = (row) => expectedThreadId && normalizeThreadId(row.threadId) === expectedThreadId;
    const rowMatchesTitle = (row) => {
      const candidates = [row.title, row.label].map(normalize).filter(Boolean);
      for (const candidate of candidates) {
        if (candidate === expectedTitle) return true;
        if (!candidate.startsWith(expectedTitle + ' ')) continue;
        const rest = candidate.slice(expectedTitle.length).trim();
        if (timePrefix.test(rest) || rest === expectedTitle || rest.endsWith(' ' + expectedTitle)) return true;
      }
      return false;
    };
    const activeScoreFor = (el) => {
      const cls = String(el.className || '').toLowerCase();
      const ariaCurrent = normalize(el.getAttribute('aria-current')).toLowerCase();
      const ariaSelected = normalize(el.getAttribute('aria-selected')).toLowerCase();
      const dataState = normalize(el.getAttribute('data-state')).toLowerCase();
      const dataActive = normalize(el.getAttribute('data-active')).toLowerCase();
      let score = 0;
      if (ariaCurrent && ariaCurrent !== 'false') score += 120;
      if (ariaSelected === 'true') score += 120;
      if (dataActive === 'true' || dataState === 'active' || dataState === 'selected') score += 100;
      if (/active|selected|current/.test(cls)) score += 80;
      if (/bg-token-sidebar-surface-active|bg-token-sidebar-surface-hover/.test(cls)) score += 45;
      if (document.activeElement && (el === document.activeElement || el.contains(document.activeElement))) score += 20;
      return score;
    };
    const all = [...document.querySelectorAll('[data-app-action-sidebar-project-row],[data-app-action-sidebar-thread-row],button,[role="button"],.h-token-nav-row,.folder-row')]
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          el,
          role: el.getAttribute('role') || '',
          label: textOf(el),
          dataset: { ...el.dataset },
          className: String(el.className || ''),
          activeScore: activeScoreFor(el),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })
      .filter((item) => item.label && item.width > 10 && item.height > 10)
      .sort((a, b) => (a.y - b.y) || (a.x - b.x));
    let section = '';
    let projectName = '';
    const rows = [];
    for (const item of all) {
      const label = item.label;
      const dataset = item.dataset || {};
      const cls = item.className;
      if (/^项目(\\s+项目)?$/.test(label)) {
        section = 'project';
        projectName = '';
        continue;
      }
      if (/^对话(\\s+对话)?$/.test(label)) {
        section = 'direct';
        projectName = '';
        continue;
      }
      if (/^(展开项目|折叠项目)/.test(label)) {
        section = 'project';
        projectName = exactProjectName(label);
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(dataset, 'appActionSidebarProjectRow')) {
        section = 'project';
        projectName = exactProjectName(dataset.appActionSidebarProjectLabel || label);
        continue;
      }
      if (cls.includes('folder-row')) {
        section = 'project';
        projectName = exactProjectName(label);
        continue;
      }
      const isThreadRow = Object.prototype.hasOwnProperty.call(dataset, 'appActionSidebarThreadRow')
        || cls.includes('h-token-nav-row')
        || (item.role === 'button' && cls.includes('h-[var(--height-token-row)]') && !cls.includes('folder-row'));
      if (!isThreadRow || cls.includes('folder-row')) continue;
      if (/置顶对话|归档对话|项目操作|开始新对话|新对话|搜索|插件|自动化/.test(label)) continue;
      const threadId = normalizeThreadId(dataset.appActionSidebarThreadId || '');
      const lines = label.split(/\\n+/).map(stripTimeSuffix).filter(Boolean);
      const title = normalize(dataset.appActionSidebarThreadTitle || (lines.length > 0 ? lines[0] : stripTimeSuffix(label)));
      if (!title) continue;
      rows.push({
        threadId,
        title,
        label,
        section,
        projectName,
        activeScore: item.activeScore,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
      });
    }
    const filterScopedRows = (items) => {
      if (wantsDirect) return items.filter((row) => row.section === 'direct');
      return items.filter((row) => row.section === 'project' && matchesProject(row.projectName));
    };
    const idMatches = rows.filter(rowMatchesId);
    const titleMatches = rows.filter(rowMatchesTitle);
    const matches = idMatches.length > 0 ? idMatches : filterScopedRows(titleMatches);
    const activeMatches = matches.filter((row) => row.activeScore >= 60);
    if (activeMatches.length === 1) {
      return { ok: true, strategy: idMatches.length > 0 ? 'active_sidebar_row_by_id' : 'active_sidebar_row', match: activeMatches[0], matches: matches.map((row) => ({ threadId: row.threadId, title: row.title, section: row.section, projectName: row.projectName, activeScore: row.activeScore, x: row.x, y: row.y })) };
    }
    const selectedLooksExpected = selected
      && ((expectedThreadId && normalizeThreadId(selected.threadId) === expectedThreadId)
        || (selected.title === expectedTitle
          && selected.section === (wantsDirect ? 'direct' : 'project')
          && (wantsDirect || matchesProject(selected.projectName))));
    if (selectedLooksExpected) {
      const activeClickedRow = (idMatches.length > 0 ? idMatches : titleMatches).find((row) => {
        if (row.activeScore < 60) return false;
        return Math.abs(Number(row.x || 0) - Number(selected.x || 0)) <= 4
          && Math.abs(Number(row.y || 0) - Number(selected.y || 0)) <= 4
          && Math.abs(Number(row.width || 0) - Number(selected.width || 0)) <= 12;
      });
      if (activeClickedRow) {
        return { ok: true, strategy: idMatches.length > 0 ? 'active_clicked_row_by_id' : 'active_clicked_row', match: activeClickedRow, selected, matches: matches.map((row) => ({ threadId: row.threadId, title: row.title, section: row.section, projectName: row.projectName, activeScore: row.activeScore, x: row.x, y: row.y })) };
      }
      const activeSameTitleRows = (idMatches.length > 0 ? idMatches : titleMatches).filter((row) => {
        if (row.activeScore < 60) return false;
        if (expectedThreadId) return normalizeThreadId(row.threadId) === expectedThreadId;
        if (row.section !== selected.section) return false;
        if (wantsDirect) return row.section === 'direct';
        return row.section === 'project' && (!row.projectName || matchesProject(row.projectName));
      });
      if (activeSameTitleRows.length === 1) {
        return { ok: true, strategy: expectedThreadId ? 'active_same_thread_after_click' : 'active_same_title_after_click', match: activeSameTitleRows[0], selected, matches: matches.map((row) => ({ threadId: row.threadId, title: row.title, section: row.section, projectName: row.projectName, activeScore: row.activeScore, x: row.x, y: row.y })) };
      }
    }

    const sidebarRight = rows.reduce((max, row) => Math.max(max, row.x + row.width), 0);
    const mainTitleMatches = [...document.querySelectorAll('main h1, main h2, main [role="heading"], header h1, header h2, header [role="heading"], [data-testid*="title"]')]
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return { text: normalize(el.innerText || el.textContent || ''), x: Math.round(rect.x), y: Math.round(rect.y) };
      })
      .filter((item) => item.x > Math.max(220, sidebarRight - 12) && (item.text === expectedTitle || item.text.startsWith(expectedTitle + ' ')));
    if (mainTitleMatches.length > 0 && matches.length === 1) {
      return { ok: true, strategy: 'main_title', match: matches[0], mainTitle: mainTitleMatches[0] };
    }

    return {
      ok: false,
      code: 'CODEX_TARGET_THREAD_UNCONFIRMED',
      error: '已点击目标线程，但无法确认 Codex 当前页面就是目标会话，已停止发送以避免串会话：' + expectedTitle,
      expected: { id: expectedThreadId, title: expectedTitle, projectName: expectedProject, wantsDirect, projectCandidates },
      selected,
      matches: matches.map((row) => ({ threadId: row.threadId, title: row.title, section: row.section, projectName: row.projectName, activeScore: row.activeScore, x: row.x, y: row.y })),
      activeRows: rows.filter((row) => row.activeScore >= 60).slice(0, 10).map((row) => ({ threadId: row.threadId, title: row.title, section: row.section, projectName: row.projectName, activeScore: row.activeScore, x: row.x, y: row.y })),
    };
  })(${JSON.stringify(expected)}, ${JSON.stringify(selected || {})})`, 5000);
}

async function selectCodexThreadForCdp(session, threadSummary, sendId = '') {
  const projectCandidates = [
    String(threadSummary.projectName || '').trim(),
    threadSummary.cwd ? path.basename(String(threadSummary.cwd || '')) : '',
  ].filter(Boolean);
  const expected = {
    id: String(threadSummary.id || ''),
    title: String(threadSummary.title || threadSummary.name || '').trim(),
    projectId: String(threadSummary.projectId || ''),
    projectName: String(threadSummary.projectName || '').trim(),
    projectCandidates: [...new Set(projectCandidates)],
    cwd: String(threadSummary.cwd || ''),
    directProjectId: CODEX_DIRECT_PROJECT_ID,
  };
  const scanOnce = async (scrollTop) => session.evaluate(`((expected, requestedScrollTop) => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const normalizeThreadId = (value) => {
      const normalized = normalize(value);
      if (!normalized) return '';
      const parts = normalized.split(':').filter(Boolean);
      return normalize(parts.length > 0 ? parts[parts.length - 1] : normalized);
    };
    const stripTimeSuffix = (value) => normalize(value).replace(/\\s*(刚刚|\\d+\\s*(秒|分|小时|天|周|个月|年))\\s*$/u, '').trim();
    const textOf = (el) => normalize(el.getAttribute('aria-label') || el.innerText || el.textContent || '');
    const expectedThreadId = normalizeThreadId(expected.id);
    const expectedTitle = normalize(expected.title);
    const expectedProject = normalize(expected.projectName);
    const wantsDirect = expected.projectId === expected.directProjectId || !expected.cwd;
    const projectCandidates = [...new Set([expectedProject, ...(expected.projectCandidates || [])].map(normalize).filter(Boolean))];
    const timePrefix = /^(刚刚|\\d+\\s*(秒|分|小时|天|周|个月|年))(\\s|$)/u;
    const exactProjectName = (label) => {
      const normalized = normalize(label);
      for (const name of projectCandidates) {
        if (normalized === name || normalized.startsWith(name + ' ')) return name;
      }
      const parts = normalized.split(/\\s+/).filter(Boolean);
      return parts[0] || normalized;
    };
    const matchesProject = (value) => {
      const normalized = normalize(value);
      if (!normalized) return false;
      return projectCandidates.some((name) => normalized === name || normalized.startsWith(name + ' ') || name.startsWith(normalized + ' '));
    };
    const rowMatchesId = (row) => expectedThreadId && normalizeThreadId(row.threadId) === expectedThreadId;
    const rowMatchesTitle = (row) => {
      const candidates = [row.title, row.label].map(normalize).filter(Boolean);
      for (const candidate of candidates) {
        if (candidate === expectedTitle) return true;
        if (!candidate.startsWith(expectedTitle + ' ')) continue;
        const rest = candidate.slice(expectedTitle.length).trim();
        if (timePrefix.test(rest) || rest === expectedTitle || rest.endsWith(' ' + expectedTitle)) return true;
      }
      return false;
    };
    const findScroller = () => {
      const candidates = [...document.querySelectorAll('div')]
        .filter((el) => {
          if (!visible(el)) return false;
          const rect = el.getBoundingClientRect();
          return rect.x < 80 && rect.width < Math.min(420, innerWidth * 0.45) && el.scrollHeight > el.clientHeight + 24;
        })
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const score = (String(el.className || '').includes('overflow-y-auto') ? 1000 : 0)
            + (String(el.className || '').includes('vertical-scroll') ? 1000 : 0)
            + Math.min(el.scrollHeight - el.clientHeight, 5000)
            - rect.x;
          return { el, rect, score };
        })
        .sort((a, b) => b.score - a.score);
      return candidates[0] ? candidates[0].el : null;
    };
    const scroller = findScroller();
    if (scroller && requestedScrollTop !== null && requestedScrollTop !== undefined) {
      scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, Number(requestedScrollTop) || 0));
    }
    const scrollerInfo = scroller ? {
      scrollTop: Math.round(scroller.scrollTop),
      maxScroll: Math.round(Math.max(0, scroller.scrollHeight - scroller.clientHeight)),
      clientHeight: Math.round(scroller.clientHeight),
      scrollHeight: Math.round(scroller.scrollHeight),
    } : { scrollTop: 0, maxScroll: 0, clientHeight: 0, scrollHeight: 0 };
    const all = [...document.querySelectorAll('[data-app-action-sidebar-project-row],[data-app-action-sidebar-thread-row],button,[role="button"],.h-token-nav-row,.folder-row')]
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          el,
          tag: el.tagName,
          role: el.getAttribute('role') || '',
          label: textOf(el),
          dataset: { ...el.dataset },
          className: String(el.className || ''),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })
      .filter((item) => item.label && item.width > 10 && item.height > 10)
      .sort((a, b) => (a.y - b.y) || (a.x - b.x));
    let section = '';
    let projectName = '';
    const rows = [];
    const projectControls = [];
    const showMoreControls = [];
    for (const item of all) {
      const label = item.label;
      const dataset = item.dataset || {};
      const cls = item.className;
      const isProjectsHeader = /^项目(\\s+项目)?$/.test(label);
      const isDirectHeader = /^对话(\\s+对话)?$/.test(label);
      if (isProjectsHeader) {
        section = 'project';
        projectName = '';
        continue;
      }
      if (isDirectHeader) {
        section = 'direct';
        projectName = '';
        continue;
      }
      if (/^展开项目/.test(label) || /^折叠项目/.test(label)) {
        projectControls.push({ type: /^展开项目/.test(label) ? 'expand' : 'collapse', el: item.el, projectName, label, x: item.x, y: item.y, width: item.width, height: item.height });
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(dataset, 'appActionSidebarProjectRow')) {
        section = 'project';
        projectName = exactProjectName(dataset.appActionSidebarProjectLabel || label);
        projectControls.push({ type: 'project_row', projectName, label, x: item.x, y: item.y, width: item.width, height: item.height });
        continue;
      }
      if (cls.includes('folder-row')) {
        section = 'project';
        projectName = exactProjectName(label);
        projectControls.push({ type: 'folder', projectName, label, x: item.x, y: item.y, width: item.width, height: item.height });
        continue;
      }
      if (/^展开显示/.test(label)) {
        showMoreControls.push({ el: item.el, section, projectName, label, x: item.x, y: item.y, width: item.width, height: item.height });
        continue;
      }
      const isThreadRow = Object.prototype.hasOwnProperty.call(dataset, 'appActionSidebarThreadRow')
        || cls.includes('h-token-nav-row')
        || (item.role === 'button' && cls.includes('h-[var(--height-token-row)]') && !cls.includes('folder-row'));
      if (!isThreadRow || cls.includes('folder-row')) continue;
      if (/置顶对话|归档对话|项目操作|开始新对话|新对话|搜索|插件|自动化/.test(label)) continue;
      const threadId = normalizeThreadId(dataset.appActionSidebarThreadId || '');
      let title = dataset.appActionSidebarThreadTitle || label;
      const lines = label.split(/\\n+/).map(stripTimeSuffix).filter(Boolean);
      if (!dataset.appActionSidebarThreadTitle) {
        if (lines.length > 0) title = lines[0];
        else title = stripTimeSuffix(label);
      }
      title = normalize(title);
      if (!title) continue;
      rows.push({
        el: item.el,
        threadId,
        title,
        label,
        section,
        projectName,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
      });
    }
    const snapshot = rows.slice(0, 80).map((row) => ({
      threadId: row.threadId,
      title: row.title.slice(0, 120),
      section: row.section,
      projectName: row.projectName,
      x: row.x,
      y: row.y,
      width: row.width,
      height: row.height,
    }));
    const matchingRows = (rows) => {
      const idMatches = rows.filter(rowMatchesId);
      if (idMatches.length > 0) return idMatches;
      const titleMatches = rows.filter(rowMatchesTitle);
      if (wantsDirect) return titleMatches.filter((row) => row.section === 'direct');
      return titleMatches.filter((row) => row.section === 'project' && matchesProject(row.projectName));
    };
    const matchingShowMore = (controls) => controls.filter((item) => {
      if (wantsDirect) return item.section === 'direct';
      return item.section === 'project' && matchesProject(item.projectName);
    });
    const matchingProjectExpand = (controls) => {
      if (wantsDirect) return [];
      const folders = controls.filter((item) => item.type === 'folder' && matchesProject(item.projectName));
      const expands = controls.filter((item) => item.type === 'expand');
      const result = [];
      for (const folder of folders) {
        const nearby = expands.find((item) => Math.abs(item.y - folder.y) <= 8) || expands.find((item) => matchesProject(item.projectName));
        if (nearby) result.push({ ...nearby, projectName: folder.projectName || nearby.projectName });
      }
      return result;
    };
    const projectExpand = matchingProjectExpand(projectControls)[0] || null;
    if (projectExpand) {
      projectExpand.el.scrollIntoView({ block: 'center' });
      projectExpand.el.click();
      return { ok: false, action: { step: 'project_expanded', projectName: projectExpand.projectName, label: projectExpand.label, x: Math.round(projectExpand.x), y: Math.round(projectExpand.y) }, snapshot, scroller: scrollerInfo };
    }
    const matches = matchingRows(rows);
    if (matches.length > 1) {
      return {
        ok: false,
        code: 'CODEX_THREAD_SELECTION_AMBIGUOUS',
        error: 'Codex 侧边栏中目标线程标题重复，未发送以避免发错会话：' + expectedTitle,
        expected: { id: expectedThreadId, title: expectedTitle, projectName: expectedProject, wantsDirect, projectCandidates },
        matches: matches.map((row) => ({ threadId: row.threadId, title: row.title, section: row.section, projectName: row.projectName, x: row.x, y: row.y })),
        snapshot,
        scroller: scrollerInfo,
      };
    }
    if (matches.length === 1) {
      const selected = matches[0];
      selected.el.scrollIntoView({ block: 'center' });
      selected.el.click();
      return {
        ok: true,
        threadId: selected.threadId,
        title: selected.title,
        section: selected.section,
        projectName: selected.projectName,
        x: selected.x,
        y: selected.y,
        width: selected.width,
        height: selected.height,
        action: { step: selected.threadId && expectedThreadId && selected.threadId === expectedThreadId ? 'thread_selected_by_id' : 'thread_selected', threadId: selected.threadId, title: selected.title, section: selected.section, projectName: selected.projectName, x: selected.x, y: selected.y },
        scroller: scrollerInfo,
      };
    }
    const showMore = matchingShowMore(showMoreControls)[0] || null;
    if (showMore) {
      showMore.el.scrollIntoView({ block: 'center' });
      showMore.el.click();
      return { ok: false, action: { step: 'show_more_clicked', section: showMore.section, projectName: showMore.projectName, label: showMore.label, x: Math.round(showMore.x), y: Math.round(showMore.y) }, snapshot, scroller: scrollerInfo };
    }
    return { ok: false, code: 'CODEX_THREAD_ROW_NOT_FOUND', error: '自动展开并滚动查找后，仍没有在 Codex 侧边栏找到目标线程：' + expectedTitle, expected: { id: expectedThreadId, title: expectedTitle, projectName: expectedProject, wantsDirect, projectCandidates }, snapshot, scroller: scrollerInfo };
  })(${JSON.stringify(expected)}, ${scrollTop === null || scrollTop === undefined ? 'null' : JSON.stringify(scrollTop)})`, 5000);

  let lastResult = null;
  const seenActions = new Set();
  const scanSnapshots = [];
  pushSendEvent(sendId, 'send_step', 'CDP 开始自动扫描 Codex 侧边栏', { step: 'thread_scan_start', backend: 'cdp', expected });
  for (let pass = 0; pass < 6; pass += 1) {
    const initial = await scanOnce(null);
    lastResult = initial;
    const maxScroll = initial && initial.scroller ? Number(initial.scroller.maxScroll || 0) : 0;
    const clientHeight = initial && initial.scroller ? Number(initial.scroller.clientHeight || 0) : 0;
    const currentTop = initial && initial.scroller ? Number(initial.scroller.scrollTop || 0) : 0;
    const step = Math.max(260, Math.floor((clientHeight || 600) * 0.78));
    const positions = [currentTop, 0];
    for (let pos = 0; pos <= maxScroll + 1; pos += step) positions.push(pos);
    positions.push(maxScroll);
    const uniquePositions = [...new Set(positions.map((pos) => Math.max(0, Math.min(maxScroll, Math.round(pos)))))];
    let progressed = false;
    for (const pos of uniquePositions) {
      const result = await scanOnce(pos);
      lastResult = result;
      if (result && result.snapshot) scanSnapshots.push({ scrollTop: result.scroller ? result.scroller.scrollTop : 0, rows: result.snapshot.slice(0, 20) });
      pushSendEvent(sendId, 'send_step', 'CDP 正在滚动扫描侧边栏', { step: 'thread_scan_scrolled', backend: 'cdp', scrollTop: result && result.scroller ? result.scroller.scrollTop : pos, maxScroll });
      if (result && result.ok === true) {
        debugLog('codex.cdp.threadSelected', { sendId, threadId: expected.id, selected: result });
        pushSendEvent(sendId, 'send_step', 'CDP 已选择 Codex 线程', { step: 'thread_selected', backend: 'cdp', selected: result });
        await delay(CODEX_APP_FOCUS_SETTLE_MS);
        const confirmation = await confirmCodexThreadSelectedForCdp(session, expected, result);
        if (!confirmation || confirmation.ok !== true) {
          const code = confirmation && confirmation.code ? confirmation.code : 'CODEX_TARGET_THREAD_UNCONFIRMED';
          const message = confirmation && confirmation.error ? confirmation.error : `已点击目标线程，但无法确认 Codex 当前页面就是目标会话，已停止发送以避免串会话：${expected.title}`;
          const error = makeCodexCdpError(code, message, { expected, selected: result, confirmation });
          debugError('codex.cdp.threadConfirmFailed', error, { sendId, threadId: expected.id, selected: result, confirmation });
          pushSendEvent(sendId, 'task_error', message, { step: 'thread_confirm_failed', backend: 'cdp', code, expected, selected: result, confirmation });
          throw error;
        }
        debugLog('codex.cdp.threadConfirmed', { sendId, threadId: expected.id, confirmation });
        pushSendEvent(sendId, 'send_step', 'CDP 已确认目标线程', { step: 'thread_confirmed', backend: 'cdp', confirmation });
        lastCodexThreadActivation = { threadId: expected.id, at: Date.now() };
        return result;
      }
      if (result && result.code === 'CODEX_THREAD_SELECTION_AMBIGUOUS') {
        const error = makeCodexCdpError(result.code, result.error, { expected, snapshot: result.snapshot || [], matches: result.matches || [], scanSnapshots: scanSnapshots.slice(-8) });
        debugError('codex.cdp.threadSelectFailed', error, { sendId, threadId: expected.id, result });
        throw error;
      }
      if (result && result.action && result.action.step) {
        const action = result.action;
        const key = `${action.step}:${action.projectName || ''}:${action.section || ''}:${action.label || ''}:${Math.round(action.y || 0)}`;
        if (seenActions.has(key)) continue;
        seenActions.add(key);
        if (action.step === 'project_expanded') {
          pushSendEvent(sendId, 'send_step', `CDP 已展开项目 ${action.projectName || ''}`.trim(), { step: 'project_expanded', backend: 'cdp', projectName: action.projectName || '', label: action.label || '' });
        } else if (action.step === 'show_more_clicked') {
          pushSendEvent(sendId, 'send_step', 'CDP 已展开更多会话', { step: 'show_more_clicked', backend: 'cdp', section: action.section || '', projectName: action.projectName || '' });
        }
        await delay(350);
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  const error = makeCodexCdpError(lastResult && lastResult.code ? lastResult.code : 'CODEX_THREAD_ROW_NOT_FOUND', lastResult && lastResult.error ? lastResult.error : '没有在 Codex 侧边栏找到目标线程', {
      expected,
      snapshot: lastResult && lastResult.snapshot ? lastResult.snapshot : [],
      matches: lastResult && lastResult.matches ? lastResult.matches : [],
      scanSnapshots: scanSnapshots.slice(-8),
    });
  debugError('codex.cdp.threadSelectFailed', error, { sendId, threadId: expected.id, result: lastResult });
  throw error;
}

async function waitForCodexIdleForCdp(session, sendId = '', timeoutMs = CODEX_BUSY_WAIT_TIMEOUT_MS) {
  const isBusy = async () => session.evaluate(`(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const textOf = (el) => ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '') + ' ' + (el.textContent || '')).trim();
    const buttons = [...document.querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: textOf(el).slice(0, 80),
          aria: el.getAttribute('aria-label') || '',
          disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          bottom: innerHeight - rect.bottom,
        };
      });
    const stop = buttons.find((item) => {
      const label = item.text + ' ' + item.aria;
      if (!/停止|Stop/i.test(label)) return false;
      if (/后台终端|background terminal/i.test(label)) return false;
      return item.bottom >= 0 && item.bottom < 140 && item.x > innerWidth * 0.45;
    });
    return { busy: Boolean(stop), stop: stop ? { text: stop.text, aria: stop.aria, x: Math.round(stop.x), y: Math.round(stop.y), bottom: Math.round(stop.bottom) } : null };
  })()`, 4000);

  let state = await isBusy();
  if (!state || state.busy !== true) return { waited: false };
  const startedAt = Date.now();
  let lastNoticeAt = 0;
  debugLog('codex.cdp.busyWaitStart', { sendId, stop: state.stop, timeoutMs });
  pushSendEvent(sendId, 'send_step', 'Codex 正在运行，已排队等待空闲发送', { step: 'busy_wait_start', backend: 'cdp', stop: state.stop, timeoutMs });
  while (Date.now() - startedAt < timeoutMs) {
    await delay(CODEX_BUSY_WAIT_INTERVAL_MS);
    state = await isBusy();
    if (!state || state.busy !== true) {
      const waitedMs = Date.now() - startedAt;
      debugLog('codex.cdp.busyWaitDone', { sendId, waitedMs });
      pushSendEvent(sendId, 'send_step', 'Codex 已空闲，继续发送', { step: 'busy_wait_done', backend: 'cdp', waitedMs });
      return { waited: true, waitedMs };
    }
    if (Date.now() - lastNoticeAt >= 5000) {
      lastNoticeAt = Date.now();
      pushSendEvent(sendId, 'send_step', 'Codex 仍在运行，继续等待空闲', { step: 'busy_waiting', backend: 'cdp', waitedMs: Date.now() - startedAt, stop: state.stop });
    }
  }
  const error = makeCodexCdpError('CODEX_BUSY_TIMEOUT', 'Codex 当前任务长时间未结束，已停止本次发送以避免打断当前任务。', { timeoutMs, stop: state && state.stop ? state.stop : null });
  pushSendEvent(sendId, 'send_step', '等待 Codex 空闲超时，未发送', { step: 'busy_wait_timeout', backend: 'cdp', timeoutMs });
  debugError('codex.cdp.busyWaitTimeout', error, { sendId, timeoutMs, state });
  throw error;
}

async function ensureCodexThreadSelectedForCdp(session, threadId = '', sendId = '') {
  const summary = codexThreadSummaryForCdp(threadId);
  pushSendEvent(sendId, 'send_step', '通过 CDP 选择目标线程', { step: 'thread_select_start', backend: 'cdp', threadId });
  return selectCodexThreadForCdp(session, summary, sendId);
}

async function focusCodexTargetForCdp(threadId = '', cwd = '', sendId = '', options = {}) {
  const assumeThreadSynced = Boolean(options.assumeThreadSynced);
  const forceThreadSwitch = Boolean(options.forceThreadSwitch);
  if (threadId && assumeThreadSynced && !forceThreadSwitch) {
    debugLog('codex.cdp.assumeThreadSyncedIgnored', { sendId, threadId });
  }
  pushSendEvent(sendId, 'send_step', threadId ? '切换 Codex 线程' : '打开 Codex 新线程', { step: 'activate_codex', backend: 'cdp' });
  if (threadId && isCodexThreadId(threadId)) {
    debugLog('codex.cdp.activateThread.deferToDom', { sendId, threadId, forceThreadSwitch });
  } else {
    debugLog('codex.cdp.activateNewThread.deferToDom', { sendId, cwd, newThreadScope: options.newThreadScope || '' });
  }
  pushSendEvent(sendId, 'send_step', 'Codex 页面已准备', { step: 'activate_done', backend: 'cdp' });
}

async function sendTextWithCdp(textValue, threadId, cwd, sendId = '', options = {}) {
	const textLength = String(textValue || '').length;
	const skipCreateNewThread = Boolean(options.skipCreateNewThread);
	debugLog('codex.cdp.send.start', { sendId, threadId, cwd, assumeThreadSynced: Boolean(options.assumeThreadSynced), forceThreadSwitch: Boolean(options.forceThreadSwitch), skipCreateNewThread, textLength, textPreview: textPreview(textValue) });
  pushSendEvent(sendId, 'send_step', '使用 CDP 连接 Codex', { step: 'cdp_connect', backend: 'cdp' });
  const preflightTarget = await findCodexCdpTarget();
  debugLog('codex.cdp.preflight', { sendId, targetId: preflightTarget.id, pageTitle: preflightTarget.title, pageUrl: preflightTarget.url });
  if (threadId) await focusCodexTargetForCdp(threadId, cwd, sendId, options);
  return withCodexCdp(async (session, target) => {
    debugLog('codex.cdp.target', { sendId, targetId: target.id, pageTitle: target.title, pageUrl: target.url });
    pushSendEvent(sendId, 'send_step', 'CDP 已连接 Codex 页面', { step: 'cdp_connected', backend: 'cdp', targetId: target.id });
		if (!threadId && !skipCreateNewThread) {
			await createCodexThreadViaCdp(session, {
				scope: options.newThreadScope || 'direct',
				projectName: options.projectName || '',
				projectPath: cwd || '',
				sendId,
			});
		} else if (!threadId && skipCreateNewThread) {
			pushSendEvent(sendId, 'send_step', '复用已准备的 Codex 新对话', { step: 'new_thread_reused', backend: 'cdp', scope: options.newThreadScope || 'direct' });
		} else {
			await ensureCodexThreadSelectedForCdp(session, threadId, sendId);
		}
    await waitForCodexIdleForCdp(session, sendId);
    const prepared = await session.evaluate(`(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0
          && rect.height > 0
          && rect.bottom > 0
          && rect.top < innerHeight
          && rect.right > 0
          && rect.left < innerWidth
          && style.display !== 'none'
          && style.visibility !== 'hidden';
      };
      const textOf = (el) => ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '') + ' ' + (el.textContent || '')).trim();
      const buttons = [...document.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            text: textOf(el).slice(0, 80),
            aria: el.getAttribute('aria-label') || '',
            disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            bottom: innerHeight - rect.bottom,
          };
        });
      const candidates = [...document.querySelectorAll('.ProseMirror, textarea, input, [contenteditable="true"]')]
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const bottom = innerHeight - rect.bottom;
          const mainArea = rect.x > Math.min(260, innerWidth * 0.32);
          const welcomeComposer = rect.width >= Math.min(520, innerWidth * 0.48) && rect.x >= 48 && rect.right <= innerWidth - 48;
          const usableSize = rect.width >= 240 && rect.height >= 32;
          const composerBand = bottom >= 0 && bottom < 620;
          return { el, rect, mainArea, welcomeComposer, usableSize, composerBand, score: (composerBand ? 1600 : 0) + (mainArea || welcomeComposer ? 700 : 0) + (usableSize ? 500 : 0) + rect.y + rect.width / 10 };
        })
        .sort((a, b) => b.score - a.score);
      const found = candidates.find((item) => (item.mainArea || item.welcomeComposer) && item.usableSize && item.composerBand) || null;
      if (!found) {
        return {
          ok: false,
          code: 'CODEX_COMPOSER_NOT_FOUND',
          error: '没有在 Codex 页面中找到输入框。',
          snapshot: buttons.slice(-12),
          composerCandidates: candidates.slice(0, 5).map((item) => ({
            x: Math.round(item.rect.x),
            y: Math.round(item.rect.y),
            width: Math.round(item.rect.width),
            height: Math.round(item.rect.height),
            bottom: Math.round(innerHeight - item.rect.bottom),
            mainArea: item.mainArea,
            welcomeComposer: item.welcomeComposer,
            usableSize: item.usableSize,
            composerBand: item.composerBand,
          })),
        };
      }
      const el = found.el;
      el.focus();
      if (el.isContentEditable || el.classList.contains('ProseMirror')) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      } else if ('setSelectionRange' in el) {
        const length = String(el.value || '').length;
        el.setSelectionRange(length, length);
      }
      const rect = found.rect;
      return {
        ok: true,
        tag: el.tagName,
        className: String(el.className || '').slice(0, 120),
        aria: el.getAttribute('aria-label') || '',
        placeholder: el.getAttribute('placeholder') || '',
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        bottom: Math.round(innerHeight - rect.bottom),
      };
    })()`, 6000);
    if (!prepared || prepared.ok !== true) {
      const error = makeCodexCdpError(prepared && prepared.code ? prepared.code : 'CODEX_COMPOSER_NOT_FOUND', prepared && prepared.error ? prepared.error : '无法聚焦 Codex 输入框', { snapshot: prepared && prepared.snapshot ? prepared.snapshot : [] });
      debugError('codex.cdp.prepareFailed', error, { sendId, prepared });
      throw error;
    }
    debugLog('codex.cdp.composer', { sendId, composer: prepared });
    pushSendEvent(sendId, 'send_step', 'CDP 已聚焦输入框', { step: 'composer_focused', backend: 'cdp', composer: prepared });

    await session.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 0, modifiers: 4 }, 3000);
    await session.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 0, modifiers: 4 }, 3000);
    await session.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }, 3000);
    await session.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }, 3000);
    await session.call('Input.insertText', { text: String(textValue || '') }, 10000);
    pushSendEvent(sendId, 'send_step', 'CDP 已写入文本', { step: 'text_inserted', backend: 'cdp', textLength });
    debugLog('codex.cdp.textInserted', { sendId, textLength });

    const clicked = await session.evaluate(`((composer) => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0
          && rect.height > 0
          && rect.bottom > 0
          && rect.top < innerHeight
          && rect.right > 0
          && rect.left < innerWidth
          && style.display !== 'none'
          && style.visibility !== 'hidden';
      };
      const textOf = (el) => [
        el.getAttribute('aria-label') || '',
        el.getAttribute('title') || '',
        el.getAttribute('data-testid') || '',
        el.getAttribute('data-test-id') || '',
        el.getAttribute('name') || '',
        el.innerText || '',
        el.textContent || '',
      ].join(' ').replace(/\\s+/g, ' ').trim();
      const hasSendSemantics = (value) => /(^|\\s)(发送|send|submit)(\\s|$)|上箭头|arrow\\s*up|send-button|submit-button|composer-send|prompt-send|↑/i.test(value);
      const hasBlockedSemantics = (value) => /复制|copy|拷贝|关闭|close|cancel|取消|停止|stop|听写|dictation|finish\\s+the|麦克风|语音|voice|microphone|模型|model|完全访问|access|\\d+(\\.\\d+)?\\s*高|\\b\\d+(\\.\\d+)?\\s*low\\b|\\b\\d+(\\.\\d+)?\\s*high\\b|\\bgpt\\b|\\bclaude\\b|\\bo\\d+\\b/i.test(value);
      const composerRect = {
        x: Number(composer && composer.x) || 0,
        y: Number(composer && composer.y) || 0,
        width: Number(composer && composer.width) || 0,
        height: Number(composer && composer.height) || 0,
      };
      const inComposerZone = (rect) => {
        if (!composerRect.width || !composerRect.height) return false;
        const left = composerRect.x - 56;
        const right = composerRect.x + composerRect.width + 96;
        const top = composerRect.y - 64;
        const bottom = composerRect.y + composerRect.height + 110;
        const centerX = rect.x + rect.width / 2;
        const centerY = rect.y + rect.height / 2;
        return centerX >= left && centerX <= right && centerY >= top && centerY <= bottom;
      };
      const buttons = [...document.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const label = textOf(el);
          const disabled = Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true';
          const sendSemantic = hasSendSemantics(label);
          const blockedSemantic = hasBlockedSemantics(label);
          const nearComposer = inComposerZone(rect);
          const rightSideOfComposer = composerRect.width > 0 && rect.x >= composerRect.x + composerRect.width * 0.55 && rect.x <= composerRect.x + composerRect.width + 96;
          const farRightOfComposer = composerRect.width > 0 && rect.x >= composerRect.x + composerRect.width - 130 && rect.x <= composerRect.x + composerRect.width + 96;
          const centerY = rect.y + rect.height / 2;
          const verticalMatch = composerRect.height > 0 && rect.y <= composerRect.y + composerRect.height + 96 && rect.bottom >= composerRect.y - 48;
          const lowerComposerAction = composerRect.height > 0 && centerY >= composerRect.y + composerRect.height * 0.42;
          const compactIconButton = rect.width >= 18 && rect.width <= 76 && rect.height >= 18 && rect.height <= 76;
          const squareIconButton = compactIconButton && Math.abs(rect.width - rect.height) <= 18;
          const hasIcon = Boolean(el.querySelector('svg, img'));
          const visualSendCandidate = nearComposer && farRightOfComposer && verticalMatch && lowerComposerAction && squareIconButton && hasIcon && !blockedSemantic;
          const score = (sendSemantic ? 1200 : 0)
            + (visualSendCandidate ? 900 : 0)
            + (nearComposer ? 800 : 0)
            + (farRightOfComposer ? 320 : 0)
            + (rightSideOfComposer ? 160 : 0)
            + (verticalMatch ? 180 : 0)
            + (lowerComposerAction ? 180 : 0)
            - (blockedSemantic ? 2000 : 0)
            - (disabled ? 700 : 0);
          return { el, label, disabled, sendSemantic, blockedSemantic, nearComposer, rightSideOfComposer, farRightOfComposer, verticalMatch, lowerComposerAction, compactIconButton, squareIconButton, hasIcon, visualSendCandidate, score, x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: innerHeight - rect.bottom };
        })
        .filter((item) => item.nearComposer || item.sendSemantic || item.rightSideOfComposer)
        .sort((a, b) => b.score - a.score);
      const candidate = buttons.find((item) => ((item.sendSemantic && item.nearComposer) || item.visualSendCandidate) && !item.blockedSemantic && !item.disabled) || null;
      if (!candidate) {
        return {
          ok: false,
          code: 'SEND_BUTTON_NOT_FOUND',
          composer: composerRect,
          candidates: buttons.slice(0, 12).map((item) => ({
            label: item.label.slice(0, 120),
            disabled: item.disabled,
            sendSemantic: item.sendSemantic,
            blockedSemantic: item.blockedSemantic,
            nearComposer: item.nearComposer,
            rightSideOfComposer: item.rightSideOfComposer,
            farRightOfComposer: item.farRightOfComposer,
            verticalMatch: item.verticalMatch,
            lowerComposerAction: item.lowerComposerAction,
            compactIconButton: item.compactIconButton,
            squareIconButton: item.squareIconButton,
            hasIcon: item.hasIcon,
            visualSendCandidate: item.visualSendCandidate,
            score: item.score,
            x: Math.round(item.x),
            y: Math.round(item.y),
            width: Math.round(item.width),
            height: Math.round(item.height),
            bottom: Math.round(item.bottom),
          })),
        };
      }
      candidate.el.click();
      return { ok: true, label: candidate.label.slice(0, 80), x: Math.round(candidate.x), y: Math.round(candidate.y), width: Math.round(candidate.width), height: Math.round(candidate.height), nearComposer: candidate.nearComposer, score: candidate.score };
    })(${JSON.stringify(prepared)})`, 5000);
    if (clicked && clicked.ok === true) {
      pushSendEvent(sendId, 'send_step', 'CDP 已点击发送', { step: 'submit_done', backend: 'cdp', button: clicked });
      debugLog('codex.cdp.submitClick', { sendId, clicked });
    } else {
      debugLog('codex.cdp.submitFallbackEnter', { sendId, clicked });
      await session.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, 3000);
      await session.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, 3000);
      pushSendEvent(sendId, 'send_step', 'CDP 未找到安全发送按钮，已按 Enter 发送', { step: 'submit_done', backend: 'cdp', submitFallback: 'enter', buttonSearch: clicked });
    }
    await delay(TEXT_PASTE_SETTLE_MS);
    return { ok: true, backend: 'cdp', targetId: target.id, composer: prepared, submit: clicked };
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lanUrls(port) {
  const urls = [`http://localhost:${port}`];
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) urls.push(`http://${item.address}:${port}`);
    }
  }
  return urls;
}

async function route(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  debugLog('http.request', { method: req.method, pathname: url.pathname, query: url.search });
  try {
    if (url.pathname.startsWith('/uploads/')) {
      return serveUpload(req, res, url.pathname);
    }
    if (url.pathname === '/api/local-image') {
      return serveLocalImage(req, res, url.searchParams.get('path') || '');
    }
    if (url.pathname === '/' || url.pathname === '/healthz') {
      return json(res, 200, { ok: true, version: VERSION, uptimeSec: Math.floor(process.uptime()), projects: config.projects });
    }
    if (!requireAuth(req, res)) return;

    if (url.pathname === '/api/config') {
      const cdp = await getCodexCdpStatus();
      return json(res, 200, {
        ok: true,
        appName: APP_NAME,
        version: VERSION,
        lanUrls: lanUrls(PORT),
        tokenRequired: Boolean(TOKEN),
        codex: {
          sessionsDir: CODEX_SESSIONS_DIR,
          sessionsAvailable: fs.existsSync(CODEX_SESSIONS_DIR),
          bundleId: config.codexBundleId || 'com.openai.codex',
          backend: CODEX_BACKEND,
          cdp,
          allowGuiFallback: false,
          automation: { ok: false, disabled: true, error: '当前版本仅支持 CDP 发送' },
        },
        projects: config.projects,
      });
    }
	    if (url.pathname === '/api/projects') {
	      let sidebar = { projects: [], threads: [], error: '' };
	      if (url.searchParams.get('sync') === 'cdp') {
	        try {
	          sidebar = await scanCodexSidebarForCdp();
        } catch (error) {
          sidebar = { projects: [], threads: [], error: error && error.message ? error.message : String(error) };
	          debugError('codex.cdp.sidebarProjectsFailed', error);
	        }
	      }
	      const sidebarProjects = listSidebarProjects(sidebar.projects);
	      const projects = url.searchParams.get('sync') === 'cdp' && sidebarProjects.length > 0 ? sidebarProjects : listKnownProjects(sidebar.projects);
	      return json(res, 200, { ok: true, projects, cdpProjectCount: sidebar.projects.length, cdpError: sidebar.error || '' });
	    }
    if (url.pathname === '/api/roots') return json(res, 200, { ok: true, roots: config.projects.map((item) => item.path), projects: config.projects });

    if (url.pathname === '/api/files/list' || url.pathname === '/api/list') {
      const result = listDir(url.searchParams.get('projectId') || '', url.searchParams.get('path') || '');
      return json(res, 200, { ok: true, ...result });
    }
    if (url.pathname === '/api/files/read' || url.pathname === '/api/read') {
      const result = readTextFile(url.searchParams.get('projectId') || '', url.searchParams.get('path') || '');
      return json(res, 200, { ok: true, ...result });
    }
    if (url.pathname === '/api/files/write' || url.pathname === '/api/write') {
      const body = await readJsonBody(req);
      const result = writeTextFile(body.projectId || '', body.path || '', body.text || '');
      return json(res, 200, { ok: true, ...result });
    }

    if (url.pathname === '/api/mobile/uploads') {
      const result = await saveMultipart(req, url.searchParams.get('projectId') || '', 'files', 'file', `mobile-file-${Date.now()}`);
      return json(res, 200, {
        ok: true,
        path: result.file.path,
        url: uploadUrl(req, result.file.path),
        name: result.file.name,
        mimeType: result.file.mimeType,
        sourceUri: result.fields.sourceUri || '',
        workspaceId: result.fields.workspaceId || '',
        projectId: result.project.id,
        size: result.file.size,
        createdAt: new Date().toISOString(),
      });
    }
    if (url.pathname === '/api/mobile/annotations') {
      const result = await saveMultipart(req, url.searchParams.get('projectId') || '', 'annotations', 'image', `annotation-${Date.now()}.png`);
      const jsonPath = uniquePath(path.dirname(result.file.path), `${path.parse(result.file.name).name}.json`);
      let payload = {};
      try {
        payload = JSON.parse(result.fields.payload || '{}');
      } catch {
        payload = { raw: result.fields.payload || '' };
      }
      fs.writeFileSync(jsonPath, JSON.stringify({ imagePath: result.file.path, payload, createdAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
      return json(res, 200, {
        ok: true,
        imagePath: result.file.path,
        imageUrl: uploadUrl(req, result.file.path),
        jsonPath,
        projectId: result.project.id,
        createdAt: new Date().toISOString(),
      });
    }
    if (url.pathname === '/api/mobile/transcribe-audio') {
      const result = await saveMultipart(req, url.searchParams.get('projectId') || '', 'voice', 'audio', `voice-${Date.now()}.m4a`);
      try {
        const transcript = await transcribeVolcengineAudio(result.file);
        return json(res, 200, {
          ok: true,
          text: transcript.text,
          provider: transcript.provider,
          model: transcript.model,
          audioPath: result.file.path,
          audioUrl: uploadUrl(req, result.file.path),
          projectId: result.project.id,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        debugError('mobile.asr.failed', error, {
          path: result.file.path,
          mimeType: result.file.mimeType,
          size: result.file.size,
        });
        return json(res, 200, {
          ok: false,
          error: error && error.message ? error.message : String(error),
          audioPath: result.file.path,
        });
      }
    }

    if (url.pathname === '/api/mobile/automation/results' && req.method === 'GET') {
      return json(res, 200, { ok: true, results: mobileAutomationResults.slice(0, 40) });
    }
    if (url.pathname === '/api/mobile/automation/results' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const record = {
        id: String(body.id || ''),
        action: String(body.action || ''),
        ok: body.ok === true,
        status: String(body.status || ''),
        result: body.result || null,
        error: String(body.error || ''),
        source: String(body.source || 'autojs'),
        createdAt: new Date().toISOString(),
      };
      mobileAutomationResults.unshift(record);
      while (mobileAutomationResults.length > 80) mobileAutomationResults.pop();
      debugLog('mobile.automation.result', {
        id: record.id,
        action: record.action,
        ok: record.ok,
        status: record.status,
        error: textPreview(record.error, 120),
      });
      return json(res, 200, { ok: true, record });
    }

    if (url.pathname === '/api/codex/threads') {
      const projectId = url.searchParams.get('projectId') || '';
      const limit = url.searchParams.get('limit') || 500;
      const localThreads = listSessionThreadSummaries(projectId, limit);
      if (url.searchParams.get('sync') !== 'cdp') {
        return json(res, 200, { ok: true, threads: localThreads });
      }
      let sidebar = { projects: [], threads: [], error: '' };
      try {
        sidebar = await scanCodexSidebarForCdp();
      } catch (error) {
        sidebar = { projects: [], threads: [], error: error && error.message ? error.message : String(error) };
        debugError('codex.cdp.sidebarThreadsFailed', error);
      }
      const merged = mergeCodexSidebarThreads(localThreads, sidebar.threads, sidebar.projects, projectId, limit);
      return json(res, 200, { ok: true, threads: merged, cdpThreadCount: sidebar.threads.length, cdpProjectCount: sidebar.projects.length, cdpError: sidebar.error || '' });
    }
    if (url.pathname === '/api/codex/history') {
      return json(res, 200, parseCodexHistory(url.searchParams.get('threadId') || url.searchParams.get('thread') || '', Number(url.searchParams.get('limit') || 100)));
    }
    if (url.pathname === '/api/codex/thread/snapshot') {
      return json(res, 200, parseCodexThreadSnapshot(url.searchParams.get('threadId') || url.searchParams.get('thread') || '', {
        processLimit: url.searchParams.get('processLimit'),
      }));
    }
	    if (url.pathname === '/api/codex/thread/scope' && req.method === 'POST') {
	      const body = await readJsonBody(req);
	      const threadId = String(body.threadId || '');
	      if (!isCodexThreadId(threadId)) return json(res, 400, { ok: false, error: 'Bad threadId' });
      const scope = String(body.scope || '').trim().toLowerCase();
      if (scope !== 'direct' && scope !== 'project') return json(res, 400, { ok: false, error: 'Bad scope' });
      const projectId = String(body.projectId || '');
      if (scope === 'project') {
        const configured = findKnownCodexProject(projectId);
        if (!configured) return json(res, 400, { ok: false, error: projectId ? `Unknown projectId: ${projectId}` : 'Missing projectId for project scope' });
      }
      const override = persistThreadScopeOverride(threadId, scope, projectId);
      const snapshot = parseCodexThreadSnapshot(threadId, { processLimit: 0 });
      return json(res, 200, {
        ok: true,
        threadId,
        scope,
        projectId: override && override.projectId ? override.projectId : '',
	        summary: snapshot.summary || snapshot.threadSummary || null,
	      });
	    }
	    if (url.pathname === '/api/codex/thread/new' && req.method === 'POST') {
	      const body = await readJsonBody(req);
	      const requestedScope = String(body.scope || 'direct').trim().toLowerCase();
	      const scope = requestedScope === 'project' ? 'project' : 'direct';
	      if (requestedScope && requestedScope !== 'direct' && requestedScope !== 'project') {
	        return json(res, 400, { ok: false, error: 'Bad scope' });
	      }
	      const requestedProjectId = String(body.projectId || '');
	      if (scope === 'project' && requestedProjectId.length === 0) {
	        return json(res, 400, { ok: false, error: 'Missing projectId for project-scoped new thread' });
	      }
	      let project;
	      try {
	        project = getCodexProjectForScope(requestedProjectId, '', scope);
	      } catch (error) {
	        return json(res, 400, { ok: false, error: error && error.message ? error.message : String(error) });
	      }
	      try {
	        await findCodexCdpTarget();
	        await withCodexCdp(async (session) => {
	          await createCodexThreadViaCdp(session, {
	            scope,
	            projectName: project.name || '',
	            projectPath: project.path || '',
	            sendId: '',
	          });
	        });
	        const prepared = rememberPreparedCodexNewThread(scope, project);
	        return json(res, 200, {
	          ok: true,
	          scope,
	          projectId: prepared.projectId,
	          projectName: prepared.projectName,
	          cwd: prepared.cwd,
	          preparedNewThreadId: prepared.id,
	          preparedAt: new Date(prepared.createdAt).toISOString(),
	          threadId: '',
	          sessionFile: '',
	        });
	      } catch (error) {
	        debugError('codex.thread.new.failed', error, { scope, projectId: project.id, projectName: project.name });
	        return json(res, 200, {
	          ok: false,
	          scope,
	          projectId: project.id,
	          projectName: project.name,
	          cdpAvailable: false,
	          code: error && error.code ? error.code : '',
	          error: error && error.message ? error.message : String(error),
	        });
	      }
	    }
	    if (url.pathname === '/api/codex/thread/updates') {
      return json(res, 200, parseCodexThreadUpdates({
        threadId: url.searchParams.get('threadId') || url.searchParams.get('thread') || '',
        sessionFile: url.searchParams.get('session') || '',
        messageCount: url.searchParams.get('messageCount') || '0',
        processCount: url.searchParams.get('processCount') || '0',
        fileSize: url.searchParams.get('fileSize') || '0',
        byteOffset: url.searchParams.get('byteOffset') || '0',
        openTurnStartedAt: url.searchParams.get('openTurnStartedAt') || '',
        openTurnHasAssistantFinal: url.searchParams.get('openTurnHasAssistantFinal') || '',
      }));
    }
    if (url.pathname === '/api/codex/cdp/status') {
      return json(res, 200, await getCodexCdpStatus());
    }
    if (url.pathname === '/api/codex/status') {
      const statusPayload = buildThreadRunStatus({
        sendId: url.searchParams.get('sendId') || '',
        since: url.searchParams.get('since') || '',
        threadId: url.searchParams.get('threadId') || url.searchParams.get('thread') || '',
        sessionFile: url.searchParams.get('session') || '',
        expectNewThread: url.searchParams.get('expectNewThread') === '1' || url.searchParams.get('expectNewThread') === 'true',
        excludeThreadId: url.searchParams.get('excludeThread') || '',
        cwd: url.searchParams.get('cwd') || '',
      });
      debugLog('codex.status.response', {
        sendId: url.searchParams.get('sendId') || '',
        accepted: statusPayload.accepted,
        active: statusPayload.active,
        status: statusPayload.status,
        threadId: statusPayload.threadId,
        sessionFile: statusPayload.sessionFile,
        events: Array.isArray(statusPayload.events) ? statusPayload.events.length : 0,
      });
      if (url.searchParams.get('compact') === '1') {
        statusPayload.events = Array.isArray(statusPayload.events) ? statusPayload.events.slice(-24) : [];
        statusPayload.steps = [];
      }
      return json(res, 200, statusPayload);
    }
    if (url.pathname === '/api/codex/send') {
      const body = await readJsonBody(req);
      const textValue = String(body.text || '').trim();
      if (!textValue) return json(res, 400, { ok: false, error: 'Missing text' });
      const requestedThreadId = String(body.threadId || '');
      if (requestedThreadId && !isCodexThreadId(requestedThreadId)) return json(res, 400, { ok: false, error: 'Bad threadId' });
      const requestedProjectId = String(body.projectId || '');
      const requestedNewThreadScope = String(body.newThreadScope || '').trim().toLowerCase();
      if (requestedNewThreadScope && requestedNewThreadScope !== 'direct' && requestedNewThreadScope !== 'project') {
        return json(res, 400, { ok: false, error: 'Bad newThreadScope' });
      }
      const effectiveNewThreadScope = requestedThreadId
        ? ''
        : (requestedNewThreadScope || (requestedProjectId.length > 0 ? 'project' : 'direct'));
      if (!requestedThreadId && effectiveNewThreadScope === 'project' && requestedProjectId.length == 0) {
        return json(res, 400, { ok: false, error: 'Missing projectId for project-scoped new thread' });
      }
      let project;
      try {
        project = getCodexProjectForScope(requestedProjectId, requestedThreadId, effectiveNewThreadScope);
      } catch (error) {
        return json(res, 400, {
          ok: false,
          code: error && error.code ? error.code : 'CODEX_PROJECT_SCOPE_ERROR',
          error: error && error.message ? error.message : String(error),
          requestedProjectId,
          expectedProjectId: error && error.expectedProjectId ? error.expectedProjectId : '',
          threadCwd: error && error.threadCwd ? error.threadCwd : '',
          threadId: requestedThreadId,
        });
      }
      const clientRequestId = String(body.clientRequestId || '');
      const assumeThreadSynced = body.assumeThreadSynced === true;
      const forceThreadSwitch = Boolean(requestedThreadId) || body.forceThreadSwitch === true;
	      const backend = String(body.backend || CODEX_BACKEND || 'cdp').toLowerCase();
	      if (backend && backend !== 'cdp') {
	        return json(res, 400, { ok: false, error: '当前版本仅支持 CDP 发送，不再支持 GUI/deep link fallback。' });
	      }
	      const preparedNewThread = requestedThreadId ? null : consumePreparedCodexNewThread(effectiveNewThreadScope, project.id);
	      debugLog('codex.send.request', {
	        projectId: project.id,
	        projectPath: project.path,
	        requestedThreadId,
        requestedProjectId,
        requestedNewThreadScope,
        effectiveNewThreadScope,
        clientRequestId,
	        backend,
	        defaultBackend: CODEX_BACKEND,
	        assumeThreadSynced,
	        forceThreadSwitch,
	        preparedNewThreadId: preparedNewThread ? preparedNewThread.id : '',
	        textLength: textValue.length,
	        textPreview: textPreview(textValue),
	      });
      const existingRecord = clientRequestId ? recentSends.get(clientRequestId) : null;
      if (existingRecord) {
        debugLog('codex.send.duplicate', {
          sendId: existingRecord.sendId,
          accepted: existingRecord.accepted,
          threadId: existingRecord.threadId,
          sessionFile: existingRecord.watch.sessionFile,
        });
        return json(res, 200, {
          ok: true,
          duplicate: true,
          sendId: existingRecord.sendId,
          accepted: existingRecord.accepted,
          sentAt: new Date(existingRecord.createdAt).toISOString(),
          projectId: existingRecord.projectId,
          threadId: existingRecord.threadId,
          sessionFile: existingRecord.watch.sessionFile,
          backend: existingRecord.backend || 'cdp',
          watch: existingRecord.watch,
          events: existingRecord.events.slice(-30),
        });
      }
      const record = createSendRecord({
        clientRequestId,
        project,
        threadId: requestedThreadId,
        textValue,
        newThreadScope: effectiveNewThreadScope,
      });
      if (record.accepted) {
        return json(res, 200, {
          ok: true,
          sendId: record.sendId,
          accepted: true,
          sentAt: new Date(record.createdAt).toISOString(),
          projectId: project.id,
          threadId: record.threadId,
          sessionFile: record.watch.sessionFile,
          backend: record.backend || 'cdp',
          watch: record.watch,
          events: record.events,
        });
      }
      record.backend = 'cdp';
      try {
	        await sendTextWithCdp(textValue, requestedThreadId, project.path, record.sendId, {
	          assumeThreadSynced,
	          forceThreadSwitch,
	          newThreadScope: effectiveNewThreadScope,
	          projectName: project.name || '',
	          skipCreateNewThread: preparedNewThread != null,
	        });
      } catch (error) {
        debugError('codex.send.backendFailed', error, { sendId: record.sendId, backend: record.backend });
        record.updatedAt = Date.now();
        pushSendEvent(record.sendId, 'task_error', error && error.message ? error.message : String(error), {
          step: 'backend_failed',
          backend: record.backend,
          code: error && error.code ? error.code : '',
        });
        return json(res, 200, {
          ok: false,
          sendId: record.sendId,
          accepted: false,
          sentAt: new Date().toISOString(),
          projectId: project.id,
          threadId: record.threadId,
          sessionFile: record.watch.sessionFile,
          backend: record.backend,
          cdpAvailable: false,
          cdpError: error && error.message ? error.message : String(error),
          code: error && error.code ? error.code : '',
          error: error && error.message ? error.message : String(error),
          watch: record.watch,
          events: record.events.slice(-30),
        });
      }
      let accepted = false;
      let sessionFile = requestedThreadId ? findSessionFile(requestedThreadId) : '';
      if (requestedThreadId) {
        accepted = await waitForUserMessageInFile(sessionFile, record.sinceMs, textValue);
      } else {
        sessionFile = await waitForSessionFileForNewSend({
          sinceMs: record.sinceMs,
          text: textValue,
          cwd: record.watch.cwd,
          excludeThreadId: record.watch.excludeThreadId,
        });
        accepted = Boolean(sessionFile);
      }
      if (accepted && sessionFile && !requestedThreadId && record.newThreadScope === 'direct') {
        const acceptedMeta = readSessionHeader(sessionFile);
        const acceptedCwd = String(acceptedMeta && acceptedMeta.cwd || '').trim();
        if (!isDirectCodexConversationCwd(acceptedCwd)) {
          const acceptedThreadId = threadIdFromFile(sessionFile);
          record.updatedAt = Date.now();
          record.accepted = false;
          record.threadId = acceptedThreadId || '';
          record.sessionFile = sessionFile;
          record.watch.threadId = acceptedThreadId || '';
          record.watch.sessionFile = path.basename(sessionFile);
          const errorText = `AI 助手必须创建为无文件夹的独立会话，但 Codex 返回了工作区 cwd：${acceptedCwd}`;
          pushSendEvent(record.sendId, 'task_error', errorText, {
            step: 'direct_scope_mismatch',
            backend: record.backend,
            code: 'CODEX_DIRECT_SCOPE_MISMATCH',
            cwd: acceptedCwd,
            threadId: acceptedThreadId,
            sessionFile: path.basename(sessionFile),
          });
          debugLog('codex.send.directScopeMismatch', {
            sendId: record.sendId,
            threadId: acceptedThreadId,
            sessionFile: path.basename(sessionFile),
            cwd: acceptedCwd,
          });
          return json(res, 200, {
            ok: false,
            sendId: record.sendId,
            accepted: false,
            sentAt: new Date().toISOString(),
            projectId: project.id,
            threadId: record.threadId,
            sessionFile: record.watch.sessionFile,
            backend: record.backend,
            cdpAvailable: record.backend === 'cdp',
            cdpError: errorText,
            code: 'CODEX_DIRECT_SCOPE_MISMATCH',
            error: errorText,
            watch: record.watch,
            events: record.events.slice(-30),
          });
        }
      }
      if (accepted && sessionFile) {
        record.accepted = true;
        record.threadId = threadIdFromFile(sessionFile);
        record.sessionFile = sessionFile;
        record.watch.threadId = record.threadId;
        record.watch.sessionFile = path.basename(sessionFile);
        record.watch.expectNewThread = false;
        record.watch.excludeThreadId = '';
        if (!requestedThreadId && record.threadId) {
          try {
            if (record.newThreadScope === 'direct') {
              persistThreadScopeOverride(record.threadId, 'direct', '');
            } else if (record.newThreadScope === 'project' && record.projectId) {
              persistThreadScopeOverride(record.threadId, 'project', record.projectId);
            }
          } catch (error) {
            debugError('codex.send.persistThreadScopeOverride.failed', error, {
              sendId: record.sendId,
              threadId: record.threadId,
              scope: record.newThreadScope,
              projectId: record.projectId,
            });
          }
        }
        record.updatedAt = Date.now();
        pushSendEvent(record.sendId, 'user_message_received', 'Codex 已接收消息', { step: 'message_observed' });
        debugLog('codex.send.accepted', {
          sendId: record.sendId,
          threadId: record.threadId,
          sessionFile: record.watch.sessionFile,
        });
      } else {
        record.updatedAt = Date.now();
        pushSendEvent(record.sendId, 'accept_timeout', '已发送，但还没有在 Codex 会话日志中确认收到', { step: 'accept_timeout' });
        debugLog('codex.send.acceptTimeout', {
          sendId: record.sendId,
          requestedThreadId,
          sessionFile: sessionFile ? path.basename(sessionFile) : '',
          watch: record.watch,
        });
      }
      debugLog('codex.send.response', {
        sendId: record.sendId,
        accepted: record.accepted,
        threadId: record.threadId,
        sessionFile: record.watch.sessionFile,
        backend: record.backend,
        events: record.events.length,
      });
      return json(res, 200, {
        ok: true,
        sendId: record.sendId,
        accepted: record.accepted,
        sentAt: new Date().toISOString(),
        projectId: project.id,
        threadId: record.threadId,
        sessionFile: record.watch.sessionFile,
        backend: record.backend,
        cdpAvailable: record.backend === 'cdp',
        watch: record.watch,
        events: record.events.slice(-30),
      });
    }

    return json(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    debugError('http.route.failed', error, { method: req.method, pathname: url.pathname, query: url.search });
    const info = errorInfo(error);
    return json(res, 500, {
      ok: false,
      error: info.message,
      detail: info.stderr || info.stdout || info.message,
      code: info.code,
      stack: info.stack,
    });
  }
}

const server = http.createServer((req, res) => {
  route(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`${APP_NAME} ${VERSION}`);
  console.log(`Local: http://localhost:${PORT}`);
  for (const item of lanUrls(PORT).filter((value) => !value.includes('localhost'))) console.log(`LAN:   ${item}`);
  console.log(`Projects: ${config.projects.length}`);
});
