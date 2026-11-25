// Persistent local memory for JARVIS V2 (Batch 10): SQLite-backed, no local AI/models/embeddings.
// Stored in the sidecar data directory (ROAMIES_DATA_DIR/sidecar or ~/.gg/sidecar) so it survives restarts.
// All access should flow through Agent Core tools (permissioned) or explicit UI actions; this module is pure storage.

import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const CATEGORIES = Object.freeze(['preferences', 'projects', 'conversations', 'tasks']);
export const MEMORY_DB_PATH = () => process.env.ROAMIES_DATA_DIR
  ? path.join(process.env.ROAMIES_DATA_DIR, 'sidecar', 'memory.sqlite')
  : path.join(os.homedir(), '.gg', 'sidecar', 'memory.sqlite');

let db = null;
const embeddingCache = new Map();

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
}

function open() {
  if (db) return db;
  const file = MEMORY_DB_PATH();
  ensureDir(file);
  db = new DatabaseSync(file);
  try { db.exec('PRAGMA journal_mode=WAL'); } catch {}
  db.exec(`CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    embedding TEXT
  )`);
  try { db.exec('ALTER TABLE memories ADD COLUMN embedding TEXT'); } catch {}
  db.exec('CREATE INDEX IF NOT EXISTS memories_category_idx ON memories(category)');
  db.exec('CREATE INDEX IF NOT EXISTS memories_updated_idx ON memories(updated_at DESC)');
  return db;
}

function normalizeCategory(cat) {
  const c = String(cat ?? '').toLowerCase().trim();
  if (!CATEGORIES.includes(c)) throw new Error(`Invalid category "${cat}". Use one of: ${CATEGORIES.join(', ')}.`);
  return c;
}

function cleanText(v, name, max = 4000) {
  const s = String(v ?? '').trim();
  if (!s) throw new Error(`${name} is required.`);
  return s.length > max ? s.slice(0, max) : s;
}

function cleanOptionalText(v, max = 200) {
  const s = String(v ?? '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function maybeSecret(value) {
  const s = String(value ?? '');
  if (!s) return null;
  // High-signal secret material we must never auto-store.
  const rules = [
    [/\b(password|passwd|pwd)\b\s*[:=]/i, 'password'],
    [/\b(api[_ -]?key|secret[_ -]?key|private[_ -]?key|access[_ -]?token|bearer)\b\s*[:=]/i, 'API key/token'],
    [/\b(cookie|cookies|set-cookie)\b\s*[:=]/i, 'cookie'],
    [/\b(session[_ -]?id|session[_ -]?token|sid)\b\s*[:=]/i, 'session token'],
    [/(?:sk-[A-Za-z0-9]{16,}|AIza[0-9A-Za-z\-_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/, 'credential-like token'],
  ];
  for (const [re, label] of rules) if (re.test(s)) return label;
  return null;
}

function assertNoSecrets(fields) {
  for (const [name, value] of Object.entries(fields)) {
    const hit = maybeSecret(value);
    if (hit) throw new Error(`Refusing to store ${name}: looks like it contains a ${hit}. Passwords, API keys, cookies and session tokens must not be saved in memory.`);
  }
}

function rowToMemory(r) {
  if (!r) return null;
  let emb = null;
  if (r.embedding) {
    try { emb = JSON.parse(r.embedding); } catch {}
  }
  return { id: r.id, category: r.category, title: r.title || '', content: r.content, createdAt: r.created_at, updatedAt: r.updated_at, embedding: emb };
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const mag = Math.sqrt(normA) * Math.sqrt(normB);
  return mag ? dot / mag : 0;
}

export function memorySave({ category, title = '', content, embedding = null }) {
  const cat = normalizeCategory(category);
  const body = cleanText(content, 'content', 8000);
  const head = cleanOptionalText(title, 200);
  assertNoSecrets({ title: head, content: body });
  const d = open();
  const id = `m${randomBytes(4).toString('hex')}`;
  const now = Date.now();
  const embText = Array.isArray(embedding) ? JSON.stringify(embedding) : null;
  d.prepare('INSERT INTO memories (id, category, title, content, created_at, updated_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, cat, head, body, now, now, embText);
  if (Array.isArray(embedding) && embedding.length > 0) {
    const vec = new Float32Array(embedding);
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    embeddingCache.set(id, { vec, mag: Math.sqrt(norm), category: cat });
  }
  return rowToMemory(d.prepare('SELECT * FROM memories WHERE id = ?').get(id));
}

export function memoryList({ category = null, limit = 50 } = {}) {
  const d = open();
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  if (category != null && String(category).trim() !== '') {
    const cat = normalizeCategory(category);
    return d.prepare('SELECT * FROM memories WHERE category = ? ORDER BY updated_at DESC, created_at DESC LIMIT ?').all(cat, lim).map(rowToMemory);
  }
  return d.prepare('SELECT * FROM memories ORDER BY updated_at DESC, created_at DESC LIMIT ?').all(lim).map(rowToMemory);
}

export function memorySearch({ query, category = null, limit = 20 } = {}) {
  const q = cleanText(query, 'query', 200).toLowerCase();
  const d = open();
  const lim = Math.max(1, Math.min(100, Number(limit) || 20));
  const like = `%${q}%`;
  if (category != null && String(category).trim() !== '') {
    const cat = normalizeCategory(category);
    return d.prepare(`SELECT * FROM memories WHERE category = ? AND (lower(content) LIKE ? OR lower(title) LIKE ? OR lower(category) LIKE ?)
      ORDER BY updated_at DESC, created_at DESC LIMIT ?`).all(cat, like, like, like, lim).map(rowToMemory);
  }
  return d.prepare(`SELECT * FROM memories WHERE (lower(content) LIKE ? OR lower(title) LIKE ? OR lower(category) LIKE ?)
    ORDER BY updated_at DESC, created_at DESC LIMIT ?`).all(like, like, like, lim).map(rowToMemory);
}

export async function memorySemanticSearch({ query = '', embedding = null, category = null, limit = 20, threshold = 0.2, embedFn = null } = {}) {
  let targetVec = Array.isArray(embedding) ? embedding : null;
  if (!targetVec && typeof embedFn === 'function' && query) {
    try { targetVec = await embedFn(query); } catch {}
  }

  // If no target vector can be created or provided, fall back gracefully to text search
  if (!targetVec) {
    const results = memorySearch({ query: query || '', category, limit });
    return results.map((r) => ({ ...r, score: 1.0 }));
  }

  const d = open();
  const lim = Math.max(1, Math.min(100, Number(limit) || 20));
  const cat = category != null && String(category).trim() !== '' ? normalizeCategory(category) : null;

  // Pre-calculate target vector magnitude
  let targetNorm = 0;
  for (let i = 0; i < targetVec.length; i++) targetNorm += targetVec[i] * targetVec[i];
  const targetMag = Math.sqrt(targetNorm);
  if (!targetMag) return [];

  // Populate cache from SQLite if cold
  if (embeddingCache.size === 0) {
    const rows = d.prepare('SELECT id, category, embedding FROM memories WHERE embedding IS NOT NULL').all();
    for (const row of rows) {
      try {
        const arr = JSON.parse(row.embedding);
        if (Array.isArray(arr) && arr.length > 0) {
          const vec = new Float32Array(arr);
          let norm = 0;
          for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
          embeddingCache.set(row.id, { vec, mag: Math.sqrt(norm), category: row.category });
        }
      } catch {}
    }
  }

  const scored = [];
  for (const [id, entry] of embeddingCache.entries()) {
    if (cat && entry.category !== cat) continue;
    if (entry.vec.length !== targetVec.length || !entry.mag) continue;
    let dot = 0;
    const v = entry.vec;
    for (let i = 0; i < targetVec.length; i++) {
      dot += targetVec[i] * v[i];
    }
    const sim = dot / (targetMag * entry.mag);
    if (sim >= threshold) {
      scored.push({ id, score: Number(sim.toFixed(4)) });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, lim);
  if (!top.length) return [];

  // Fetch full details only for the matched top slice
  const getStmt = d.prepare('SELECT * FROM memories WHERE id = ?');
  return top.map((s) => {
    const row = getStmt.get(s.id);
    const mem = rowToMemory(row);
    return mem ? { ...mem, score: s.score } : null;
  }).filter((m) => m != null);
}

export function memoryGet({ id }) {
  const key = String(id ?? '').trim();
  if (!key) throw new Error('id is required.');
  const d = open();
  return rowToMemory(d.prepare('SELECT * FROM memories WHERE id = ?').get(key));
}

export function memoryUpdate({ id, category = null, title = null, content = null, embedding = null }) {
  const key = String(id ?? '').trim();
  if (!key) throw new Error('id is required.');
  const d = open();
  const cur = d.prepare('SELECT * FROM memories WHERE id = ?').get(key);
  if (!cur) throw new Error(`No memory with id ${key}.`);
  const cat = category != null ? normalizeCategory(category) : cur.category;
  const head = title != null ? cleanOptionalText(title, 200) : (cur.title || '');
  const body = content != null ? cleanText(content, 'content', 8000) : cur.content;
  assertNoSecrets({ title: head, content: body });
  const now = Date.now();
  const embText = embedding !== null ? (Array.isArray(embedding) ? JSON.stringify(embedding) : null) : cur.embedding;
  d.prepare('UPDATE memories SET category = ?, title = ?, content = ?, updated_at = ?, embedding = ? WHERE id = ?').run(cat, head, body, now, embText, key);
  if (embedding !== null) {
    if (Array.isArray(embedding) && embedding.length > 0) {
      const vec = new Float32Array(embedding);
      let norm = 0;
      for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
      embeddingCache.set(key, { vec, mag: Math.sqrt(norm), category: cat });
    } else {
      embeddingCache.delete(key);
    }
  }
  return rowToMemory(d.prepare('SELECT * FROM memories WHERE id = ?').get(key));
}

export function memoryDelete({ id }) {
  const key = String(id ?? '').trim();
  if (!key) throw new Error('id is required.');
  const d = open();
  const cur = d.prepare('SELECT * FROM memories WHERE id = ?').get(key);
  if (!cur) throw new Error(`No memory with id ${key}.`);
  d.prepare('DELETE FROM memories WHERE id = ?').run(key);
  embeddingCache.delete(key);
  return { ok: true, id: key };
}

export function formatMemory(m) {
  if (!m) return '';
  const when = new Date(m.updatedAt || m.createdAt).toISOString();
  const title = m.title ? ` — ${m.title}` : '';
  return `${m.id} [${m.category}]${title} (updated ${when}): ${m.content}`;
}

export function formatMemories(list) {
  if (!Array.isArray(list) || !list.length) return 'No saved memories.';
  return list.map(formatMemory).join('\n');
}

export function closeMemoryDb() {
  try { db?.close(); } catch {}
  db = null;
  embeddingCache.clear();
}
