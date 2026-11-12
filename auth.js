#!/usr/bin/env node
// One-time OAuth setup: node ~/pinterest-mcp/auth.js
import http from "node:http";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import readline from "node:readline/promises";
import * as L from "./lib.js";

const PORT = 8085;
const REDIRECT = `http://localhost:${PORT}/callback`;
const SCOPES = "boards:read,boards:write,pins:read,pins:write,user_accounts:read";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const cfg = L.getConfig();
cfg.app_id = (await rl.question(`App ID${cfg.app_id ? ` [${cfg.app_id}]` : ""}: `)).trim() || cfg.app_id;
cfg.app_secret = (await rl.question(`App secret${cfg.app_secret ? " [saved]" : ""}: `)).trim() || cfg.app_secret;
rl.close();
if (!cfg.app_id || !cfg.app_secret) { console.error("App ID and secret are required"); process.exit(1); }
L.saveConfig(cfg);

const state = crypto.randomBytes(16).toString("hex");
const url = `https://www.pinterest.com/oauth/?${new URLSearchParams({ client_id: cfg.app_id, redirect_uri: REDIRECT, response_type: "code", scope: SCOPES, state })}`;

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
  try {
    if (u.searchParams.get("state") !== state) throw new Error("state mismatch");
    const code = u.searchParams.get("code");
    if (!code) throw new Error(u.searchParams.get("error") || "no code");
    const t = await L.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, continuous_refresh: "true" });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<h2>✅ Pinterest connected. You can close this tab.</h2>");
    console.log(`\n✅ Authorized. Token valid until ${L.fmtLocal(t.expires_at)} (auto-refreshes).`);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("Error: " + e.message);
    console.error("❌", e.message);
  }
  setTimeout(() => process.exit(0), 300);
});
srv.listen(PORT, () => {
  console.log(`\nOpen this URL if the browser didn't open:\n${url}\n`);
  exec(`xdg-open '${url}'`);
});
