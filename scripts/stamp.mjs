// Copies web/index.html to public/ with ?v=<build id> on app.js and styles.css so browsers never serve stale assets.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";

mkdirSync("public", { recursive: true });
copyFileSync("web/styles.css", "public/styles.css");
copyFileSync("web/_headers", "public/_headers"); // Cloudflare static-asset cache headers
const v = createHash("sha1")
  .update(readFileSync("public/app.js"))
  .update(readFileSync("public/styles.css"))
  .digest("hex")
  .slice(0, 10);
const html = readFileSync("web/index.html", "utf8")
  .replace('href="./styles.css"', `href="./styles.css?v=${v}"`)
  .replace('src="./app.js"', `src="./app.js?v=${v}"`);
writeFileSync("public/index.html", html);
console.log(`stamped assets with v=${v}`);
