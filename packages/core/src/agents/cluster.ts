import type { Finding } from "../types.ts";

/**
 * Failures that share one cause.
 *
 * Nine specs failing because the application had not finished rendering is one
 * problem, not nine. Triage graded them individually, which was wrong three
 * ways at once: it cost nine times what it needed to, it reported nine findings
 * where there was one, and it never said the thing that actually mattered -
 * that the run itself was not in a state where any result could be trusted.
 *
 * Clustering is deliberately deterministic. An agent asked "do these share a
 * cause?" would answer yes far too readily, and a wrong merge is the one
 * mistake here that loses a real bug: two distinct defects given one verdict,
 * with the second never examined. So a cluster forms only on strong,
 * mechanical evidence, and every member is reported by name.
 *
 * The rule that governs the whole file: CLUSTERING CHANGES HOW MANY TIMES WE
 * INVESTIGATE, NEVER HOW MANY FINDINGS WE REPORT.
 */

export interface Cluster {
  id: string;
  /** The finding actually triaged. Its verdict is applied to the rest. */
  representative: Finding;
  members: Finding[];
  /** What they have in common, in plain words. Shown to a human. */
  sharedCause: string;
  /** Why they were judged to share it. The evidence, not a claim. */
  evidence: string;
}

export interface ClusterResult {
  clusters: Cluster[];
  /** Failures with nothing in common. Triaged individually, as before. */
  singletons: Finding[];
  /**
   * Set when most of the run failed the same way, which means the run itself is
   * suspect rather than the application.
   */
  environmental?: {
    cluster: Cluster;
    share: number;
    note: string;
  };
}

/**
 * Reduce an error message to its shape.
 *
 * Two failures of the same cause differ in incidental detail - a viewport size,
 * a timeout figure, a generated id, a locator index. Stripping those leaves the
 * assertion that failed, which is what makes them comparable.
 */
export function normaliseError(message: string): string {
  return (
    message
      // Playwright wraps its messages in ANSI colour.
      .replace(/\[[0-9;]*m/g, "")
      .toLowerCase()
      // Volatile detail, in the order it usually appears.
      .replace(/\b\d+(\.\d+)?(ms|s|px)\b/g, "N")
      .replace(/\b\d{2,}x\d{2,}\b/g, "VIEWPORT")
      .replace(/\b[0-9a-f]{8,}\b/g, "ID")
      .replace(/\b\d+\b/g, "N")
      .replace(/["'`]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200)
  );
}

/**
 * The locator a failure was about, when the message names one.
 *
 * Two assertions failing on the same element are far more likely to share a
 * cause than two failing on different ones, whatever else they have in common.
 */
export function locatorOf(finding: Finding): string | undefined {
  if (finding.locator) return finding.locator.trim().toLowerCase();

  const match =
    /getby\w+\(([^)]{1,60})\)/i.exec(finding.actual) ??
    /locator\(([^)]{1,60})\)/i.exec(finding.actual);
  return match?.[1].replace(/["'`]/g, "").trim().toLowerCase();
}

/**
 * Findings are only merged when at least two independent signals agree.
 *
 * One signal is a coincidence: two tests can fail with "element not visible"
 * for entirely unrelated reasons. Requiring agreement is what keeps a merge
 * from swallowing a second, real defect.
 */
function signals(a: Finding, b: Finding): string[] {
  const shared: string[] = [];

  const errorA = normaliseError(a.actual);
  const errorB = normaliseError(b.actual);
  if (errorA && errorA === errorB) shared.push("an identical assertion failure");

  const locA = locatorOf(a);
  const locB = locatorOf(b);
  if (locA && locA === locB) shared.push(`the same element (${locA})`);

  if (a.route && a.route === b.route) shared.push(`the same route (${a.route})`);

  if (a.evidence.specFile && a.evidence.specFile === b.evidence.specFile) {
    shared.push("the same spec file");
  }

  return shared;
}

/** Two independent signals, and one of them must be the failure itself. */
function sharesCause(a: Finding, b: Finding): { yes: boolean; evidence: string } {
  const shared = signals(a, b);
  const hasFailureSignal = shared.some((s) => s.startsWith("an identical") || s.startsWith("the same element"));

  return {
    yes: shared.length >= 2 && hasFailureSignal,
    evidence: shared.join(", "),
  };
}

/**
 * A short, human sentence for what a cluster is about.
 *
 * Written from the failure rather than from the test names: what these have in
 * common is why they broke, not what they were checking.
 */
function describeCause(members: Finding[]): string {
  const first = members[0];
  const locator = locatorOf(first);
  const line = first.actual.replace(/\[[0-9;]*m/g, "").split("\n")[0].trim();

  if (locator) return `${members.length} assertions failed on the same element (${locator}).`;
  return `${members.length} assertions failed the same way: ${line.slice(0, 110)}`;
}

export interface ClusterOptions {
  /** Share of all failures in one cluster above which the run itself is suspect. */
  environmentalThreshold?: number;
  /** Smallest cluster worth calling environmental. */
  minEnvironmentalSize?: number;
}

export function clusterFindings(findings: Finding[], opts: ClusterOptions = {}): ClusterResult {
  const clusters: Cluster[] = [];
  const assigned = new Set<string>();

  for (const finding of findings) {
    if (assigned.has(finding.id)) continue;

    const members = [finding];
    const evidence = new Set<string>();
    assigned.add(finding.id);

    for (const other of findings) {
      if (assigned.has(other.id)) continue;
      // Compared against the cluster's first member rather than any member, so
      // a chain of weak similarities cannot drag unrelated findings together.
      const verdict = sharesCause(finding, other);
      if (!verdict.yes) continue;

      members.push(other);
      assigned.add(other.id);
      for (const e of verdict.evidence.split(", ")) evidence.add(e);
    }

    if (members.length === 1) continue;

    clusters.push({
      id: `cluster-${clusters.length + 1}`,
      // The most severe member represents the group, so a cluster is never
      // graded on its mildest instance.
      representative: [...members].sort((a, b) => rank(b.severity) - rank(a.severity))[0],
      members,
      sharedCause: describeCause(members),
      evidence: [...evidence].join(", "),
    });
  }

  const singletons = findings.filter((f) => !clusters.some((c) => c.members.some((m) => m.id === f.id)));

  /* --- is the run itself the problem? ------------------------------------ */

  const threshold = opts.environmentalThreshold ?? 0.6;
  const minSize = opts.minEnvironmentalSize ?? 3;

  let environmental: ClusterResult["environmental"];
  for (const cluster of clusters) {
    const share = cluster.members.length / Math.max(1, findings.length);
    if (cluster.members.length < minSize || share < threshold) continue;

    const axes = new Set(cluster.members.map((m) => m.axis));
    environmental = {
      cluster,
      share,
      note:
        `${cluster.members.length} of ${findings.length} failures share one cause` +
        (axes.size > 1 ? ` and span ${axes.size} axes` : "") +
        `. That is a problem with the run rather than ${axes.size > 1 ? "the application" : "one feature"} - ` +
        `treat every finding below as unverified until it is resolved.`,
    };
    break;
  }

  return { clusters, singletons, environmental };
}

const SEVERITY_RANK = { critical: 3, high: 2, medium: 1, low: 0 } as const;
const rank = (s: Finding["severity"]) => SEVERITY_RANK[s];

/**
 * Apply one triage verdict to every member of a cluster.
 *
 * The members are not deleted and not hidden - each keeps its own entry and
 * says which cluster decided it. A reader can still see all nine failures; they
 * simply are not told nine separate stories about one problem.
 */
export function applyClusterVerdict(cluster: Cluster, representative: Finding): void {
  for (const member of cluster.members) {
    if (member.id === representative.id) continue;

    member.tier = representative.tier;
    member.tierReason =
      `Same cause as ${representative.title.slice(0, 60)} (${cluster.evidence}). ` +
      `${representative.tierReason ?? ""}`.trim();
    member.determinism = representative.determinism;
    member.verifiedBy = `${representative.verifiedBy ?? "triage"} (via ${cluster.id})`;
  }
}

export function describeClusters(result: ClusterResult): string[] {
  const lines: string[] = [];

  if (result.environmental) {
    lines.push(`ENVIRONMENT  ${result.environmental.note}`);
    lines.push("");
  }

  for (const cluster of result.clusters) {
    lines.push(`${cluster.id}  ${cluster.sharedCause}`);
    lines.push(`  shared: ${cluster.evidence}`);
    for (const m of cluster.members) {
      lines.push(`    ${m.id === cluster.representative.id ? "*" : " "} ${m.title.slice(0, 74)}`);
    }
  }

  if (result.clusters.length) {
    lines.push("");
    lines.push(`* triaged; the rest inherit its verdict. All ${countMembers(result)} are still reported.`);
  }

  return lines;
}

const countMembers = (r: ClusterResult) =>
  r.clusters.reduce((n, c) => n + c.members.length, 0) + r.singletons.length;
