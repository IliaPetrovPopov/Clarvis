import { spawn, type ChildProcess } from "node:child_process";
import { CLARVIS_DIR } from "./store.ts";
import type { Profile } from "./types.ts";

export interface BootResult {
  verified: boolean;
  durationMs: number;
  blockers: string[];
  /** Kills the process this boot started, if any. No-op when the app was already up. */
  stop: () => Promise<void>;
}

async function probe(url: string, timeoutMs = 4000): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: "manual" });
    // Anything that answers is "up" - a 401 from a protected root still proves
    // the server is listening, which is all boot verification claims.
    return res.status > 0 && res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Boot the target app and prove it answers.
 *
 * This is the single highest-frequency failure in the whole product: pointing a
 * tester at a project that will not start. So it never guesses. Either the URL
 * responds - `verified: true` - or we return concrete blockers for a human,
 * and the caller refuses to run tests against an app that may not be there.
 */
export async function bootAndVerify(
  profile: Profile,
  opts: { log?: (line: string) => void } = {},
): Promise<BootResult> {
  const startedAt = Date.now();
  const log = opts.log ?? (() => {});
  const readyUrl = profile.boot.readyCheck ?? profile.boot.url;
  const timeoutMs = profile.boot.readyTimeoutMs ?? 120_000;
  const blockers: string[] = [];

  if (await probe(readyUrl)) {
    log(`already up at ${readyUrl}`);
    return { verified: true, durationMs: Date.now() - startedAt, blockers: [], stop: async () => {} };
  }

  if (!profile.boot.cmd) {
    return {
      verified: false,
      durationMs: Date.now() - startedAt,
      blockers: [
        `Nothing is listening at ${readyUrl} and the profile has no boot.cmd.`,
        `Start the app yourself, or set boot.cmd in ${CLARVIS_DIR}/profile.json.`,
      ],
      stop: async () => {},
    };
  }

  log(`booting: ${profile.boot.cmd}`);
  let child: ChildProcess;
  try {
    child = spawn(profile.boot.cmd, {
      shell: true,
      cwd: profile.boot.cwd ?? profile.project.root,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      // Merged over the inherited environment, so a second instance can be
      // told which port to take without editing the boot command.
      env: { ...process.env, ...profile.boot.env },
    });
  } catch (e) {
    return {
      verified: false,
      durationMs: Date.now() - startedAt,
      blockers: [`Could not spawn boot.cmd: ${e instanceof Error ? e.message : String(e)}`],
      stop: async () => {},
    };
  }

  const tail: string[] = [];
  const capture = (buf: Buffer) => {
    for (const line of buf.toString().split("\n")) {
      if (!line.trim()) continue;
      tail.push(line);
      if (tail.length > 40) tail.shift();
    }
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  let exited: number | null = null;
  child.on("exit", (code) => {
    exited = code ?? 0;
  });

  const stop = async () => {
    if (child.exitCode == null && !child.killed) {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
      if (child.exitCode == null) child.kill("SIGKILL");
    }
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(readyUrl)) {
      log(`up at ${readyUrl} in ${Math.round((Date.now() - startedAt) / 1000)}s`);
      return { verified: true, durationMs: Date.now() - startedAt, blockers: [], stop };
    }
    // A boot command that exits non-zero will never come up. Fail immediately
    // rather than burning the full timeout.
    if (exited !== null && exited !== 0) {
      blockers.push(`boot.cmd exited with code ${exited} before ${readyUrl} answered.`);
      if (tail.length) blockers.push(`Last output: ${tail.slice(-5).join(" / ")}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  if (!blockers.length) {
    blockers.push(
      `${readyUrl} did not answer within ${Math.round(timeoutMs / 1000)}s of running boot.cmd.`,
    );
    if (tail.length) blockers.push(`Last output: ${tail.slice(-5).join(" / ")}`);
  }

  await stop();
  return { verified: false, durationMs: Date.now() - startedAt, blockers, stop: async () => {} };
}
