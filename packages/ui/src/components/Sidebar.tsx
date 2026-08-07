import { useEffect, useRef, useState } from "react";
import type { Run } from "@clarvis/core/types";
import { relativeTime } from "@clarvis/core/briefing";
import type { Project } from "../data";
import { Dot, Label } from "./primitives";

/**
 * The rail.
 *
 * Carries three things and refuses the rest: which project, where in it, and
 * whether anything needs a person. Axis breakdowns and agent rosters belong to
 * a single run and live in the run view - a rail whose meaning changes with
 * the open view is a rail you have to re-read every time.
 */

export type View = "briefing" | "run" | "surface" | "evidence" | "outcome";

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
      <div className="surface px-3 py-2.5">
        <p className="prose text-[11.5px]" style={{ color: "var(--color-dim)" }}>
          No projects yet. From inside one:
          <br />
          <code className="readout" style={{ color: "var(--color-signal)" }}>
            clarvis init
          </code>
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
        className="focusable surface flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
      >
        <Dot color={active?.missing ? "var(--color-sev-critical)" : "var(--color-signal)"} />
        <span className="min-w-0 flex-1">
          <span
            className="block truncate text-[13px]"
            style={{ color: "var(--color-bright)", fontWeight: 500 }}
          >
            {active?.name ?? "Select project"}
          </span>
          <span className="readout block text-[10.5px]" style={{ color: "var(--color-dim)" }}>
            {active?.missing ? "directory missing" : `${active?.runCount ?? 0} run(s)`}
          </span>
        </span>
        <svg viewBox="0 0 10 6" className="size-2.5 shrink-0" fill="none" aria-hidden>
          <path d="M1 1l4 4 4-4" stroke="var(--color-dim)" strokeWidth="1.3" />
        </svg>
      </button>

      {open && (
        <ul
          role="listbox"
          className="surface-raised absolute inset-x-0 top-full z-30 mt-1.5 max-h-[300px] overflow-y-auto py-1"
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
                className="focusable flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--color-ink-300)]"
                style={{ background: p.id === activeId ? "var(--color-ink-300)" : undefined }}
                title={p.path}
              >
                <Dot color={p.missing ? "var(--color-sev-critical)" : "var(--color-ink-500)"} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px]" style={{ color: "var(--color-body)" }}>
                    {p.name}
                  </span>
                  <span className="readout block truncate text-[10px]" style={{ color: "var(--color-dim)" }}>
                    {p.missing ? "missing" : `${p.runCount ?? 0} run(s)`}
                  </span>
                </span>
              </button>
            </li>
          ))}

          {/* Read-only. Projects are added from the terminal, inside the repo
              being tested - which is where someone already is when the thought
              occurs to them. */}
          <li className="mt-1 border-t px-3 py-2" style={{ borderColor: "var(--color-hair)" }}>
            <span className="prose block text-[10.5px]" style={{ color: "var(--color-dim)" }}>
              <code className="readout" style={{ color: "var(--color-signal-deep)" }}>
                clarvis init
              </code>{" "}
              in a project to add it
            </span>
          </li>
        </ul>
      )}
    </div>
  );
}

const NAV: Array<{ view: View; label: string; hint: string }> = [
  { view: "briefing", label: "Briefing", hint: "how are we doing" },
  { view: "run", label: "Run", hint: "what happened, what is wrong" },
  { view: "surface", label: "Surface", hint: "what was reached" },
  { view: "evidence", label: "Evidence", hint: "what we judge against" },
  { view: "outcome", label: "Outcome", hint: "ship or hold, and the tickets" },
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
  const confirmed = run?.findings?.filter((f) => f.tier === "CONFIRMED") ?? [];
  const critical = confirmed.filter((f) => f.severity === "critical").length;
  const running = run?.status === "running";

  const statusColor = !run
    ? "var(--color-dim)"
    : running
      ? "var(--color-signal)"
      : run.status === "blocked"
        ? "var(--color-sev-critical)"
        : critical > 0
          ? "var(--color-sev-critical)"
          : confirmed.length > 0
            ? "var(--color-attend)"
            : "var(--color-good)";

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-baseline gap-2.5 px-5 pt-6 pb-5">
        <span
          style={{
            color: "var(--color-bright)",
            fontSize: 16,
            fontWeight: 600,
            letterSpacing: "0.34em",
          }}
        >
          CLARVIS
        </span>
        {/* One lit pip, always. The system is present even when idle. */}
        <span
          className="size-[5px] rounded-full"
          style={{
            background: "var(--color-signal)",
            boxShadow: "0 0 10px 0 var(--color-signal)",
          }}
        />
      </div>

      <div className="px-4">
        <Label className="mb-2 block">project</Label>
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
              title={item.hint}
              className="focusable flex w-full items-center gap-3 px-3 py-2 text-left transition-colors"
              style={{
                color: isActive ? "var(--color-bright)" : "var(--color-muted)",
                background: isActive ? "var(--color-ink-200)" : "transparent",
                borderLeft: `2px solid ${isActive ? "var(--color-signal)" : "transparent"}`,
                borderRadius: "0 var(--radius-sm) var(--radius-sm) 0",
                fontSize: 13,
                fontWeight: isActive ? 500 : 400,
              }}
            >
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* One line, answering "does anything need me". */}
      <div className="mt-auto border-t px-5 py-4" style={{ borderColor: "var(--color-hair)" }}>
        {run ? (
          <>
            <div className="flex items-center gap-2">
              <Dot color={statusColor} live={running} />
              <span className="text-[12px]" style={{ color: statusColor, fontWeight: 500 }}>
                {running
                  ? (run.stage?.label ?? "running")
                  : run.status === "blocked"
                    ? "Blocked"
                    : critical > 0
                      ? `${critical} critical`
                      : confirmed.length > 0
                        ? `${confirmed.length} confirmed`
                        : "Nothing confirmed"}
              </span>
            </div>
            <p className="readout mt-1.5 text-[10.5px]" style={{ color: "var(--color-dim)" }}>
              {running ? "in progress" : `last run ${relativeTime(run.startedAt, new Date())}`}
            </p>
          </>
        ) : (
          <p className="prose text-[10.5px]" style={{ color: "var(--color-dim)" }}>
            No runs in this project yet.
          </p>
        )}
      </div>
    </div>
  );
}
