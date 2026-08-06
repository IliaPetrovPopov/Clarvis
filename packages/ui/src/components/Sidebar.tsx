import { useEffect, useRef, useState } from "react";
import type { Run } from "@clarvis/core/types";
import { relativeTime } from "@clarvis/core/briefing";
import type { Project } from "../data";
import { Dot, Label } from "./primitives";

/**
 * Navigation rail.
 *
 * Carries three things and nothing else: which project you are looking at,
 * where you are in it, and whether anything needs you. Axis breakdowns and
 * agent rosters used to live here; they belong to a single run and have moved
 * into the run view, because a rail that changes meaning depending on which
 * view is open is a rail you have to read every time.
 */

export type View = "briefing" | "run";

function ProjectSwitcher({
  projects,
  activeId,
  onSelect,
}: {
  projects: Project[];
  activeId?: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = projects.find((p) => p.id === activeId);

  // Click-away and Escape, so the menu never traps focus or lingers.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!projects.length) {
    return (
      <div className="px-3 py-2.5" style={{ border: "1px solid var(--color-edge)" }}>
        <p className="text-[11px] leading-relaxed" style={{ color: "var(--color-dim)" }}>
          No projects yet. From a project directory:
          <br />
          <code style={{ color: "var(--color-cyan)" }}>clarvis init</code>
        </p>
      </div>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="hud-clip-sm flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors"
        style={{ border: "1px solid var(--color-edge-bright)", background: "var(--color-panel)" }}
      >
        <Dot color={active?.missing ? "var(--color-sev-critical)" : "var(--color-cyan)"} />
        <span className="min-w-0 flex-1">
          <span
            className="hud-type block truncate text-[13px] uppercase"
            style={{ color: "var(--color-bright)", letterSpacing: "0.06em" }}
          >
            {active?.name ?? "Select project"}
          </span>
          <span className="block text-[10px]" style={{ color: "var(--color-dim)" }}>
            {active?.missing ? "directory missing" : `${active?.runCount ?? 0} run(s)`}
          </span>
        </span>
        <svg viewBox="0 0 10 6" className="size-2.5 shrink-0" fill="none" aria-hidden>
          <path d="M1 1l4 4 4-4" stroke="var(--color-cyan)" strokeWidth="1.3" />
        </svg>
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-[280px] overflow-y-auto"
          style={{ border: "1px solid var(--color-edge-bright)", background: "var(--color-deep)" }}
        >
          {projects.map((p) => (
            <li key={p.id}>
              <button
                role="option"
                aria-selected={p.id === activeId}
                onClick={() => {
                  onSelect(p.id);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--color-raised)]"
                style={{ background: p.id === activeId ? "var(--color-raised)" : undefined }}
                title={p.path}
              >
                <Dot color={p.missing ? "var(--color-sev-critical)" : "var(--color-cyan-dim)"} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px]" style={{ color: "var(--color-body)" }}>
                    {p.name}
                  </span>
                  <span className="block truncate text-[10px]" style={{ color: "var(--color-dim)" }}>
                    {p.missing ? "missing" : `${p.runCount ?? 0} run(s)`}
                  </span>
                </span>
              </button>
            </li>
          ))}

          {/* Read-only. Projects are added and configured from the terminal,
              inside the repo being tested - which is where someone already is
              when the thought occurs. */}
          <li style={{ borderTop: "1px solid var(--color-edge)" }} className="px-3 py-2">
            <span className="block text-[10.5px]" style={{ color: "var(--color-dim)" }}>
              <code style={{ color: "var(--color-cyan-dim)" }}>clarvis init</code> in a project to add it
            </span>
          </li>
        </ul>
      )}
    </div>
  );
}

const NAV: Array<{ view: View; label: string }> = [
  { view: "briefing", label: "Briefing" },
  { view: "run", label: "Run detail" },
];

export function Sidebar({
  projects,
  activeProjectId,
  onSelectProject,
  view,
  onSelectView,
  run,
}: {
  projects: Project[];
  activeProjectId?: string;
  onSelectProject: (id: string) => void;
  view: View;
  onSelectView: (v: View) => void;
  run?: Run;
}) {
  const confirmed = run?.findings.filter((f) => f.tier === "CONFIRMED") ?? [];
  const critical = confirmed.filter((f) => f.severity === "critical").length;

  const statusColor = !run
    ? "var(--color-dim)"
    : run.status === "blocked"
      ? "var(--color-sev-critical)"
      : critical > 0
        ? "var(--color-sev-critical)"
        : confirmed.length > 0
          ? "var(--color-amber)"
          : "var(--color-green)";

  return (
    <div className="flex h-full flex-col">
      <div className="px-5 pt-6 pb-5">
        <span
          className="hud-type glow text-[17px]"
          style={{ color: "var(--color-cyan)", letterSpacing: "0.32em" }}
        >
          CLARVIS
        </span>
      </div>

      <div className="px-4">
        <Label className="mb-2">project</Label>
        <ProjectSwitcher projects={projects} activeId={activeProjectId} onSelect={onSelectProject} />
      </div>

      <nav className="mt-6 px-2" aria-label="Views">
        {NAV.map((item) => {
          const isActive = view === item.view;
          return (
            <button
              key={item.view}
              onClick={() => onSelectView(item.view)}
              aria-current={isActive ? "page" : undefined}
              className="hud-type flex w-full items-center gap-3 px-3 py-2.5 text-left text-[13px] uppercase transition-colors"
              style={{
                color: isActive ? "var(--color-bright)" : "var(--color-muted)",
                background: isActive ? "var(--color-raised)" : "transparent",
                borderLeft: `2px solid ${isActive ? "var(--color-cyan)" : "transparent"}`,
                letterSpacing: "0.08em",
              }}
            >
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* Status, kept to the one line that answers "does anything need me". */}
      <div className="mt-auto border-t px-5 py-4" style={{ borderColor: "var(--color-edge)" }}>
        {run ? (
          <>
            <div className="flex items-center gap-2">
              <Dot color={statusColor} />
              <span className="hud-type text-[12px] uppercase" style={{ color: statusColor }}>
                {run.status === "blocked"
                  ? "Blocked"
                  : critical > 0
                    ? `${critical} critical`
                    : confirmed.length > 0
                      ? `${confirmed.length} confirmed`
                      : "Nothing confirmed"}
              </span>
            </div>
            <p className="mt-1.5 text-[10.5px]" style={{ color: "var(--color-dim)" }}>
              last run {relativeTime(run.startedAt, new Date())}
            </p>
          </>
        ) : (
          <p className="text-[10.5px]" style={{ color: "var(--color-dim)" }}>
            No runs in this project yet.
          </p>
        )}
      </div>
    </div>
  );
}
