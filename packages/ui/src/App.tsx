import { useCallback, useEffect, useState } from "react";
import type { Run } from "@clarvis/core/types";
import {
  loadContext,
  loadDrafts,
  loadFixture,
  loadPlan,
  loadProfile,
  loadProjects,
  loadRunsFor,
  loadVerdict,
  checkServer,
  type ContextLike,
  type DraftsLike,
  type PlanLike,
  type Project,
  type ProfileLike,
  type VerdictLike,
} from "./data";
import { RunHeader } from "./components/RunHeader";
import { Findings } from "./components/Findings";
import { Pipeline } from "./components/Pipeline";
import { Briefing } from "./components/Briefing";
import { AxisStrip } from "./components/AxisStrip";
import { Surface } from "./components/Surface";
import { Evidence } from "./components/Evidence";
import { Outcome } from "./components/Outcome";
import { Sidebar, type View } from "./components/Sidebar";
import { Label } from "./components/primitives";

const LAST_PROJECT_KEY = "clarvis:lastProject";

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>();
  const [latest, setLatest] = useState<Run | undefined>();
  const [previous, setPrevious] = useState<Run | undefined>();
  const [source, setSource] = useState<"live" | "fixture" | "empty">("empty");
  const [loading, setLoading] = useState(true);
  const [drawer, setDrawer] = useState(false);
  // The briefing is the landing view: the first question in the morning is
  // "how are we doing", not "show me every finding".
  const [view, setView] = useState<View>("briefing");

  /* The artifacts the other views read. Loaded when the project or the run
     changes, not on every poll - a command writes them, a poll does not. */
  const [profile, setProfile] = useState<ProfileLike | undefined>();
  const [context, setContext] = useState<ContextLike | undefined>();
  const [plan, setPlan] = useState<PlanLike | undefined>();
  const [verdict, setVerdict] = useState<VerdictLike | undefined>();
  const [drafts, setDrafts] = useState<DraftsLike | undefined>();
  const [staleServer, setStaleServer] = useState(false);

  /* Is the server behind this page older than the page? */
  useEffect(() => {
    void checkServer().then((r) => setStaleServer(r.stale));
  }, []);

  /* Projects, once. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await loadProjects();
      if (cancelled) return;
      setProjects(list);

      if (!list.length) {
        // No API at all means the dev server: show the bundled example rather
        // than an empty shell.
        const fixture = await loadFixture();
        if (cancelled) return;
        setLatest(fixture.latest);
        setSource(fixture.source);
        setLoading(false);
        return;
      }

      const remembered = localStorage.getItem(LAST_PROJECT_KEY);
      const withRuns = list.find((p) => !p.missing && (p.runCount ?? 0) > 0);
      setActiveId(list.some((p) => p.id === remembered) ? remembered! : (withRuns ?? list[0]).id);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* Runs, whenever the project changes - and again while one is in flight. */
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    localStorage.setItem(LAST_PROJECT_KEY, activeId);

    // A run takes minutes and writes its record as it goes, so a dashboard
    // that reads once shows a stale picture throughout - and nothing at all
    // for a run currently happening. Polling is enough: the file is local, the
    // payload is small, and a socket would be a second transport to keep
    // working for no gain a reader would notice.
    const poll = async (first: boolean): Promise<void> => {
      const runs = await loadRunsFor(activeId);
      if (cancelled) return;

      setLatest(runs.latest);
      setPrevious(runs.previous);
      setSource(runs.source);
      if (first) setLoading(false);

      const active = runs.latest?.status === "running";
      timer = setTimeout(() => void poll(false), active ? 3000 : 15_000);
    };

    void poll(true);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeId]);

  /* Project-level artifacts. */
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    void (async () => {
      const [p, c, pl] = await Promise.all([
        loadProfile(activeId),
        loadContext(activeId),
        loadPlan(activeId),
      ]);
      if (cancelled) return;
      setProfile(p);
      setContext(c);
      setPlan(pl);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  /* Per-run artifacts, keyed on the run so a new one refreshes them. */
  useEffect(() => {
    if (!activeId || !latest?.runId) return;
    let cancelled = false;
    const runId = latest.runId;
    void (async () => {
      const [v, d] = await Promise.all([loadVerdict(activeId, runId), loadDrafts(activeId, runId)]);
      if (cancelled) return;
      setVerdict(v);
      setDrafts(d);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId, latest?.runId]);

  const selectProject = useCallback((id: string) => {
    setActiveId(id);
    setDrawer(false);
  }, []);

  const selectView = useCallback((v: View) => {
    setView(v);
    setDrawer(false);
  }, []);

  const active = projects.find((p) => p.id === activeId);

  const rail = (
    <Sidebar
      projects={projects}
      activeProjectId={activeId}
      onSelectProject={selectProject}
      view={view}
      onSelectView={selectView}
      run={latest}
    />
  );

  /* Surface and Evidence describe the project rather than one run, so they
     stay readable before anything has ever been run against it. */
  const body = (() => {
    if (view === "surface") return <Surface profile={profile} />;
    if (view === "evidence") return <Evidence context={context} plan={plan} />;

    if (loading) {
      return (
        <div className="grid h-full place-items-center">
          <Label>reading runs</Label>
        </div>
      );
    }

    if (!latest) {
      return (
        <div className="grid h-full place-items-center px-8 text-center">
          <div className="max-w-[46ch]">
            <Label>no runs in this project</Label>
            <p className="prose mt-3 text-[12.5px]" style={{ color: "var(--color-muted)" }}>
              {active?.missing
                ? `The directory for ${active.name} is no longer there. It was at ${active.path}.`
                : "Nothing has been run here yet. Start one from the terminal and it appears here."}
            </p>
            {!active?.missing && (
              <code className="readout mt-3 block text-[11.5px]" style={{ color: "var(--color-signal)" }}>
                clarvis run --project {active?.path ?? "<dir>"}
              </code>
            )}
          </div>
        </div>
      );
    }

    if (view === "outcome") return <Outcome verdict={verdict} drafts={drafts} />;
    if (view === "briefing") {
      return <Briefing latest={latest} previous={previous} onOpenRun={() => setView("run")} />;
    }

    return (
      <>
        <RunHeader run={latest} source={source === "fixture" ? "fixture" : "live"} />
        <AxisStrip run={latest} />
        {/* Before the findings: how far the run reached decides what an empty
            findings list is worth. */}
        <Pipeline run={latest} />
        <Findings run={latest} />
      </>
    );
  })();

  return (
    <div className="relative z-10 grid h-full grid-cols-1 lg:grid-cols-[236px_minmax(0,1fr)]">
      <div className="hidden border-r lg:block" style={{ borderColor: "var(--color-hair)" }}>
        {rail}
      </div>

      {/* Mobile: a bar that opens the same rail as a drawer, so there is one
          navigation implementation rather than two that can disagree. */}
      <header
        className="sticky top-0 z-30 flex items-center gap-3 border-b px-4 py-3 backdrop-blur-xl lg:hidden"
        style={{
          borderColor: "var(--color-hair)",
          background: "color-mix(in srgb, var(--color-ink-000) 86%, transparent)",
        }}
      >
        <button
          onClick={() => setDrawer(true)}
          aria-label="Open navigation"
          aria-expanded={drawer}
          className="focusable surface flex size-9 flex-col items-center justify-center gap-[5px]"
        >
          {[0, 1, 2].map((i) => (
            <span key={i} className="block h-px w-4" style={{ background: "var(--color-muted)" }} />
          ))}
        </button>
        <span
          style={{ color: "var(--color-bright)", fontWeight: 600, letterSpacing: "0.3em", fontSize: 14 }}
        >
          CLARVIS
        </span>
        <span className="ml-auto truncate text-[11px]" style={{ color: "var(--color-dim)" }}>
          {active?.name}
        </span>
      </header>

      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            className="absolute inset-0 backdrop-blur-sm"
            style={{ background: "rgb(3 4 6 / 0.7)" }}
            onClick={() => setDrawer(false)}
            aria-label="Close navigation"
          />
          <div
            className="absolute inset-y-0 left-0 w-[min(82vw,280px)] border-r"
            style={{ background: "var(--color-ink-050)", borderColor: "var(--color-hair)" }}
          >
            {rail}
          </div>
        </div>
      )}

      <main className="h-full overflow-y-auto">
        {/*
          Loud, and above everything. A stale server fails one fetch at a time
          and looks like missing data, which is the one thing this product
          exists to make impossible.
        */}
        {staleServer && (
          <div
            className="px-5 py-2.5 lg:px-8"
            style={{
              background: "color-mix(in srgb, var(--color-attend) 12%, transparent)",
              borderBottom: "1px solid color-mix(in srgb, var(--color-attend) 34%, transparent)",
            }}
          >
            <p className="prose text-[12px]" style={{ color: "var(--color-attend)" }}>
              This dashboard is newer than the server behind it, so parts of it will show nothing
              rather than fail. Restart it:{" "}
              <code className="readout">clarvis ui</code>
            </p>
          </div>
        )}
        {body}
      </main>
    </div>
  );
}
