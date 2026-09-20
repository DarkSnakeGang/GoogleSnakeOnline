"use strict";
const fs = require("fs");
const p = "tests/coop-gsm-e2e.test.js";
let s = fs.readFileSync(p, "utf8");
const start = s.indexOf(
  "          // Grow snakes (seed fruit ahead) then introduce L-turns."
);
const end = s.indexOf(
  "          // Paired head crops already taken as evidence-eyes-a/b (peer heads)."
);
if (start < 0 || end < 0) {
  console.error("markers", start, end);
  process.exit(1);
}
const repl = fs.readFileSync(".cache/e2e/evidence-crawl-snippet.txt", "utf8");
fs.writeFileSync(p, s.slice(0, start) + repl + s.slice(end));
console.log("ok", start, end);
