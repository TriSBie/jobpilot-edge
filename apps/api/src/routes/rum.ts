import { z } from "zod";
import type { ObservedEnv } from "../infra/observe.ts";
import { CORS, json, metric, now, registerAttemptAllowed, sha256hex } from "../worker.js";

const rumBody = z.object({
  metric: z.enum(["LCP", "INP", "CLS"]),
  page: z.enum(["landing", "app"]),
  value: z.number().min(0).max(3600000),
});

export async function handleRum(request: Request, env: ObservedEnv) {
  const ip = request.headers.get("cf-connecting-ip");
  if (!ip || ip.length > 64) return json({ error: "invalid_request" }, 400);
  const ipKey = await sha256hex("rum:" + ip);
  if (!(await registerAttemptAllowed(env, "rum:" + ipKey, Math.floor(now() / 3600), 60))) return json({ error: "rate_limited" }, 429);
  const reader = request.body?.getReader();
  if (!reader) return json({ error: "invalid_request" }, 400);
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 1024) { await reader.cancel(); return json({ error: "too_large" }, 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let pos = 0;
  for (const chunk of chunks) { bytes.set(chunk, pos); pos += chunk.byteLength; }
  let data: unknown;
  try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch (_) { return json({ error: "invalid_request" }, 400); }
  const payload = rumBody.safeParse(data);
  if (!payload.success) return json({ error: "invalid_request" }, 400);
  const { metric: vital, page, value } = payload.data;
  metric(env, "web_vital", vital + ":" + page, [value]);
  return new Response(null, { status: 204, headers: CORS });
}
