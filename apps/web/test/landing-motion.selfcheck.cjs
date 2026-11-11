// node apps/web/test/landing-motion.selfcheck.cjs apps/web/public/index.html
// Kiểm chuyển động landing: easing đếm số, stagger trần 420ms, 1 lưới chấm, 3 chương, không transition:all, hover có gate.
const fs = require("fs"), assert = require("assert");
const src = fs.readFileSync(process.argv[2] || "apps/web/public/index.html", "utf8");
const grab = (re) => { const m = src.match(re); assert(m, "thiếu " + re); return m[0]; };
const { at, stagger } = new Function(grab(/const at = [^\n]+/) + "\n" + grab(/const stagger = [^\n]+/) + "\nreturn { at, stagger };")();
assert.equal(at(1234, 0), 0); assert.equal(at(1234, 1), 1234); assert.equal(at(1234, 2), 1234);
assert(at(100, 0.5) > 50, "ease-out phải vượt nửa ở giữa");
assert.equal(stagger(0), 0); assert.equal(stagger(3), 210); assert.equal(stagger(20), 420);
assert.equal(new Intl.NumberFormat("vi-VN").format(12345), "12.345");
assert.equal((src.match(/class="lp-dots"/g) || []).length, 1, "đúng 1 chuyển động lặp");
assert.equal((src.match(/lp-sec sg-left lp-chapter/g) || []).length, 2);
assert(!/transition:\s*all/.test(src), "còn transition:all");
assert(/\.lp-dots i\{animation:lp-dot 3s steps\(1,end\)[^}]*paused/.test(src), "lưới chấm phải mặc định paused");
assert(src.includes('html.rv #landingView .lp-sec:not(.lp-hero)>*:not(.in){opacity:0'), "fallback .in");
assert(src.includes('el.setAttribute("aria-label", nf.format(Number(el.dataset.countup) || 0)); cio ? cio.observe(el) : run(el)'),"count-up phải gắn aria-label giá trị cuối trước khi chạy");
// mọi :hover trong khối landing mới nằm trong gate
for (const l of src.split("\n")) if (/#landingView[^{]*:hover\{/.test(l)) assert(/hover:hover/.test(l), "hover không gate: " + l.trim());
console.log("landing motion selfcheck OK");
