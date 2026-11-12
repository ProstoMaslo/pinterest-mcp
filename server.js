#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as L from "./lib.js";

const server = new McpServer(
  { name: "pinterest", version: "1.0.0" },
  {
    instructions:
      "Pinterest publishing via official API v5. Images come from local disk (JPG/PNG). " +
      "Write titles/descriptions in English, SEO-friendly: title <=100 chars, description <=800 chars incl. hashtags, 3-8 relevant tags. " +
      "Pass publish_at (local time like '2025-07-01 18:30') to schedule instead of posting now. Call status first if unsure about the current time.",
  }
);

const ok = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const wrap = (fn) => async (args) => {
  try { return ok(await fn(args)); } catch (e) { return { isError: true, content: [{ type: "text", text: String(e.message || e) }] }; }
};

const pinShape = {
  image_path: z.string().describe("Local path to JPG/PNG image"),
  board: z.string().describe("Board name or id"),
  section: z.string().optional().describe("Board section name or id"),
  title: z.string().max(100).describe("Pin title, English, <=100 chars"),
  description: z.string().optional().describe("Pin description, English"),
  tags: z.array(z.string()).optional().describe("Tags, appended to description as #hashtags"),
  link: z.string().url().optional().describe("Destination URL"),
  alt_text: z.string().optional().describe("Alt text for accessibility, <=500 chars"),
  publish_at: z.string().optional().describe("Schedule time, local ('2025-07-01 18:30') or ISO. Omit to publish now."),
};

async function createOne(pin) {
  const prepared = await L.preparePin(pin);
  if (pin.publish_at) {
    const when = L.parseTime(pin.publish_at);
    const it = await L.schedulePin(prepared, when);
    return { scheduled: true, id: it.id, title: it.body.title, publish_at: L.fmtLocal(when), past_due: when < new Date() };
  }
  return { published: true, title: prepared.body.title, ...(await L.postPin(prepared.file, prepared.body)) };
}

server.registerTool("status", {
  description: "Auth status, API mode (sandbox/production), current local time and queue summary",
  inputSchema: {},
}, wrap(async () => {
  const q = L.getQueue();
  let user = null, auth = "ok";
  try { const u = await L.api("GET", "/user_account"); user = u.username; } catch (e) { auth = e.message; }
  const t = L.getTokens();
  return {
    auth, user, api: L.apiBase(), now: L.fmtLocal(new Date()),
    token_expires: t?.expires_at ? L.fmtLocal(t.expires_at) : undefined,
    refresh_token_expires: t?.refresh_expires_at ? L.fmtLocal(t.refresh_expires_at) : undefined,
    queue: { pending: q.filter((x) => x.status === "pending").length, failed: q.filter((x) => x.status === "failed").length },
  };
}));

server.registerTool("list_boards", { description: "List your Pinterest boards", inputSchema: {} }, wrap(() => L.listBoards()));

server.registerTool("list_sections", {
  description: "List sections of a board", inputSchema: { board: z.string().describe("Board name or id") },
}, wrap(async ({ board }) => {
  const id = await L.resolveBoard(board);
  return ((await L.api("GET", `/boards/${id}/sections?page_size=100`)).items || []).map((s) => ({ id: s.id, name: s.name }));
}));

server.registerTool("create_board", {
  description: "Create a new board",
  inputSchema: {
    name: z.string(), description: z.string().optional(),
    privacy: z.enum(["PUBLIC", "PROTECTED", "SECRET"]).optional(),
  },
}, wrap(async ({ name, description, privacy }) => {
  const b = await L.api("POST", "/boards", { name, description, privacy: privacy || "PUBLIC" });
  return { id: b.id, name: b.name, privacy: b.privacy };
}));

server.registerTool("list_images", {
  description: "List JPG/PNG images in a local folder (to pick files for pins)",
  inputSchema: { folder: z.string(), recursive: z.boolean().optional() },
}, wrap(async ({ folder, recursive }) => {
  const root = L.expandPath(folder); const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (recursive) walk(p); }
      else if (L.IMAGE_EXT.includes(path.extname(e.name).toLowerCase())) out.push({ path: p, kb: Math.round(fs.statSync(p).size / 1024) });
    }
  };
  walk(root);
  const skipped = fs.readdirSync(root).filter((f) => /\.(webp|gif|heic|avif|bmp)$/i.test(f));
  return { images: out, ...(skipped.length ? { unsupported_skipped: skipped } : {}) };
}));

server.registerTool("create_pin", {
  description: "Create a pin from a local image. Publishes now, or schedules if publish_at is given.",
  inputSchema: pinShape,
}, wrap(createOne));

server.registerTool("bulk_create_pins", {
  description: "Create many pins. Optionally auto-schedule: start_at + interval_minutes spreads pins without their own publish_at.",
  inputSchema: {
    pins: z.array(z.object(pinShape)).min(1),
    start_at: z.string().optional().describe("Time of the first auto-scheduled pin"),
    interval_minutes: z.number().positive().optional().describe("Gap between auto-scheduled pins"),
  },
}, wrap(async ({ pins, start_at, interval_minutes }) => {
  const results = []; let slot = start_at ? L.parseTime(start_at) : null;
  for (const p of pins) {
    const pin = { ...p };
    if (!pin.publish_at && slot) {
      pin.publish_at = slot.toISOString();
      slot = new Date(slot.getTime() + (interval_minutes || 60) * 60_000);
    }
    try { results.push(await createOne(pin)); } catch (e) { results.push({ error: e.message, image_path: p.image_path }); }
  }
  return results;
}));

server.registerTool("list_scheduled", {
  description: "Show the scheduled pins queue",
  inputSchema: { include_finished: z.boolean().optional() },
}, wrap(async ({ include_finished }) => ({
  now: L.fmtLocal(new Date()),
  items: L.getQueue()
    .filter((x) => include_finished || x.status === "pending" || x.status === "failed")
    .sort((a, b) => a.publish_at.localeCompare(b.publish_at))
    .map((x) => ({ id: x.id, status: x.status, publish_at: L.fmtLocal(x.publish_at), title: x.body.title, board_id: x.body.board_id, source: x.source_file, ...(x.result ? { url: x.result.url } : {}), ...(x.error ? { error: x.error } : {}) })),
})));

server.registerTool("cancel_scheduled", { description: "Cancel a scheduled pin", inputSchema: { id: z.string() } },
  wrap(async ({ id }) => { const it = await L.cancelScheduled(id); return { cancelled: it.id, title: it.body.title }; }));

server.registerTool("reschedule", { description: "Change publish time of a scheduled pin", inputSchema: { id: z.string(), publish_at: z.string() } },
  wrap(async ({ id, publish_at }) => { const it = await L.reschedule(id, L.parseTime(publish_at)); return { id: it.id, publish_at: L.fmtLocal(it.publish_at) }; }));

server.registerTool("publish_due", {
  description: "Publish scheduled pins that are due now (force=true publishes all pending immediately)",
  inputSchema: { force: z.boolean().optional() },
}, wrap(({ force }) => L.processDue({ force })));

await server.connect(new StdioServerTransport());

// Backup scheduler while the server is running (systemd timer is the primary one)
setInterval(() => L.processDue().catch(() => {}), 60_000).unref();
