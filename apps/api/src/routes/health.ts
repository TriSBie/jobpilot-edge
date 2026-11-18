import { json } from "../worker.js";

export function handleHealth(env: Env) {
  return json({ ok: true, service: "jobpilot-api", phase: 2, ts: new Date().toISOString(),
    bindings: { DB: !!env.DB, KV: !!env.KV, FILES: !!env.FILES, AI: !!env.AI, EMB: !!env.EMB, EVENTS: !!env.EVENTS } });
}
