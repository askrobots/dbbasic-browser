// Per-tab loading states: driven by real signals, never invented.
import { sleep, traceStates } from "./lib.mjs";

export default async function (ctx) {
  const { call: T, check, base } = ctx;
  await T("page.goto", { url: base + "/free" });

  let s = await traceStates(ctx, base + "/slow?ms=1500", 5200);
  console.log("    /slow          :", s.join(" → "));
  check(s.includes("waiting") && s.includes("receiving") && s[s.length - 1] === "idle", "a slow page: waiting → receiving → idle");

  s = await traceStates(ctx, base + "/hang", 8500);
  console.log("    /hang          :", s.join(" → "));
  check(s.includes("waiting") && s.includes("slow"), "a request that never answers becomes 'slow' after 6 s");
  await T("page.goto", { url: base + "/free" });
  await sleep(400);
  check(((await T("tabs.list")).find((x) => x.active).state ?? "idle") === "idle", "navigating away clears the slow state");

  s = await traceStates(ctx, base + "/fail", 2500);
  console.log("    /fail          :", s.join(" → "));
  check(s.includes("failed") && !s.includes("slow"), "a dropped connection → failed (no stale 'slow' from the previous hung page)");
  await T("page.goto", { url: base + "/free" });

  s = await traceStates(ctx, base + "/redir/slow", 5200);
  console.log("    /redir/slow    :", s.join(" → "));
  check(s.join(">").includes("waiting>redirecting"), "a slow redirect: waiting → redirecting → (next hop)");
  check(s[s.length - 1] === "idle" && s.includes("receiving"), "…then receiving, then idle");
  s = await traceStates(ctx, base + "/redir/chain", 1500);
  check(s.every((x) => x === "idle"), "an instant redirect never flashes a throbber", s.join("→"));

  await T("x402.approval", { mode: "auto", maxUsd: 1 });
  s = await traceStates(ctx, base + "/premium", 4500);
  console.log("    /premium ($.50):", s.join(" → "));
  check(s.includes("pay-settled"), "an x402 payment shows pay-settled, then idle");
  await T("x402.approval", { mode: "ask", maxUsd: 0 });

  // The animation really runs, and the tab's <svg> node survives refreshes (no restart flicker).
  const c = await ctx.chrome();
  T("page.goto", { url: base + "/hang", wait: false }).catch(() => {});
  await sleep(900);
  const clock = () => c.ev(`(() => { const s = document.querySelector('#status.show .ic svg'); return s ? { t: s.getCurrentTime(), paused: s.animationsPaused() } : null })()`);
  const a = await clock();
  await sleep(600);
  const b = await clock();
  const reduced = await c.ev(`matchMedia("(prefers-reduced-motion: reduce)").matches`);
  if (reduced) check(!!(a && b && b.paused), "Reduce Motion is on: the status icon is paused (a still frame), as the default Follow System intends");
  else check(!!(a && b && b.t > a.t + 0.4 && !b.paused), "the status icon's animation clock advances", `t ${a?.t.toFixed(2)} → ${b?.t.toFixed(2)}`);
  await c.ev(`window.__n = document.querySelector('#tabs .tab.on .th svg'); 1`);
  await sleep(1200);
  check(await c.ev(`window.__n === document.querySelector('#tabs .tab.on .th svg')`), "the tab icon node persists across refreshes (its animation isn't restarted)");
  await c.ev(`setMotionMode("never")`);
  await sleep(300);
  const n1 = await clock();
  await sleep(500);
  const n2 = await clock();
  check(!!(n1 && n2 && n2.paused && Math.abs(n2.t - n1.t) < 0.05), "mode Never freezes the animation");
  await c.ev(`setMotionMode("always")`);
  await sleep(300);
  check((await clock())?.paused === false, "mode Always animates regardless of the system setting");
  await c.ev(`setMotionMode("system")`);
  await T("page.goto", { url: base + "/free" });
}
