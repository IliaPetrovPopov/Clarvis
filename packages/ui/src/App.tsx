import { useCallback, useEffect, useState } from "react";
import type { Run } from "@clarvis/core/types";
import { loadProjects, loadRunsFor, loadFixture, type Project } from "./data";
import { RunHeader } from "./components/RunHeader";
import { Findings } from "./components/Findings";
import { Pipeline } from "./components/Pipeline";
import { Briefing } from "./components/Briefing";
import { AxisStrip } from "./components/AxisStrip";
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

      // Last choice wins. Failing that, open on a project that has something to
      // show: landing on an empty one every time makes the dashboard look
      // broken when the data is one click away.
      const remembered = localStorage.getItem(LAST_PROJECT_KEY);
      const withRuns = list.find((p) => !p.missing && (p.runCount ?? 0) > 0);
      setActiveId(
        list.some((p) => p.id === remembered) ? remembered! : (withRuns ?? list[0]).id,
      );
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

    // A run takes minutes and writes its record as it goes, so a dashboard that
    // reads once shows a stale picture for the whole of it - and, worse, shows
    // nothing at all for a run that is currently happening. Polling is enough
    // here: the file is local, the payload is small, and a socket would be a
    // second transport to keep working for no gain a reader would notice.
    const poll = async (first: boolean): Promise<void> => {
      const runs = await loadRunsFor(activeId);
      if (cancelled) return;

      setLatest(runs.latest);
      setPrevious(runs.previous);
      setSource(runs.source);
      if (first) setLoading(false);

      // Faster while something is happening, slow otherwise - so an idle
      // dashboard left open all day costs almost nothing.
      const active = runs.latest?.status === "running";
      timer = setTimeout(() => void poll(false), active ? 3000 : 15_000);
    };

    void poll(true);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeId]);

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

  return (
    <>
      <div className="scanline" aria-hidden />

      <div className="relative z-10 grid h-full grid-cols-1 lg:grid-cols-[248px_minmax(0,1fr)]">
        {/* Desktop rail */}
        <div className="hidden border-r lg:block" style={{ borderColor: "var(--color-edge)" }}>
          {rail}
        </div>

        {/* Mobile: a bar that opens the same rail as a drawer, so there is one
            navigation implementation rather than two that can disagree. */}
        <header
          className="sticky top-0 z-30 flex items-center gap-3 border-b px-4 py-3 backdrop-blur lg:hidden"
          style={{
            borderColor: "var(--color-edge)",
            background: "color-mix(in srgb, var(--color-void) 88%, transparent)",
          }}
        >
          <button
            onClick={() => setDrawer(true)}
            aria-label="Open navigation"
            aria-expanded={drawer}
            className="flex size-9 flex-col items-center justify-center gap-[5px]"
            style={{ border: "1px solid var(--color-edge-bright)" }}
          >
            {[0, 1, 2].map((i) => (
              <span key={i} className="block h-px w-4" style={{ background: "var(--color-cyan)" }} />
            ))}
          </button>
          <span
            className="hud-type glow text-[15px]"
            style={{ color: "var(--color-cyan)", letterSpacing: "0.3em" }}
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
              className="absolute inset-0"
              style={{ background: "rgba(2,5,10,.75)" }}
              onClick={() => setDrawer(false)}
              aria-label="Close navigation"
            />
            <div
              className="absolute inset-y-0 left-0 w-[min(80vw,288px)] border-r"
              style={{ background: "var(--color-void)", borderColor: "var(--color-edge)" }}
            >
              {rail}
            </div>
          </div>
        )}

        <main className="h-full overflow-y-auto">
          {loading ? (
            <div className="grid h-full place-items-center">
              <Label>reading runs...</Label>
            </div>
          ) : !latest ? (
            <div className="grid h-full place-items-center px-8 text-center">
              <div>
                <Label>no runs in this project</Label>
                <p className="mt-3 max-w-[46ch] text-[12px] leading-relaxed" style={{ color: "var(--color-muted)" }}>
                  {active?.missing
                    ? `The directory for ${active.name} is no longer there. It was at ${active.path}.`
                    : "Nothing has been run here yet. Start one from the terminal and it will appear."}
                </p>
                {!active?.missing && (
                  <code className="mt-3 block text-[11.5px]" style={{ color: "var(--color-cyan)" }}>
                    clarvis run --project {active?.path ?? "<dir>"}
                  </code>
                )}
              </div>
            </div>
          ) : view === "briefing" ? (
            <Briefing latest={latest} previous={previous} onOpenRun={() => setView("run")} />
          ) : (
            <>
              <RunHeader run={latest} source={source === "fixture" ? "fixture" : "live"} />
              <AxisStrip run={latest} />
              {/* Before the findings: how far the run actually reached decides
                  how much an empty findings list is worth. */}
              <Pipeline run={latest} />
              <Findings run={latest} />
            </>
          )}
        </main>
      </div>
    </>
  );
}
