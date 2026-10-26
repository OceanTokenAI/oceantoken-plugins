/** Fail the connect early when the host's own CLI is needed but missing. */
export function requireCli(ctx, cmd, installHint) {
  if (ctx.which(cmd)) return true;
  ctx.step(`${cmd} CLI`, "failed", `\`${cmd}\` is not on PATH`);
  ctx.next(installHint);
  return false;
}

/**
 * Run the host's own OAuth sign-in (it opens the browser and waits for the callback).
 * With an API key there is nothing to sign in to.
 */
export async function signIn(ctx, cmd, args, hint) {
  if (ctx.apiKey) {
    ctx.report.signIn = "not needed (API key)";
    return;
  }
  const manual = `Sign in: run \`${[cmd, ...args].join(" ")}\`${hint ? ` (${hint})` : ""}.`;
  if (!ctx.login) {
    ctx.step("Sign-in", "skipped", "--no-login");
    ctx.report.signIn = "not started";
    ctx.next(manual);
    return;
  }
  if (!ctx.which(cmd)) {
    ctx.step("Sign-in", "manual", `\`${cmd}\` is not on PATH`);
    ctx.report.signIn = "not started";
    ctx.next(manual);
    return;
  }
  const res = await ctx.exec("Sign-in", cmd, args, { inherit: true });
  ctx.report.signIn = ctx.dryRun ? "not started (dry run)" : res.ok ? "done" : "failed";
  if (!res.ok) ctx.next(manual);
}

/** Hosts that sign in from their own UI the first time the server is used. */
export function signInInApp(ctx, how) {
  if (ctx.apiKey) {
    ctx.report.signIn = "not needed (API key)";
    return;
  }
  ctx.report.signIn = "in the app";
  ctx.next(how);
}
