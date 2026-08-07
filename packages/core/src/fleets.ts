/**
 * Fleet registry and resolver.
 *
 * Clarvis simulates a team, and like a real team you do not always want all of
 * it. This module decides which fleets run for a given request, in what order,
 * and - most importantly - what you lose by leaving one out.
 *
 * The last part is the point. Turning off a fleet silently degrades the quality
 * of the answer: skip research and no finding can ever cite acceptance
 * criteria, so every oracle falls back to code intent. A tool that claims to
 * report only what it can prove has to say that out loud rather than quietly
 * hand back weaker results that look identical.
 */

export const FLEET_KEYS = ["recon", "research", "lead", "qa", "delivery", "release"] as const;
export type FleetKey = (typeof FLEET_KEYS)[number];

export interface FleetSpec {
  key: FleetKey;
  /**
   * Display name. Aerospace/mission-control deliberately: it matches the HUD
   * language and, unlike Stark-universe names, carries no trademark exposure
   * for a product that gets sold.
   */
  codename: string;
  title: string;
  purpose: string;
  /** Cannot be disabled. Only `recon` qualifies, and for a structural reason. */
  mandatory: boolean;
  /** Fleets whose output this one reads. Enabling a fleet pulls these in. */
  requires: FleetKey[];
  /** Artifact written, relative to `.clarvis/`. */
  produces: string;
  /**
   * If the artifact already exists and is fresh, the fleet is satisfied without
   * running. This is what makes a mandatory fleet cheap rather than a tax on
   * every single run.
   */
  cacheable: boolean;
  /** Whether this fleet can write anywhere outside `.clarvis/`. */
  writesExternally: boolean;
}

export const FLEETS: Record<FleetKey, FleetSpec> = {
  recon: {
    key: "recon",
    codename: "SCOUT",
    title: "Recon",
    purpose:
      "Walks the project: boots it for real, logs in as each role, maps routes, detects the stack, ranks risk.",
    mandatory: true,
    requires: [],
    produces: "profile.json",
    cacheable: true,
    writesExternally: false,
  },
  research: {
    key: "research",
    codename: "ARCHIVE",
    title: "Research",
    purpose:
      "Learns what the feature is supposed to do, from tickets, docs and history. Produces the oracles.",
    mandatory: false,
    requires: [],
    produces: "context.json",
    cacheable: true,
    writesExternally: false,
  },
  lead: {
    key: "lead",
    codename: "FOREMAN",
    title: "Lead",
    purpose: "Decides what to test: which axes, which routes, against which oracles.",
    mandatory: false,
    requires: ["recon"],
    produces: "plan.json",
    cacheable: false,
    writesExternally: false,
  },
  qa: {
    key: "qa",
    codename: "PROVER",
    title: "QA",
    purpose: "Drives real browsers across the test axes, then triages what it finds.",
    mandatory: false,
    requires: ["recon"],
    produces: "runs/<id>/run.json",
    cacheable: false,
    writesExternally: false,
  },
  delivery: {
    key: "delivery",
    codename: "SCRIBE",
    title: "Delivery",
    purpose: "Turns confirmed findings into tracker drafts. Never files without approval.",
    mandatory: false,
    requires: ["qa"],
    produces: "runs/<id>/drafts.json",
    cacheable: false,
    writesExternally: true,
  },
  release: {
    key: "release",
    codename: "JUDGE",
    title: "Release",
    purpose:
      "Ship-readiness verdict and draft release notes, from what the run actually proved. Recommends; it does not deploy.",
    mandatory: false,
    requires: ["qa"],
    produces: "runs/<id>/verdict.json",
    cacheable: false,
    writesExternally: false,
  },
};

export interface Degradation {
  fleet: FleetKey;
  /** The fleet that is missing. */
  missing: FleetKey;
  effect: string;
  mitigation: string;
  severity: "high" | "medium" | "low";
}

/**
 * What you lose by running a fleet without another one. Keyed by the fleet that
 * suffers, then the fleet that is absent.
 */
const DEGRADATIONS: Array<Degradation> = [
  {
    fleet: "qa",
    missing: "research",
    severity: "high",
    effect:
      "No finding can cite a spec or acceptance criteria, because nothing gathered them. Every oracle falls back to code intent or a visible label, which is the weakest evidence the tier system accepts.",
    mitigation:
      "Enable research, or paste a written brief so the fleet has something human-authored to judge against.",
  },
  {
    fleet: "qa",
    missing: "lead",
    severity: "low",
    effect: "Nothing prioritises the work, so axes and routes are whatever you passed on the command line.",
    mitigation: "Enable lead, or pass --axis and a feature explicitly.",
  },
  {
    fleet: "delivery",
    missing: "research",
    severity: "high",
    effect:
      "No known-issues list and no tracker history, so already-reported bugs get drafted again. Duplicate tickets are the fastest way to get the tool ignored.",
    mitigation: "Enable research so delivery can dedupe against the tracker before drafting.",
  },
  {
    fleet: "release",
    missing: "research",
    severity: "high",
    effect:
      "The verdict cannot check the build against intended behaviour, only against whether specs happened to pass. It becomes a test summary, not a readiness judgement.",
    mitigation: "Enable research before treating any verdict as a go/no-go signal.",
  },
  {
    fleet: "release",
    missing: "delivery",
    severity: "low",
    effect: "Release notes will not reference tracker keys, since nothing looked them up.",
    mitigation: "Enable delivery if notes should link to issues.",
  },
];

export interface FleetResolution {
  /** Execution order, dependencies first. */
  order: FleetKey[];
  /** Fleets pulled in automatically, and why. */
  autoIncluded: Array<{ fleet: FleetKey; because: string }>;
  /** Quality lost by the fleets left out. Surfaced, never suppressed. */
  degradations: Degradation[];
  /** Requests that cannot be honoured at all. */
  errors: string[];
  /** Enabled fleets whose cached artifact means they do not need to run. */
  satisfiedByCache: FleetKey[];
}

export interface ResolveOptions {
  /** Which fleets the human asked for. `recon` is added regardless. */
  requested: string[] | "all";
  /** Artifacts already present and considered fresh, e.g. ["recon"]. */
  freshArtifacts?: FleetKey[];
  /** Ignore the cache and re-run everything enabled. */
  force?: boolean;
}

function topoSort(enabled: Set<FleetKey>): FleetKey[] {
  const order: FleetKey[] = [];
  const seen = new Set<FleetKey>();

  const visit = (key: FleetKey) => {
    if (seen.has(key)) return;
    seen.add(key);
    for (const dep of FLEETS[key].requires) {
      if (enabled.has(dep)) visit(dep);
    }
    order.push(key);
  };

  // Iterate the canonical key order so the result is deterministic rather than
  // dependent on Set insertion order.
  for (const key of FLEET_KEYS) if (enabled.has(key)) visit(key);
  return order;
}

export function resolveFleets(opts: ResolveOptions): FleetResolution {
  const errors: string[] = [];
  const autoIncluded: FleetResolution["autoIncluded"] = [];

  const requested: FleetKey[] =
    opts.requested === "all"
      ? [...FLEET_KEYS]
      : opts.requested.flatMap((raw) => {
          const key = toFleetKey(raw);
          if (key) return [key];
          errors.push(
            `Unknown fleet "${raw}". Known: ${Object.values(FLEETS)
              .map((f) => `${f.key}/${f.codename.toLowerCase()}`)
              .join(", ")}.`,
          );
          return [];
        });

  const enabled = new Set<FleetKey>(requested);

  // Mandatory fleets are not a preference. Without a profile there is no base
  // URL, no credentials and no safe-target list, so nothing downstream can run.
  for (const spec of Object.values(FLEETS)) {
    if (spec.mandatory && !enabled.has(spec.key)) {
      enabled.add(spec.key);
      autoIncluded.push({
        fleet: spec.key,
        because: `${spec.title} is mandatory: every other fleet reads ${spec.produces}.`,
      });
    }
  }

  // Pull in dependencies transitively.
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of [...enabled]) {
      for (const dep of FLEETS[key].requires) {
        if (!enabled.has(dep)) {
          enabled.add(dep);
          autoIncluded.push({
            fleet: dep,
            because: `${FLEETS[key].title} reads ${FLEETS[dep].produces}.`,
          });
          changed = true;
        }
      }
    }
  }

  const degradations = DEGRADATIONS.filter((d) => enabled.has(d.fleet) && !enabled.has(d.missing));

  const fresh = new Set(opts.freshArtifacts ?? []);
  const satisfiedByCache = opts.force
    ? []
    : [...enabled].filter((k) => FLEETS[k].cacheable && fresh.has(k)).sort();

  return {
    order: topoSort(enabled),
    autoIncluded,
    degradations,
    errors,
    satisfiedByCache,
  };
}

/** Codename -> key, so `--fleet crucible` and `--fleet qa` both resolve. */
const BY_CODENAME: Record<string, FleetKey> = Object.fromEntries(
  Object.values(FLEETS).map((f) => [f.codename.toLowerCase(), f.key]),
);

/** Accepts either the machine key or the codename, in any case. */
export function toFleetKey(input: string): FleetKey | undefined {
  const v = input.trim().toLowerCase();
  if ((FLEET_KEYS as readonly string[]).includes(v)) return v as FleetKey;
  return BY_CODENAME[v];
}

export function fleetLabel(key: FleetKey): string {
  return `${FLEETS[key].codename} (${key})`;
}

/** One-line summary for the CLI, so a degraded run announces itself. */
export function describeResolution(r: FleetResolution): string[] {
  const lines: string[] = [];
  lines.push(`fleets   ${r.order.map((k) => FLEETS[k].codename).join(" -> ")}`);

  for (const a of r.autoIncluded) lines.push(`added    ${fleetLabel(a.fleet)}: ${a.because}`);
  for (const k of r.satisfiedByCache) lines.push(`cached   ${fleetLabel(k)}: reusing ${FLEETS[k].produces}`);

  for (const d of r.degradations) {
    lines.push(
      `DEGRADED ${FLEETS[d.fleet].codename} without ${FLEETS[d.missing].codename} (${d.severity}): ${d.effect}`,
    );
  }
  return lines;
}
