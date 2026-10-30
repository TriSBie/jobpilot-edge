// node apps/web/test/i18n.selfcheck.cjs apps/web/public/index.html
// Kiểm t(): vi mặc định, en tra EN, thiếu khoá thì trả vi, %s thay theo thứ tự, không đụng chuỗi không có %s.
const fs = require("fs"), assert = require("assert");
const src = fs.readFileSync(process.argv[2] || "apps/web/public/index.html", "utf8");
const m = src.match(/const EN = \{\};[\s\S]*?function t\(vi\)\{[\s\S]*?\n\}/);
assert(m, "không tìm thấy lõi i18n");
const mk = (lang) => new Function(m[0].replace(/let LANG = "vi";[\s\S]*?if \(LANG !== "en"\) LANG = "vi";/, `let LANG = ${JSON.stringify(lang)};`) + "\nreturn { t, EN };")();
const vi = mk("vi"), en = mk("en");
en.EN["Còn %s tin"] = "%s jobs left"; vi.EN["Còn %s tin"] = "%s jobs left";
assert.equal(vi.t("Còn %s tin", 5), "Còn 5 tin");
assert.equal(en.t("Còn %s tin", 5), "5 jobs left");
assert.equal(en.t("Chưa dịch"), "Chưa dịch");
en.EN["%s của %s"] = "%s of %s";
assert.equal(en.t("%s của %s", 1, 3), "1 of 3");
assert.equal(en.t("Đã lưu."), "Đã lưu.");
console.log("i18n selfcheck OK");
