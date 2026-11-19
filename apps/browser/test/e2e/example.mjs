// The example caller (examples/caller-network-client.mjs), run for real as a separate process against the browser.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export default async function (ctx) {
  const { check, base, controlUrl, controlToken } = ctx;
  const client = fileURLToPath(new URL("../../examples/caller-network-client.mjs", import.meta.url));
  const UA = "ExampleCaller/1.0 (+https://caller.example/about)";
  const run = (extra) => new Promise((resolve) => {
    execFile(process.execPath, [client, "--url", base + "/free", "--user-agent", UA, "--settle-timeout", "15000", ...extra], { env: { ...process.env, DBB_URL: controlUrl, DBB_TOKEN: controlToken }, timeout: 60000 }, (err, stdout, stderr) => {
      let verdict = null;
      try { verdict = JSON.parse(stdout); } catch {}
      resolve({ code: err ? (err.code ?? 1) : 0, verdict, stderr });
    });
  });

  let r = await run([]);
  check(r.code === 3 && r.verdict?.failure?.kind === "blocked" && r.verdict?.failure?.source === "caller", "by default it refuses a loopback/private address, as the caller, with a reason", JSON.stringify(r.verdict?.failure));
  r = await run(["--allow-private", "--min-gap-ms", "0"]);
  check(r.code === 0 && r.verdict?.settled && r.verdict?.outcome === "ok" && r.verdict?.status === 200, "with --allow-private it loads the page and exits 0", `${r.verdict?.outcome} ${r.verdict?.status}`);
  r = await run(["--allow-private", "--min-gap-ms", "0", "--max-bytes", "100"]);
  check(r.code === 3 && r.verdict?.failure?.source === "caller", "a response over the size limit is refused, not handed over", JSON.stringify(r.verdict?.failure));
  check((await ctx.call("net.provider")).enabled === false, "and it turns the caller network off again when done");
}
