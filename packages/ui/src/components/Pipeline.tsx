import type { Run } from "@clarvis/core/types";
import { Bar, Dot, Label, Mono, settle } from "./primitives";

/**
 * What was set up before the tests ran, and what each team did.
 *
 * The findings view answers "what is wrong". This answers the question that
 * has to be settled first: how much of the application was actually reached.
 * A run that found nothing over three routes and one that found nothing over
 * forty produce an identical empty list, and the difference between them is
 * the entire value of the result.
 *
 * Every stage is shown whether it succeeded or not. Only failures used to
 * leave a trace, which meant a reader could not tell a stage that worked from
 * one that never ran.
 */

const OK = "var(--color-signal)";
const WARN = "var(--color-attend)";
const OFF = "var(--color-ink-500)";

function Stage({
  label,
  value,
  tone,
  detail,
  meter,
  index,
}: {
  label: string;
  value: string;
  tone: string;
  detail?: string;
  meter?: Array<{ value: number; color: string; title?: string }>;
  index: number;
}) {
  return (
    <li className="settle px-4 py-3" style={settle(index)}>
      <div className="flex items-baseline gap-3">
        <Dot color={tone} />
        <Label>{label}</Label>
        <span className="readout ml-auto text-right text-[12px]" style={{ color: tone }}>
          {value}
        </span>
      </div>
      {meter && (
        <div className="mt-2 pl-[17px]">
          <Bar height={3} parts={meter} />
        </div>
      )}
      {detail && (
        <p className="prose mt-1.5 pl-[17px] text-[11.5px]" style={{ color: "var(--color-dim)" }}>
          {detail}
        </p>
      )}
    </li>
  );
}

function Preparation({ prep }: { prep: NonNullable<Run["preparation"]> }) {
  const rows: Array<Omit<Parameters<typeof Stage>[0], "index">> = [];

  if (prep.sandbox) {
    rows.push(
      prep.sandbox.provisioned
        ? {
            label: "database",
            value: [prep.sandbox.engine, prep.sandbox.provisionedBy].filter(Boolean).join(" · "),
            tone: OK,
            detail: prep.sandbox.evidence,
          }
        : {
            label: "database",
            value: "none created",
            tone: WARN,
            // Every rung tried, so a reader sees which one to fix rather than
            // only that it did not work.
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
      value: `${ok.length} / ${prep.sessions.length}`,
      tone: failed.length ? WARN : OK,
      meter: [
        { value: ok.length, color: OK, title: "logged in" },
        { value: failed.length, color: WARN, title: "could not log in" },
      ],
      // Both sides: which roles are usable is as much a part of reading a
      // result as which ones failed, since an axis can only exercise a role
      // that logged in.
      detail: [
        ok.length ? `logged in as ${ok.map((s) => s.role).join(", ")}` : undefined,
        ...failed.map((s) => `${s.role} failed - ${s.detail}`),
      ]
        .filter(Boolean)
        .join("  ·  "),
    });
  }

  if (prep.surface) {
    const s = prep.surface;
    // The blind count is the number that matters: a route with no snapshot is
    // one whose selectors were written from source rather than from the page.
    const blind = Math.max(0, s.routesDeclared - s.routesSnapshotted);
    rows.push({
      label: "surface",
      value: `${s.routesSnapshotted} / ${s.routesDeclared}`,
      tone: blind > 0 ? WARN : OK,
      meter: [
        { value: s.routesSnapshotted, color: OK, title: "snapshotted" },
        { value: blind, color: "var(--color-ink-400)", title: "no snapshot" },
      ],
      detail: [
        s.discoveredBy?.join(", "),
        `${s.routesBehindAuth} behind auth`,
        blind > 0 ? `${blind} with no snapshot - selectors there were written blind` : undefined,
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
    <section className="surface">
      <header className="px-4 pt-3.5 pb-1">
        <Label>before the tests ran</Label>
      </header>
      <ul className="divide-y" style={{ borderColor: "var(--color-hair)" }}>
        {rows.map((r, i) => (
          <Stage key={r.label} {...r} index={i} />
        ))}
      </ul>
    </section>
  );
}

/* -------------------------------------------------------------- the teams */

const FLEET_ORDER = ["recon", "research", "lead", "qa", "delivery", "release"];

const FLEET_NAME: Record<string, string> = {
  recon: "PATHFINDER",
  research: "DOSSIER",
  lead: "VECTOR",
  qa: "CRUCIBLE",
  delivery: "DISPATCH",
  release: "CLEARANCE",
};

/** What a team's silence actually cost. */
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
    const key = agent.fleet ?? "other";
    byFleet.set(key, [...(byFleet.get(key) ?? []), agent]);
  }

  // Every team that was turned on, not only those that produced something. An
  // absent row and a silent row look identical, and that equivalence is the
  // failure this product exists to prevent - it has no business appearing in
  // its own reporting.
  for (const key of run.request?.fleets ?? []) {
    if (!byFleet.has(key)) byFleet.set(key, []);
  }

  if (!byFleet.size) return null;

  const keys = [...byFleet.keys()].sort(
    (a, b) => (FLEET_ORDER.indexOf(a) + 1 || 99) - (FLEET_ORDER.indexOf(b) + 1 || 99),
  );

  return (
    <section className="surface">
      <header className="flex items-baseline gap-3 px-4 pt-3.5 pb-1">
        <Label>the teams</Label>
        <span className="ml-auto readout text-[11px]" style={{ color: "var(--color-dim)" }}>
          {agents.length} agent(s)
        </span>
      </header>

      <ul className="divide-y" style={{ borderColor: "var(--color-hair)" }}>
        {keys.map((key, i) => {
          const fleet = byFleet.get(key)!;
          const failed = fleet.filter((a) => a.status !== "ok");
          const cost = fleet.reduce((sum, a) => sum + (a.usdEstimate ?? 0), 0);
          const silent = !fleet.length;
          const tone = silent ? OFF : failed.length ? WARN : OK;

          return (
            <li key={key} className="settle px-4 py-3" style={settle(i)}>
              <div className="flex items-baseline gap-3">
                <Dot color={tone} />
                <span
                  className="text-[12.5px]"
                  style={{
                    color: silent ? "var(--color-dim)" : "var(--color-bright)",
                    fontWeight: 600,
                    letterSpacing: "0.08em",
                  }}
                >
                  {FLEET_NAME[key] ?? key.toUpperCase()}
                </span>
                <span className="readout ml-auto text-[11px]" style={{ color: silent ? WARN : "var(--color-dim)" }}>
                  {silent ? "did not run" : `${fleet.length} · $${cost.toFixed(2)}`}
                </span>
              </div>

              {silent ? (
                <p className="prose mt-1 pl-[17px] text-[11.5px]" style={{ color: "var(--color-dim)" }}>
                  {SILENT[key] ?? "This team was enabled but produced nothing."}
                </p>
              ) : (
                <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 pl-[17px]">
                  {fleet.map((agent) => (
                    <li key={agent.id} className="flex items-baseline gap-1.5">
                      <Mono tone={agent.status === "ok" ? "var(--color-muted)" : WARN}>{agent.role}</Mono>
                      {agent.status !== "ok" && <Label tone={WARN}>{agent.status}</Label>}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function Pipeline({ run }: { run: Run }) {
  if (!run.preparation && !(run.agentRuns ?? []).length && !(run.request?.fleets ?? []).length) {
    return null;
  }

  return (
    <div className="grid gap-5 px-5 pt-6 lg:grid-cols-2 lg:px-8">
      {run.preparation ? <Preparation prep={run.preparation} /> : <div />}
      <Teams run={run} />
    </div>
  );
}
