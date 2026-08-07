import { useState } from "react";
import type { MappedRoute, ProfileLike } from "../data";
import { Bar, Dot, Field, Label, Mono, Readout, settle } from "./primitives";

/**
 * The application as Clarvis found it.
 *
 * This is the answer to "how much did it actually look at", which is the
 * question that decides what an empty findings list is worth - and until now
 * it existed only in a file nothing served.
 *
 * The accessibility snapshot is here because it is the evidence behind every
 * selector in every spec. When a test fails on a control, being able to see
 * whether that control was ever on the page is the difference between a bug in
 * the product and a bug in the test, and that used to mean opening a terminal.
 */

function routeTone(r: MappedRoute): string {
  if (r.status && r.status >= 400) return "var(--color-sev-critical)";
  if (r.dynamic) return "var(--color-ink-500)";
  if (r.requiresAuth) return "var(--color-attend)";
  if (r.ariaSnapshot) return "var(--color-good)";
  return "var(--color-ink-500)";
}

function RouteRow({ route, index }: { route: MappedRoute; index: number }) {
  const [open, setOpen] = useState(false);
  const hasSnapshot = Boolean(route.ariaSnapshot);

  /*
    A note is only worth a line when it says something this row does not
    already say. Every protected route carries the same sentence explaining
    why it has no snapshot, and printing it twelve times down a list is noise
    that buries the two rows where something unusual happened. The chips
    already convey "needs a session" and "needs an id"; the explanation for
    those belongs once, above the list.
  */
  const explained = route.requiresAuth || route.dynamic;
  const note = explained ? undefined : route.note;

  // What was actually requested, which is what a person would retype. The
  // declared form keeps its place as secondary, since that is what the
  // framework calls it and what a source search would find.
  const visited = route.visitPath && route.visitPath !== route.path ? route.visitPath : undefined;

  return (
    <li className="settle" style={settle(index)}>
      <button
        onClick={() => hasSnapshot && setOpen((v) => !v)}
        aria-expanded={hasSnapshot ? open : undefined}
        disabled={!hasSnapshot}
        className="focusable flex w-full items-baseline gap-3 px-4 py-2 text-left disabled:cursor-default"
      >
        <Dot color={routeTone(route)} />
        <Mono tone={route.dynamic ? "var(--color-dim)" : "var(--color-body)"}>
          {visited ?? route.path}
        </Mono>

        {visited && (
          <Mono tone="var(--color-ink-500)">{route.path}</Mono>
        )}

        {route.title && (
          <span className="hidden truncate text-[11.5px] sm:block" style={{ color: "var(--color-dim)" }}>
            {route.title}
          </span>
        )}

        <span className="ml-auto flex shrink-0 items-center gap-3">
          {route.requiresAuth && <Label tone="var(--color-attend)">session</Label>}
          {route.dynamic && <Label>needs an id</Label>}
          {route.status && route.status >= 400 && (
            <Label tone="var(--color-sev-critical)">{route.status}</Label>
          )}
          {hasSnapshot ? (
            <span
              className="text-[11px] transition-transform"
              style={{ color: "var(--color-dim)", transform: open ? "rotate(90deg)" : "none" }}
              aria-hidden
            >
              ›
            </span>
          ) : (
            !explained && <Label>blind</Label>
          )}
        </span>
      </button>

      {open && route.ariaSnapshot && (
        <div className="px-4 pb-3">
          <div className="surface-sunken px-3 py-2.5">
            <Label>what the browser built here</Label>
            <pre
              className="readout mt-2 max-h-[320px] overflow-auto whitespace-pre text-[11px] leading-relaxed"
              style={{ color: "var(--color-muted)" }}
            >
              {route.ariaSnapshot}
            </pre>
            {route.source && (
              <div className="mt-2">
                <Mono tone="var(--color-dim)">{route.source}</Mono>
              </div>
            )}
          </div>
        </div>
      )}

      {!hasSnapshot && note && (
        <p className="prose px-4 pb-2 pl-[41px] text-[11px]" style={{ color: "var(--color-dim)" }}>
          {note}
        </p>
      )}
    </li>
  );
}

export function Surface({ profile }: { profile?: ProfileLike }) {
  const [filter, setFilter] = useState<"all" | "snapshotted" | "blind">("all");

  if (!profile) {
    return (
      <div className="px-5 py-6 lg:px-8">
        <div className="surface px-4 py-5">
          <p className="prose text-[12.5px]" style={{ color: "var(--color-dim)" }}>
            No profile for this project yet. Run <Mono tone="var(--color-signal)">clarvis recon</Mono> and
            the map of the application appears here.
          </p>
        </div>
      </div>
    );
  }

  const routes = profile.surface?.routes ?? [];
  const snapshotted = routes.filter((r) => r.ariaSnapshot);
  const behindAuth = routes.filter((r) => r.requiresAuth);
  const blind = routes.filter((r) => !r.ariaSnapshot);

  const shown =
    filter === "snapshotted" ? snapshotted : filter === "blind" ? blind : routes;

  return (
    <div className="space-y-5 px-5 py-6 lg:px-8">
      {/* What the application is, before what it contains. */}
      <section className="surface px-4 py-4">
        <div className="grid gap-x-8 gap-y-4 lg:grid-cols-2">
          <div>
            <Field k="serves" v={profile.boot?.url ?? "unknown"} />
            <Field k="starts with" v={profile.boot?.cmd ?? "not recorded"} />
            <Field
              k="rendering"
              v={
                profile.stack?.rendering
                  ? `${profile.stack.rendering}${
                      profile.stack.hydrationMs ? ` · content at ${Math.round(profile.stack.hydrationMs)}ms` : ""
                    }`
                  : "not measured"
              }
            />
            <Field k="framework" v={profile.stack?.framework ?? "not recorded"} />
          </div>
          <div>
            <Field k="login" v={profile.auth?.loginUrl ? `${profile.auth.loginUrl} (${profile.auth.mode})` : "none"} />
            <Field
              k="roles"
              v={
                profile.auth?.roles?.length
                  ? profile.auth.roles.map((r) => r.key).join(", ")
                  : "none configured"
              }
            />
            <Field
              k="never touch"
              v={`${profile.data?.forbiddenHosts?.length ?? 0} host pattern(s)`}
            />
            <Field
              k="writable"
              v={
                profile.data?.disposable
                  ? `yes · ${(profile.data.safeTargets ?? []).join(", ") || "no targets listed"}`
                  : "no - read-only unless a database is provisioned"
              }
            />
          </div>
        </div>
      </section>

      <section className="surface">
        <header className="flex flex-wrap items-baseline gap-x-4 gap-y-2 px-4 pt-4 pb-3">
          <Label>the surface</Label>
          <span className="text-[11px]" style={{ color: "var(--color-dim)" }}>
            {profile.surface?.discoveredBy?.join(", ") ?? "not mapped"}
          </span>

          <div className="ml-auto flex gap-1.5">
            {(["all", "snapshotted", "blind"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className="focusable lbl px-2 py-1"
                style={{
                  color: filter === f ? "var(--color-bright)" : "var(--color-dim)",
                  background: filter === f ? "var(--color-ink-300)" : "transparent",
                  border: "1px solid var(--color-hair-lit)",
                  borderRadius: "var(--radius-sm)",
                }}
              >
                {f}
              </button>
            ))}
          </div>
        </header>

        <div className="grid grid-cols-3 gap-6 px-4 pb-4">
          <Readout value={routes.length} label="routes declared" />
          <Readout
            value={snapshotted.length}
            label="seen in a browser"
            tone={snapshotted.length ? "var(--color-good)" : "var(--color-dim)"}
          />
          <Readout
            value={behindAuth.length}
            label="behind a session"
            tone={behindAuth.length ? "var(--color-attend)" : "var(--color-dim)"}
          />
        </div>

        <div className="px-4 pb-4">
          <Bar
            parts={[
              { value: snapshotted.length, color: "var(--color-good)", title: "snapshotted" },
              { value: blind.length, color: "var(--color-ink-400)", title: "never seen" },
            ]}
          />
          {blind.length > 0 && (
            <p className="prose mt-2 max-w-[86ch] text-[11.5px]" style={{ color: "var(--color-dim)" }}>
              {blind.length} route(s) were never rendered, so any selector written for them came
              from source rather than from the page.
              {behindAuth.length > 0 &&
                ` ${behindAuth.length} of those redirect an anonymous visitor to the login page - the snapshot
                  taken there would have described the login form rather than the route, so none was kept.`}
            </p>
          )}
        </div>

        {shown.length ? (
          <ul className="divide-y border-t" style={{ borderColor: "var(--color-hair)" }}>
            {shown.map((r, i) => (
              <RouteRow key={r.path} route={r} index={i} />
            ))}
          </ul>
        ) : routes.length ? (
          <p className="prose px-4 pb-4 text-[12px]" style={{ color: "var(--color-dim)" }}>
            Nothing matches that filter.
          </p>
        ) : (
          // Nothing mapped and nothing filtered are different states, and
          // saying "nothing matches that filter" for the first one sends a
          // reader looking for a filter to clear that was never the problem.
          <p className="prose border-t px-4 py-4 text-[12px]" style={{ borderColor: "var(--color-hair)", color: "var(--color-dim)" }}>
            The application has not been mapped yet. It happens on the next{" "}
            <code className="readout" style={{ color: "var(--color-signal)" }}>
              clarvis run
            </code>
            , which visits every route it can reach and records what the browser actually built
            there.
          </p>
        )}
      </section>

      {profile.risk?.hotspots?.length ? (
        <section className="surface">
          <header className="px-4 pt-4 pb-2">
            <Label>where a change reaches furthest</Label>
          </header>
          <ul className="divide-y" style={{ borderColor: "var(--color-hair)" }}>
            {profile.risk.hotspots.map((h, i) => (
              <li key={i} className="settle px-4 py-2.5" style={settle(i)}>
                <div className="flex items-baseline gap-3">
                  <span className="text-[12.5px]" style={{ color: "var(--color-body)" }}>
                    {h.area}
                  </span>
                  {h.score !== undefined && (
                    <span className="readout ml-auto text-[11px]" style={{ color: "var(--color-dim)" }}>
                      {h.score}
                    </span>
                  )}
                </div>
                <p className="prose mt-0.5 text-[11.5px]" style={{ color: "var(--color-dim)" }}>
                  {h.reason}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
