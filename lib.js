import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export const DIR = process.env.PINTEREST_MCP_DIR || path.join(os.homedir(), ".config", "pinterest-mcp");
export const MEDIA_DIR = path.join(DIR, "media");
const CONFIG = path.join(DIR, "config.json");
const TOKENS = path.join(DIR, "tokens.json");
const QUEUE = path.join(DIR, "queue.json");
const LOCK = path.join(DIR, "queue.lock");
export const LOG = path.join(DIR, "scheduler.log");

fs.mkdirSync(MEDIA_DIR, { recursive: true, mode: 0o700 });

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const writeJson = (f, v) => { const t = f + ".tmp"; fs.writeFileSync(t, JSON.stringify(v, null, 2), { mode: 0o600 }); fs.renameSync(t, f); };

export const getConfig = () => readJson(CONFIG, {});
export const saveConfig = (c) => writeJson(CONFIG, c);
export const getTokens = () => readJson(TOKENS, null);
export const saveTokens = (t) => writeJson(TOKENS, t);

export function log(msg) {
  fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`);
}

const cfgSandbox = () => process.env.PINTEREST_SANDBOX === "1" || getConfig().sandbox === true;
export const apiBase = () => (cfgSandbox() ? "https://api-sandbox.pinterest.com/v5" : "https://api.pinterest.com/v5");

// ---------- auth ----------
export async function tokenRequest(params) {
  const c = getConfig();
  if (!c.app_id || !c.app_secret) throw new Error("No app_id/app_secret. Run: node ~/pinterest-mcp/auth.js");
  const res = await fetch("https://api.pinterest.com/v5/oauth/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${c.app_id}:${c.app_secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OAuth error ${res.status}: ${JSON.stringify(j)}`);
  const now = Date.now();
  const old = getTokens() || {};
  const t = {
    access_token: j.access_token,
    refresh_token: j.refresh_token || old.refresh_token,
    expires_at: now + (j.expires_in || 0) * 1000,
    refresh_expires_at: j.refresh_token_expires_in ? now + j.refresh_token_expires_in * 1000 : old.refresh_expires_at,
    scope: j.scope,
  };
  saveTokens(t);
  return t;
}

export async function getAccessToken() {
  if (process.env.PINTEREST_ACCESS_TOKEN) return process.env.PINTEREST_ACCESS_TOKEN;
  const c = getConfig();
  if (c.access_token) return c.access_token; // manual / sandbox token
  const t = getTokens();
  if (!t) throw new Error("Not authorized. Run: node ~/pinterest-mcp/auth.js");
  if (Date.now() < t.expires_at - 5 * 60_000) return t.access_token;
  if (!t.refresh_token) throw new Error("Token expired. Run: node ~/pinterest-mcp/auth.js");
  return (await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token })).access_token;
}

// ---------- API ----------
export async function api(method, p, body) {
  const token = await getAccessToken();
  const res = await fetch(apiBase() + p, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let j; try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
  if (!res.ok) throw new Error(`Pinterest API ${method} ${p} -> ${res.status}: ${j.message || text}`);
  return j;
}

export async function listBoards() {
  const out = []; let bookmark;
  do {
    const q = new URLSearchParams({ page_size: "100", ...(bookmark ? { bookmark } : {}) });
    const j = await api("GET", `/boards?${q}`);
    out.push(...(j.items || [])); bookmark = j.bookmark;
  } while (bookmark);
  return out.map((b) => ({ id: b.id, name: b.name, privacy: b.privacy, pin_count: b.pin_count, description: b.description }));
}

export async function resolveBoard(board) {
  if (!board) throw new Error("board is required (id or name)");
  if (/^\d+$/.test(board)) return board;
  const boards = await listBoards();
  const b = boards.find((x) => x.name.toLowerCase() === board.toLowerCase().trim());
  if (!b) throw new Error(`Board "${board}" not found. Existing: ${boards.map((x) => x.name).join(", ") || "(none)"}`);
  return b.id;
}

export async function resolveSection(boardId, section) {
  if (!section) return undefined;
  if (/^\d+$/.test(section)) return section;
  const j = await api("GET", `/boards/${boardId}/sections?page_size=100`);
  const s = (j.items || []).find((x) => x.name.toLowerCase() === section.toLowerCase().trim());
  if (!s) throw new Error(`Section "${section}" not found on board`);
  return s.id;
}

const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };
export const IMAGE_EXT = Object.keys(MIME);

export function expandPath(p) {
  return path.resolve(p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
}

export function checkImage(p) {
  const f = expandPath(p);
  if (!fs.existsSync(f)) throw new Error(`File not found: ${f}`);
  const ext = path.extname(f).toLowerCase();
  if (!MIME[ext]) throw new Error(`Unsupported format ${ext} (${f}). Pinterest API accepts JPG/PNG.`);
  if (fs.statSync(f).size > 20 * 1024 * 1024) throw new Error(`Image > 20MB: ${f}`);
  return f;
}

export function buildDescription(description = "", tags = []) {
  const hashtags = [...new Set(tags.map((t) => "#" + String(t).replace(/^#/, "").replace(/[^\p{L}\p{N}_]/gu, "")).filter((t) => t.length > 1))];
  let d = description.trim();
  for (const h of hashtags) {
    const next = d ? `${d}${d.includes("\n#") || /#\S+$/.test(d) ? " " : "\n\n"}${h}` : h;
    if (next.length > 800) break;
    d = next;
  }
  return d.slice(0, 800);
}

// pin = {image_path, board, section?, title, description?, tags?, link?, alt_text?}
export async function preparePin(pin) {
  const file = checkImage(pin.image_path);
  const board_id = await resolveBoard(pin.board);
  const board_section_id = await resolveSection(board_id, pin.section);
  return {
    file,
    body: {
      board_id,
      ...(board_section_id ? { board_section_id } : {}),
      title: (pin.title || "").slice(0, 100),
      description: buildDescription(pin.description, pin.tags || []),
      ...(pin.link ? { link: pin.link } : {}),
      ...(pin.alt_text ? { alt_text: pin.alt_text.slice(0, 500) } : {}),
    },
  };
}

export async function postPin(file, body) {
  const data = fs.readFileSync(file).toString("base64");
  const content_type = MIME[path.extname(file).toLowerCase()];
  const j = await api("POST", "/pins", { ...body, media_source: { source_type: "image_base64", content_type, data } });
  return { pin_id: j.id, url: `https://www.pinterest.com/pin/${j.id}/` };
}

// ---------- time ----------
export function parseTime(s) {
  const d = new Date(s);
  if (isNaN(d)) throw new Error(`Cannot parse time "${s}". Use e.g. "2025-07-01 18:30" (local) or ISO.`);
  return d;
}
export const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
export const fmtLocal = (d) => new Date(d).toLocaleString("sv-SE", { hour12: false }) + ` (${tz()})`;

// ---------- queue ----------
export const getQueue = () => readJson(QUEUE, []);
const saveQueue = (q) => writeJson(QUEUE, q);

function withLock(fn) {
  return (async () => {
    let fd;
    for (let i = 0; i < 50; i++) {
      try { fd = fs.openSync(LOCK, "wx"); break; } catch {
        try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 10 * 60_000) fs.unlinkSync(LOCK); } catch {}
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (fd === undefined) throw new Error("Queue is locked, try again");
    try { return await fn(); } finally { fs.closeSync(fd); try { fs.unlinkSync(LOCK); } catch {} }
  })();
}

export async function schedulePin(prepared, when) {
  const id = crypto.randomUUID().slice(0, 8);
  const copy = path.join(MEDIA_DIR, `${id}${path.extname(prepared.file).toLowerCase()}`);
  fs.copyFileSync(prepared.file, copy);
  const item = { id, status: "pending", publish_at: when.toISOString(), created_at: new Date().toISOString(), source_file: prepared.file, file: copy, body: prepared.body, attempts: 0 };
  await withLock(async () => { const q = getQueue(); q.push(item); saveQueue(q); });
  return item;
}

export async function cancelScheduled(id) {
  return withLock(async () => {
    const q = getQueue(); const it = q.find((x) => x.id === id);
    if (!it) throw new Error(`No scheduled item ${id}`);
    if (it.status !== "pending") throw new Error(`Item ${id} is ${it.status}, cannot cancel`);
    it.status = "cancelled"; try { fs.unlinkSync(it.file); } catch {}
    saveQueue(q); return it;
  });
}

export async function reschedule(id, when) {
  return withLock(async () => {
    const q = getQueue(); const it = q.find((x) => x.id === id);
    if (!it || it.status !== "pending") throw new Error(`No pending item ${id}`);
    it.publish_at = when.toISOString(); saveQueue(q); return it;
  });
}

export async function processDue({ force = false } = {}) {
  return withLock(async () => {
    const q = getQueue(); const now = Date.now(); const results = [];
    for (const it of q) {
      if (it.status !== "pending" || (!force && new Date(it.publish_at).getTime() > now)) continue;
      try {
        const r = await postPin(it.file, it.body);
        Object.assign(it, { status: "done", posted_at: new Date().toISOString(), result: r });
        try { fs.unlinkSync(it.file); } catch {}
        log(`posted ${it.id} "${it.body.title}" -> ${r.url}`);
      } catch (e) {
        it.attempts++; it.error = e.message;
        if (it.attempts >= 3) it.status = "failed";
        log(`error ${it.id} (attempt ${it.attempts}): ${e.message}`);
      }
      results.push({ id: it.id, status: it.status, title: it.body.title, ...(it.result || {}), ...(it.error && it.status !== "done" ? { error: it.error } : {}) });
      saveQueue(q);
    }
    // prune finished entries older than 30 days
    const cutoff = now - 30 * 864e5;
    saveQueue(q.filter((x) => x.status === "pending" || new Date(x.posted_at || x.publish_at).getTime() > cutoff));
    return results;
  });
}
