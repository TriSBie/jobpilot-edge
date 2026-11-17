// T-112: Web Vitals beacon emits anonymous records on hide.
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const html = fs.readFileSync("apps/web/public/index.html", "utf8");
const start = html.indexOf("// T-112: anonymous browser vitals;");
const end = html.indexOf("})();", start);
assert(start >= 0 && end > start, "Web Vitals beacon must exist");
const callbacks = {}, listeners = {}, sent = [];
class PerformanceObserver { constructor(callback) { this.callback = callback; } observe(options) { callbacks[options.type] = this.callback; } }
const document = { visibilityState: "visible", getElementById: () => ({ classList: { contains: () => false } }), addEventListener: (name, callback) => { listeners[name] = callback; } };
const navigator = { sendBeacon: (url, body) => { sent.push({ url, payload: JSON.parse(body) }); return true; } };
vm.runInNewContext(html.slice(start, end + 5), { window: { PerformanceObserver }, PerformanceObserver, document, navigator, API_BASE: "https://api.test", performance: { interactionCount: 2 }, Map, Math });
callbacks["largest-contentful-paint"]({ getEntries: () => [{ startTime: 1700 }] });
callbacks["layout-shift"]({ getEntries: () => [{ startTime: 100, value: 0.05, hadRecentInput: false }, { startTime: 200, value: 0.03, hadRecentInput: true }, { startTime: 500, value: 0.02, hadRecentInput: false }] });
callbacks.event({ getEntries: () => [{ interactionId: 1, duration: 64 }, { interactionId: 1, duration: 80 }, { interactionId: 2, duration: 48 }] });
document.visibilityState = "hidden"; listeners.visibilitychange(); listeners.visibilitychange();
assert.deepEqual(sent.map((x) => [x.url, x.payload.metric, x.payload.page]), [["https://api.test/api/rum", "LCP", "app"], ["https://api.test/api/rum", "CLS", "app"], ["https://api.test/api/rum", "INP", "app"]]);
assert.equal(sent[0].payload.value, 1700); assert(Math.abs(sent[1].payload.value - 0.07) < 1e-10); assert.equal(sent[2].payload.value, 80);
for (const x of sent) assert.deepEqual(Object.keys(x.payload).sort(), ["metric", "page", "value"]);
console.log("T-112 Web Vitals beacon selfcheck OK");