#!/usr/bin/env node
// Run by systemd timer every minute: publishes due scheduled pins
import { processDue, getQueue } from "./lib.js";

if (!getQueue().some((x) => x.status === "pending" && new Date(x.publish_at) <= new Date())) process.exit(0);
const r = await processDue();
if (r.length) console.log(JSON.stringify(r));
