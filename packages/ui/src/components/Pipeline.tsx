import type { Run } from "@clarvis/core/types";
import { Hud, Label, Dot, stagger } from "./primitives";

/**
 * What every team did, and what was set up before they ran.
 *
 * The findings view answers "what is wrong". This answers the question that
 * has to be settled first: how much of the application was actually reached.
 * A run that found nothing because it tested three routes and a run that found
 * nothing because it tested forty produce the same empty list, and the
 * difference between them is the entire value of the result.
 *
 * Preparation is shown whether it succeeded or failed. Only failures used to
 * leave a trace - as sentences in the truncation list - which meant a reader
 * could not tell a stage that worked from one that never ran at all.
 */

const OK = "var(--color-cyan)";
const WARN = "var(--color-amber)";
const DEAD = "var(--color-dim)";

function Row({
  label,
  value,
  tone = OK,
  detail,
  index = 0,
}: {
  label: string;
  value: string;
  tone?: string;
  detail?: string;
  index?: number;
}) {
  return (
    <li className="rise flex flex-col gap-1 py-2" style={stagger(index)}>
      <div className="flex items-baseline gap-2.5">
        <Dot color={tone} />
        <span className="text-[11px] uppercase tracking-[0.18em]" style={{ color: "var(--color-dim)" }}>
          {label}
        </span>
        <span className="ml-auto text-right text-[12px]" style={{ color: tone }}>
          {value}
        </span>
      </div>
      {detail && (
        <p className="pl-[18px] text-[11.5px] leading-relaxed" style={{ color: "var(--color-muted)" }}>
          {detail}
        </p>
      )}
    </li>
  );
}

function Preparation({ prep }: { prep: NonNullable<Run["preparation"]> }) {
  const rows: Array<{ label: string; value: string; tone: string; detail?: string }> = [];

  if (prep.sandbox) {
    rows.push(
      prep.sandbox.provisioned
        ? {
            label: "database",
            value: `${prep.sandbox.engine ?? "created"} · ${prep.sandbox.provisionedBy ?? ""}`.trim(),
            tone: OK,
            detail: prep.sandbox.evidence,
          }
        : {
            label: "database",
            value: "none created",
            tone: WARN,
            // Every rung, so a reader can see which one to fix rather than
            // being told only that it did not work.
            detail: [
              ...(prep.sandbox.attempts ?? []).map((a) => `${a.approach}: ${a.outcome}`),
              prep.sandbox.remedy,
            ]
              .filter(Boolean)
              .join("  ·  "),
          },
    );
  }

  if (prep.sessions?.length) {
    const ok = prep.sessions.filter((s) => s.ok);
    const failed = prep.sessions.filter((s) => !s.ok);
    rows.push({
      label: "sessions",
      value: `${ok.length}/${prep.sessions.length} logged in`,
      tone: failed.length ? WARN : OK,
      // Both sides: which roles are usable is as much a part of reading a
      // result as which ones failed, since an axis can only exercise a role
      // that logged in.
      detail: [
        ok.length ? `logged in: ${ok.map((s) => s.role).join(", ")}` : undefined,
        ...failed.map((s) => `${s.role} FAILED - ${s.detail}`),
      ]
        .filter(Boolean)
        .join("  ·  "),
    });
  }

  if (prep.surface) {
    const s = prep.surface;
    // The blind spot is the number that matters: a route with no snapshot is
    // one whose selectors were written from source rather than from the page.
    const blind = s.routesDeclared - s.routesSnapshotted;
    rows.push({
      label: "surface",
      value: `${s.routesSnapshotted}/${s.routesDeclared} snapshotted`,
      tone: blind > 0 ? WARN : OK,
      detail: [
        s.discoveredBy?.join(", "),
        `${s.routesBehindAuth} behind auth`,
        blind > 0 ? `${blind} with no snapshot - selectors for those were written blind` : undefined,
      ]
        .filter(Boolean)
        .join("  ·  "),
    });
  }

  if (prep.data) {
    rows.push({
      label: "data",
      value: prep.data.seeded ? (prep.data.commandsRun ?? []).join(", ") || "seeded" : "not seeded",
      tone: prep.data.seeded ? OK : WARN,
      detail: [
        prep.data.targetCheck,
        ...(prep.data.commandsSkipped ?? []).map((c) => `skipped ${c.script}: ${c.reason}`),
        !prep.data.seeded
          ? "An assertion that a list has rows may be reading leftovers, or failing on an empty database while the application is correct."
          : undefined,
      ]
        .filter(Boolean)
        .join("  ·  "),
    });
  }

  if (!rows.length) return null;

  return (
    <Hud>
      <div className="px-4 py-3.5">
        <Label>before the tests ran</Label>
        <ul className="mt-1 divide-y" style={{ borderColor: "var(--color-edge)" }}>
          {rows.map((r, i) => (
            <Row key={r.label} {...r} index={i} />
          ))}
        </ul>
      </div>
    </Hud>
  );
}

/** Display order, matching the order they run in. */
const FLEET_ORDER = ["recon", "research", "lead", "qa", "delivery", "release"];

const FLEET_NAME: Record<string, string> = {
  recon: "PATHFINDER",
  research: "DOSSIER",
  lead: "VECTOR",
  qa: "CRUCIBLE",
  delivery: "DISPATCH",
  release: "CLEARANCE",
};

/** What a team did when it produced no agent runs at all. */
const SILENT: Record<string, string> = {
  recon: "no recon agent ran - the profile was reused from a previous run",
  research: "no requirements were gathered, so no finding here can cite one",
  lead: "the axes were not ranked, so they ran in the order requested",
  qa: "no spec was authored, so nothing was tested",
  delivery: "no ticket was drafted",
  release: "no ship-or-hold verdict was reached",
};

function Teams({ run }: { run: Run }) {
  const agents = run.agentRuns ?? [];

  const byFleet = new Map<string, typeof agents>();
  for (const agent of agents) {
    // An agent whose fleet was not recorded is still shown, under its own
    // heading. Dropping it would make the roster quietly incomplete.
    const key = agent.fleet ?? "other";
    byFleet.set(key, [...(byFleet.get(key) ?? []), agent]);
  }

  // Every team that was turned on, not only the ones that produced something.
  // A team that is simply absent reads exactly like a team with nothing to
  // report, and that equivalence is the failure this product exists to
  // prevent - it has no business appearing in its own reporting.
  for (const key of run.request?.fleets ?? []) {
    if (!byFleet.has(key)) byFleet.set(key, []);
  }

  if (!byFleet.size) return null;

  const keys = [...byFleet.keys()].sort(
    (a, b) =>
      (FLEET_ORDER.indexOf(a) + 1 || 99) - (FLEET_ORDER.indexOf(b) + 1 || 99),
  );

  return (
    <Hud>
      <div className="px-4 py-3.5">
        <Label>what each team did</Label>
        <ul className="mt-1 divide-y" style={{ borderColor: "var(--color-edge)" }}>
        {keys.map((key, i) => {
          const fleet = byFleet.get(key)!;
          const failed = fleet.filter((a) => a.status !== "ok");
          const cost = fleet.reduce((sum, a) => sum + (a.usdEstimate ?? 0), 0);
          const silent = !fleet.length;
          const tone = silent ? DEAD : failed.length ? WARN : OK;

          return (
            <li key={key} className="rise py-2.5" style={stagger(i)}>
              <div className="flex items-baseline gap-2.5">
                <Dot color={tone} />
                <span
                  className="hud-type text-[12px]"
                  style={{
                    color: silent ? DEAD : failed.length ? WARN : "var(--color-fg)",
                    letterSpacing: "0.14em",
                  }}
                >
                  {FLEET_NAME[key] ?? key.toUpperCase()}
                </span>
                <span className="ml-auto text-[11px]" style={{ color: silent ? WARN : DEAD }}>
                  {silent
                    ? "did not run"
                    : `${fleet.length} agent${fleet.length === 1 ? "" : "s"}${
                        cost > 0 ? ` · $${cost.toFixed(2)} equivalent` : ""
                      }`}
                </span>
              </div>

              {silent && (
                <p className="mt-1 pl-[18px] text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                  {SILENT[key] ?? "This team was enabled but produced nothing."}
                </p>
              )}

              <ul className="mt-1.5 space-y-0.5 pl-[18px]">
                {fleet.map((agent) => (
                  <li key={agent.id} className="flex items-baseline gap-2 text-[11.5px]">
                    <span
                      style={{ color: agent.status === "ok" ? "var(--color-muted)" : WARN }}
                    >
                      {agent.role}
                    </span>
                    {agent.status !== "ok" && (
                      <span style={{ color: WARN }}>{agent.status}</span>
                    )}
                    {agent.transcriptPath && (
                      <code className="ml-auto truncate text-[10.5px]" style={{ color: DEAD }}>
                        {agent.transcriptPath.split("/").slice(-1)[0]}
                      </code>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
        </ul>
      </div>
    </Hud>
  );
}

export function Pipeline({ run }: { run: Run }) {
  const hasAnything = run.preparation || (run.agentRuns ?? []).length;
  if (!hasAnything) return null;

  return (
    <section className="space-y-5 px-4 pb-8 lg:px-8">
      {run.preparation && <Preparation prep={run.preparation} />}
      <Teams run={run} />
    </section>
  );
}
