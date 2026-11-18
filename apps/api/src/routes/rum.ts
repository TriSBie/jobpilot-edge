// @ts-nocheck
import { CORS, json, metric, now, registerAttemptAllowed, sha256hex } from "../worker.js";

export async function handleRum(request, env) {
  const ip = request.headers.get("cf-connecting-ip");
  if (!ip || ip.length > 64) return json({ error: "invalid_request" }, 400);
  const ipKey = await sha256hex("rum:" + ip);
  if (!(await registerAttemptAllowed(env, "rum:" + ipKey, Math.floor(now() / 3600), 60))) return json({ error: "rate_limited" }, 429);
  const reader = request.body?.getReader();
  if (!reader) return json({ error: "invalid_request" }, 400);
  let size = 0, chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 1024) { await reader.cancel(); return json({ error: "too_large" }, 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let pos = 0;
  for (const chunk of chunks) { bytes.set(chunk, pos); pos += chunk.byteLength; }
  let data;
  try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch (_) { return json({ error: "invalid_request" }, 400); }
  if (!data || typeof data !== "object" || !["LCP", "INP", "CLS"].includes(data.metric) || !["landing", "app"].includes(data.page) || typeof data.value !== "number" || !Number.isFinite(data.value) || data.value < 0 || data.value > 3600000) return json({ error: "invalid_request" }, 400);
  metric(env, "web_vital", data.metric + ":" + data.page, [data.value]);
  return new Response(null, { status: 204, headers: CORS });
}
