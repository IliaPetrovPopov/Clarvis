import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "@playwright/test";
import { decideGuard } from "./guard.ts";
import type { Profile } from "./types.ts";

/**
 * What this application actually looks like, observed rather than inferred.
 *
 * The spec author reads source. That is the root of the largest class of wrong
 * findings this system has produced, and it is worth being precise about why:
 * source says what a component is written as, and a selector matches what the
 * browser built. Between the two sit a component library, a CSS-in-JS runtime,
 * a portal, a wrapper that forwards props to a different element, and a
 * translation layer. An author reading `<Button>Save</Button>` cannot know
 * whether that renders a button, an anchor, or a div with a click handler, and
 * a spec built on the wrong guess fails against a working application.
 *
 * So the page is visited and its accessibility tree captured. That tree is
 * exactly what `getByRole` matches against, which makes it the one description
 * of a page a selector can be written from without guessing. Handing it to the
 * author turns selector-writing from inference into transcription.
 *
 * Two other facts fall out of visiting, both of which were previously guessed:
 *
 *   Which routes exist. Read from the framework's own routing convention, so
 *   the author is never left to invent one. A spec that navigates to a route
 *   that does not exist reports a 404 as a defect.
 *
 *   Which routes need a session. Determined by visiting anonymously and seeing
 *   whether it redirects - a fact, where reading middleware for guard logic is
 *   an inference that has already been wrong. A spec that visits a protected
 *   page anonymously sees a login screen and reports the real page as broken.
 *
 * Everything here is read-only: routes are read from disk, pages are fetched
 * with GET. The guard is consulted first regardless, so a forbidden host is
 * never contacted.
 */

export interface DiscoveredRoute {
  /** As the framework declares it: "/users/[id]" stays in its own notation. */
  path: string;
  /** Where the declaration was found, so a human can check it. */
  source: string;
  /** True when the path contains a parameter and cannot be visited as written. */
  dynamic: boolean;
  /**
   * The path actually requested, once known parameters are filled in.
   *
   * Not every parameter is unknown. A locale segment has a small enumerable set
   * of legitimate values that the application itself declares, and an
   * internationalised application puts one in front of every route it has - so
   * treating all parameters alike marks the entire surface unvisitable and
   * probes nothing. Measured on a real application: 47 of 47 routes.
   *
   * A record id is genuinely unknown and stays that way. The difference is
   * whether a correct value can be had without inventing one.
   */
  visitPath?: string;
}

/**
 * Parameter names whose value the application declares rather than stores.
 *
 * Deliberately short. A name belongs here only when a wrong value produces a
 * 404 rather than a different record, because a probe is a GET against a
 * running application and must not be able to read someone else's row.
 */
const ENUMERABLE_PARAMS = ["locale", "lang", "language", "lng"] as const;

/** The parameter names in a route, in either bracket or colon notation. */
export function paramsIn(routePath: string): string[] {
  const names: string[] = [];
  for (const m of routePath.matchAll(/\[\.{0,3}([^\]]+)\]|:([A-Za-z0-9_]+)/g)) {
    names.push((m[1] ?? m[2]).replace(/^\.{3}/, ""));
  }
  return names;
}

/**
 * Fill in the parameters whose values are known, and say whether all were.
 *
 * A route is visitable only when EVERY parameter resolves. One unknown id makes
 * the whole path unusable, however many locales are known.
 */
export function resolveRoutePath(
  routePath: string,
  values: Record<string, string>,
): { visitPath?: string; dynamic: boolean } {
  const names = paramsIn(routePath);
  if (!names.length) return { visitPath: routePath, dynamic: false };

  // Checked against undefined, not falsiness: the empty string is a legitimate
  // resolution - it is what a locale segment is worth when the framework omits
  // the default locale from the URL - and treating it as unresolved would mark
  // the entire surface unvisitable in exactly the case this exists to handle.
  const unresolved = names.filter((n) => values[n] === undefined);
  if (unresolved.length) return { dynamic: true };

  const filled = routePath
    .replace(/\[\.{0,3}([^\]]+)\]/g, (_, name: string) => values[name.replace(/^\.{3}/, "")])
    .replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => values[name]);

  // A parameter can legitimately resolve to nothing. Frameworks routinely omit
  // the default locale from the URL while still declaring the segment, so
  // "/[locale]/explore" is served at "/explore" - and the empty substitution
  // leaves a double slash that no server matches.
  const collapsed = filled.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");

  return { visitPath: collapsed || "/", dynamic: false };
}

/**
 * Work out what a declared parameter is really worth, from links the
 * application itself renders.
 *
 * A routing convention says a segment exists; it does not say whether the URL
 * carries it. Frameworks commonly declare "[locale]" and then serve the default
 * locale with no prefix at all, so a probe of "/en/explore" 404s while
 * "/explore" is the real page. Measured on a real application: 46 of 47 routes
 * were declared under "[locale]" and not one URL contained a locale.
 *
 * Links are evidence. Every href the application renders is a URL it serves, so
 * matching those against the declared patterns says what the parameter resolves
 * to - including resolving to nothing, which no amount of reading config would
 * have revealed.
 */
export function inferParamFromLinks(
  declared: string[],
  harvested: string[],
): { name: string; value: string } | undefined {
  const links = new Set(harvested.map((h) => h.replace(/\/$/, "") || "/"));

  for (const routePath of declared) {
    // Only a leading parameter, which is the shape a prefix takes.
    const match = /^\/\[\.{0,3}([^\]]+)\](\/.*)?$/.exec(routePath);
    if (!match) continue;

    const name = match[1].replace(/^\.{3}/, "");
    if (!(ENUMERABLE_PARAMS as readonly string[]).includes(name.toLowerCase())) continue;

    const suffix = (match[2] ?? "").replace(/\/$/, "");
    // Any further parameter in the suffix makes this pattern unmatchable.
    if (paramsIn(suffix).length) continue;

    // Served with no prefix at all.
    if (links.has(suffix || "/")) return { name, value: "" };

    // Served under a language tag.
    for (const link of links) {
      const [first, ...rest] = link.split("/").filter(Boolean);
      if (!first || !/^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/.test(first)) continue;
      if (`/${rest.join("/")}`.replace(/\/$/, "") === suffix) return { name, value: first };
    }
  }

  return undefined;
}

/**
 * The parameter values this application makes knowable.
 *
 * The locale comes from the profile when recon recorded one. Anything else is
 * left unknown rather than guessed - a probe against an invented id is a 404
 * recorded as a broken route.
 */
export function knownParamValues(profile: Profile): Record<string, string> {
  const values: Record<string, string> = {};
  const locale = profile.stack?.locales?.[0];
  if (locale) {
    for (const name of ENUMERABLE_PARAMS) values[name] = locale;
  }
  return values;
}

export interface ProbedRoute extends DiscoveredRoute {
  /** Where the browser ended up. Different from `path` means it redirected. */
  landedOn?: string;
  status?: number;
  /**
   * Observed, not read from middleware: anonymous access redirected somewhere
   * that looks like a login page.
   */
  requiresAuth?: boolean;
  /** The accessibility tree, as Playwright renders it. The selector source. */
  ariaSnapshot?: string;
  title?: string;
  /** Set when the route could not be probed, with why. */
  note?: string;
}

export interface SurfaceMap {
  routes: ProbedRoute[];
  /** Role the probe was authenticated as, if any. */
  probedAs?: string;
  discoveredBy: string[];
  warnings: string[];
}

/* ------------------------------------------------------------- discovery */

const PAGE_EXT = /\.(tsx|ts|jsx|js|vue|svelte)$/;

/** Route-group and private folders that do not appear in the URL. */
const isGroupSegment = (s: string) => /^\(.+\)$/.test(s) || s.startsWith("_") || s.startsWith("@");

const hasParam = (routePath: string) => /[:[]|\.\.\./.test(routePath);

function normalise(segments: string[]): string {
  const kept = segments.filter((s) => s && !isGroupSegment(s));
  return kept.length ? `/${kept.join("/")}` : "/";
}

interface Convention {
  name: string;
  /** Directories to walk, relative to the project root. First that exists wins. */
  dirs: string[];
  /** A file is a route only if this matches its basename. */
  isRouteFile: (basename: string) => boolean;
  /** Turn the directory path between dir and file into URL segments. */
  toSegments: (relativeDir: string, basename: string) => string[];
}

/**
 * The framework conventions, most specific first.
 *
 * Only conventions where a file's location IS the route. Config-driven routers
 * are handled separately, because there the route lives in source rather than
 * in the filesystem.
 */
const CONVENTIONS: Convention[] = [
  {
    name: "next-app-router",
    dirs: ["app", "src/app"],
    isRouteFile: (b) => /^page\.(tsx|ts|jsx|js)$/.test(b),
    toSegments: (dir) => dir.split(path.sep),
  },
  {
    name: "sveltekit",
    dirs: ["src/routes"],
    isRouteFile: (b) => /^\+page\.(svelte|ts|js)$/.test(b),
    toSegments: (dir) => dir.split(path.sep),
  },
  {
    name: "next-pages-router",
    dirs: ["pages", "src/pages"],
    isRouteFile: (b) => PAGE_EXT.test(b) && !/^_(app|document|error)\./.test(b),
    toSegments: (dir, basename) => {
      const stem = basename.replace(PAGE_EXT, "");
      const segments = dir.split(path.sep);
      return stem === "index" ? segments : [...segments, stem];
    },
  },
  {
    name: "nuxt",
    dirs: ["pages"],
    isRouteFile: (b) => /\.vue$/.test(b),
    toSegments: (dir, basename) => {
      const stem = basename.replace(/\.vue$/, "");
      const segments = dir.split(path.sep);
      return stem === "index" ? segments : [...segments, stem];
    },
  },
];

async function walkFiles(root: string, max = 4000): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const out: string[] = [];
  const skip = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt", ".svelte-kit", "coverage"]);

  const walk = async (dir: string): Promise<void> => {
    if (out.length >= max) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (out.length >= max) return;
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full);
    }
  };

  await walk(root);
  return out;
}

/**
 * Routes declared by file location.
 *
 * Every matching convention is applied rather than only the first: a project
 * can genuinely run two routers at once, and picking one would silently hide
 * half the application.
 */
export async function discoverFileRoutes(
  projectRoot: string,
): Promise<{ routes: DiscoveredRoute[]; conventions: string[] }> {
  const { stat } = await import("node:fs/promises");
  const routes = new Map<string, DiscoveredRoute>();
  const conventions: string[] = [];

  for (const convention of CONVENTIONS) {
    for (const dir of convention.dirs) {
      const abs = path.join(projectRoot, dir);
      const exists = await stat(abs).then((s) => s.isDirectory()).catch(() => false);
      if (!exists) continue;

      const files = await walkFiles(abs);
      let found = 0;

      for (const file of files) {
        const basename = path.basename(file);
        if (!convention.isRouteFile(basename)) continue;

        const relativeDir = path.relative(abs, path.dirname(file));
        const segments = convention.toSegments(relativeDir, basename);
        const routePath = normalise(segments);
        found++;

        // First declaration wins: two conventions describing the same URL are
        // the same route, and the earlier convention is the more specific one.
        if (!routes.has(routePath)) {
          routes.set(routePath, {
            path: routePath,
            source: path.relative(projectRoot, file),
            dynamic: hasParam(routePath),
          });
        }
      }

      if (found) conventions.push(`${convention.name} (${dir}, ${found} route(s))`);
      // A convention that matched here does not need its other candidate dirs.
      if (found) break;
    }
  }

  return { routes: [...routes.values()], conventions };
}

/**
 * Routes declared in source, for routers configured rather than filed.
 *
 * Deliberately conservative. A regex over source is a weaker signal than a file
 * path, so only unambiguous literal paths are taken - a template literal or a
 * variable is skipped rather than guessed at, because a route invented here
 * sends a spec somewhere that does not exist.
 */
export async function discoverConfigRoutes(projectRoot: string): Promise<DiscoveredRoute[]> {
  const files = (await walkFiles(path.join(projectRoot, "src")))
    .concat(await walkFiles(path.join(projectRoot, "app")))
    .filter((f) => /\.(tsx|ts|jsx|js)$/.test(f))
    .slice(0, 400);

  const routes = new Map<string, DiscoveredRoute>();
  const patterns = [
    /<Route\s[^>]*\bpath\s*=\s*["'](\/[^"'{}$]*)["']/g,
    /\bpath\s*:\s*["'](\/[^"'{}$]*)["']/g,
  ];

  for (const file of files) {
    const source = await readFile(file, "utf8").catch(() => "");
    if (!source.includes("path")) continue;

    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (let m = pattern.exec(source); m; m = pattern.exec(source)) {
        const routePath = m[1];
        // A wildcard is a catch-all, not a page.
        if (!routePath || routePath.includes("*")) continue;
        if (routes.has(routePath)) continue;
        routes.set(routePath, {
          path: routePath,
          source: path.relative(projectRoot, file),
          dynamic: hasParam(routePath),
        });
      }
    }
  }

  return [...routes.values()];
}

/* ----------------------------------------------------------------- probe */

/** A landing URL that looks like an authentication wall. */
function looksLikeLogin(url: string, loginUrl?: string): boolean {
  const pathname = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();

  if (loginUrl) {
    const known = loginUrl.startsWith("http") ? new URL(loginUrl).pathname : loginUrl;
    if (pathname.replace(/\/$/, "") === known.replace(/\/$/, "")) return true;
  }
  return /\/(login|signin|sign-in|auth)(\/|$)/i.test(pathname);
}

export interface ProbeOptions {
  profile: Profile;
  routes: DiscoveredRoute[];
  /** storageState path. Omit to probe anonymously, which is how auth is detected. */
  storageState?: string;
  probedAs?: string;
  /** Cap, so a large application does not turn one probe into an hour. */
  maxRoutes?: number;
  browser?: Browser;
  log?: (line: string) => void;
}

/**
 * Visit each route and record what is really there.
 *
 * Dynamic routes are listed but not visited: `/users/[id]` as written is a
 * literal path the application does not serve, and probing it produces a 404
 * that would be recorded as the route being broken.
 */
export async function probeRoutes(opts: ProbeOptions): Promise<SurfaceMap> {
  const log = opts.log ?? (() => {});
  const warnings: string[] = [];

  const decision = decideGuard(opts.profile);
  if (decision.mode === "aborted") {
    return { routes: [], discoveredBy: [], warnings: [decision.reason] };
  }

  const base = opts.profile.boot.url.replace(/\/$/, "");
  const max = opts.maxRoutes ?? 40;

  const visitable = opts.routes.filter((r) => !r.dynamic && (r.visitPath ?? r.path));
  const skipped = opts.routes.filter((r) => r.dynamic || !(r.visitPath ?? r.path));
  const selected = visitable.slice(0, max);

  if (visitable.length > max) {
    warnings.push(
      `${visitable.length} static routes were found and the first ${max} were probed. ` +
        `The rest are listed without a snapshot, so a spec targeting one is writing selectors blind.`,
    );
  }

  const browser = opts.browser ?? (await chromium.launch());
  const ownsBrowser = !opts.browser;
  const probed: ProbedRoute[] = [];

  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      ...(opts.storageState ? { storageState: opts.storageState } : {}),
    });
    const page = await context.newPage();

    for (const route of selected) {
      const requested = route.visitPath ?? route.path;
      try {
        const response = await page.goto(`${base}${requested}`, {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });

        // Let a client-rendered page finish arriving. `networkidle` is the
        // honest wait here: the snapshot is only worth taking once the page has
        // stopped changing, and a snapshot of a loading shell describes
        // nothing an author could write a selector against.
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});

        const landedOn = new URL(page.url()).pathname;
        const redirected = landedOn.replace(/\/$/, "") !== requested.replace(/\/$/, "");
        const requiresAuth = !opts.storageState && redirected && looksLikeLogin(page.url(), opts.profile.auth.loginUrl);

        const ariaSnapshot = await page
          .locator("body")
          .ariaSnapshot({ timeout: 15_000 })
          .catch(() => undefined);

        probed.push({
          ...route,
          landedOn: redirected ? landedOn : undefined,
          status: response?.status(),
          requiresAuth,
          title: requiresAuth ? undefined : await page.title().catch(() => undefined),
          // A snapshot of the wrong page is worse than none at all. This
          // browser was sent to the login screen, so keeping what it saw would
          // file the login form's controls under the protected route's name and
          // an author would write selectors for a page it is not testing.
          ariaSnapshot: requiresAuth ? undefined : ariaSnapshot?.slice(0, 6000),
          note: requiresAuth
            ? "Anonymous access redirected to a login page, so this route needs a session. " +
              "No snapshot was kept: the browser was looking at the login form, not at this route."
            : undefined,
        });

        log(
          `${requested} ${response?.status() ?? "?"}` +
            (requiresAuth ? " (needs a session)" : redirected ? ` -> ${landedOn}` : ""),
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        probed.push({ ...route, note: `Could not be visited: ${message.slice(0, 200)}` });
        log(`${requested} could not be visited`);
      }
    }

    await context.close().catch(() => {});
  } finally {
    if (ownsBrowser) await browser.close().catch(() => {});
  }

  for (const route of skipped) {
    probed.push({
      ...route,
      note: "Dynamic route. It needs a real id to visit, so no snapshot was taken.",
    });
  }
  for (const route of visitable.slice(max)) {
    probed.push({ ...route, note: "Beyond the probe limit, so no snapshot was taken." });
  }

  return { routes: probed, probedAs: opts.probedAs, discoveredBy: [], warnings };
}

/**
 * Discover and probe in one pass.
 *
 * Probes anonymously first - that is what makes `requiresAuth` an observation -
 * then re-probes the protected routes with a session so their snapshots
 * describe the real page rather than the login screen.
 */
export async function mapSurface(opts: {
  profile: Profile;
  storageState?: string;
  probedAs?: string;
  maxRoutes?: number;
  log?: (line: string) => void;
}): Promise<SurfaceMap> {
  const log = opts.log ?? (() => {});
  const root = opts.profile.project.root;

  const { routes: fileRoutes, conventions } = await discoverFileRoutes(root);
  const discoveredBy = [...conventions];

  let routes = fileRoutes;
  if (!routes.length) {
    const configRoutes = await discoverConfigRoutes(root);
    if (configRoutes.length) {
      routes = configRoutes;
      discoveredBy.push(`route config in source (${configRoutes.length} route(s))`);
    }
  }

  if (!routes.length) {
    return {
      routes: [],
      discoveredBy,
      warnings: [
        "No routing convention was recognised, so no route list could be built. Spec authors " +
          "will have to find routes in the source themselves, which is slower and can invent one.",
      ],
    };
  }

  log(`${routes.length} route(s) declared: ${discoveredBy.join(", ")}`);

  const browser = await chromium.launch();
  const warnings: string[] = [];

  try {
    // Ask the application what its own prefix is before assuming one. An
    // internationalised app redirects "/" to its default locale, and that
    // observation beats every inference available from source or config -
    // including the profile, which recon may have recorded from a list of
    // supported locales rather than the active default.
    const values = knownParamValues(opts.profile);
    const root = await observeRoot(browser, opts.profile, opts.storageState).catch(() => ({
      prefix: undefined,
      links: [] as string[],
    }));

    if (root.prefix) {
      for (const name of ENUMERABLE_PARAMS) values[name] = root.prefix;
      log(`the application redirects / to /${root.prefix}, so that prefix is used`);
    }

    // A framework can declare a "[locale]" segment and then serve the default
    // locale with no prefix, in which case the profile and the redirect both
    // say "en" and every probe of "/en/..." 404s. Rather than reason about
    // which signal to trust, ask the application: request one route under each
    // candidate and keep whichever answers.
    const resolvedParam = await resolveEnumerableParam({
      browser,
      profile: opts.profile,
      routes,
      storageState: opts.storageState,
      candidates: [
        inferParamFromLinks(
          routes.map((r) => r.path),
          root.links,
        )?.value,
        root.prefix,
        "",
        opts.profile.stack?.locales?.[0],
        "en",
      ],
    });

    if (resolvedParam) {
      for (const name of ENUMERABLE_PARAMS) values[name] = resolvedParam.value;
      log(
        resolvedParam.value
          ? `[${resolvedParam.name}] answers as "${resolvedParam.value}" (${resolvedParam.evidence})`
          : `[${resolvedParam.name}] is not in the URL at all (${resolvedParam.evidence})`,
      );
    }

    const resolved = routes.map((route) => ({ ...route, ...resolveRoutePath(route.path, values) }));

    // A link the application renders that no convention declared is still a
    // real page. Adding them is what catches a router this module cannot read.
    const declared = new Set(resolved.map((r) => r.visitPath ?? r.path));
    for (const link of root.links) {
      if (declared.has(link) || declared.has(link.replace(/\/$/, ""))) continue;
      resolved.push({ path: link, source: "a link on /", dynamic: false, visitPath: link });
      declared.add(link);
    }
    const stillDynamic = resolved.filter((r) => r.dynamic).length;
    if (stillDynamic) {
      warnings.push(
        `${stillDynamic} of ${resolved.length} routes take a record id, so they were not visited ` +
          `and have no snapshot. A spec targeting one is writing selectors blind.`,
      );
    }

    const anonymous = await probeRoutes({ ...opts, routes: resolved, browser, log });

    if (!opts.storageState) {
      return { ...anonymous, discoveredBy, warnings: [...warnings, ...anonymous.warnings] };
    }

    // Re-probe only what the anonymous pass could not see. Snapshotting a login
    // screen and labelling it "/admin" is worse than having no snapshot: the
    // author would write selectors for a page that is not the one under test.
    const gated = anonymous.routes.filter((r) => r.requiresAuth);
    if (!gated.length) {
      return { ...anonymous, discoveredBy, warnings: [...warnings, ...anonymous.warnings] };
    }

    log(`${gated.length} route(s) need a session; re-probing as ${opts.probedAs ?? "an authenticated user"}`);
    const authed = await probeRoutes({ ...opts, routes: gated, browser, log });

    const merged = new Map(anonymous.routes.map((r) => [r.path, r]));
    for (const route of authed.routes) {
      const before = merged.get(route.path);
      merged.set(route.path, {
        ...route,
        // Keep what the anonymous pass established. The authenticated probe
        // cannot observe it, and overwriting would erase the only evidence
        // that this route is protected at all.
        requiresAuth: before?.requiresAuth ?? route.requiresAuth,
        // The anonymous note says no snapshot was kept, which stops being true
        // the moment this pass takes one. Carrying it over would tell an author
        // it is writing blind against a page it has in front of it.
        note: route.ariaSnapshot
          ? `Protected route, snapshotted while logged in${opts.probedAs ? ` as ${opts.probedAs}` : ""}.`
          : (route.note ?? before?.note),
      });
    }

    return {
      routes: [...merged.values()],
      probedAs: opts.probedAs,
      discoveredBy,
      warnings: [...warnings, ...anonymous.warnings, ...authed.warnings],
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Where the application sends a visitor who asks for "/".
 *
 * A single-segment redirect that looks like a language tag is the application
 * declaring its own default locale, which is a stronger signal than any list of
 * supported locales: it is the one the router will actually use.
 */
/**
 * Ask the application what its own prefix is, by requesting one.
 *
 * Every other signal available here is an inference: a config file lists
 * supported locales without saying which appear in URLs, a redirect on "/"
 * shows one convention that inner routes need not share, and a link is only
 * evidence when the page rendered one. All three have been wrong.
 *
 * A request is not an inference. One route, each candidate in turn, keep what
 * answers - and when several answer, keep the first, because the ordering
 * already places the better-evidenced candidate ahead of the guess.
 */
async function resolveEnumerableParam(opts: {
  browser: Browser;
  profile: Profile;
  routes: DiscoveredRoute[];
  storageState?: string;
  candidates: Array<string | undefined>;
}): Promise<{ name: string; value: string; evidence: string } | undefined> {
  // A route whose ONLY parameter is an enumerable one, so a single substitution
  // makes it concrete and the result is attributable to that substitution.
  const probe = opts.routes.find((route) => {
    const names = paramsIn(route.path);
    if (names.length !== 1) return false;
    return (ENUMERABLE_PARAMS as readonly string[]).includes(names[0].toLowerCase());
  });
  if (!probe) return undefined;

  const name = paramsIn(probe.path)[0];
  const base = opts.profile.boot.url.replace(/\/$/, "");

  const seen = new Set<string>();
  const context = await opts.browser.newContext({
    ignoreHTTPSErrors: true,
    ...(opts.storageState ? { storageState: opts.storageState } : {}),
  });

  try {
    for (const candidate of opts.candidates) {
      if (candidate === undefined || seen.has(candidate)) continue;
      seen.add(candidate);

      const { visitPath } = resolveRoutePath(probe.path, { [name]: candidate });
      if (!visitPath) continue;

      const response = await context.request
        .get(`${base}${visitPath}`, { failOnStatusCode: false, timeout: 20_000 })
        .catch(() => undefined);

      if (response && response.status() < 400) {
        return { name, value: candidate, evidence: `${visitPath} answered ${response.status()}` };
      }
    }
  } finally {
    await context.close().catch(() => {});
  }

  return undefined;
}

async function observeRoot(
  browser: Browser,
  profile: Profile,
  storageState?: string,
): Promise<{ prefix?: string; links: string[] }> {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    ...(storageState ? { storageState } : {}),
  });
  try {
    const page = await context.newPage();
    const base = profile.boot.url.replace(/\/$/, "");
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

    const [first] = new URL(page.url()).pathname.split("/").filter(Boolean);
    // A language tag: "en", "pt-BR". Anything longer is a page, not a prefix.
    const prefix = first && /^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/.test(first) ? first : undefined;

    // Every href the application renders is a URL it actually serves. That is
    // the only description of its URL shape that cannot be wrong.
    // Passed as an expression string rather than a function: this package has
    // no DOM types, and adding them so one line can typecheck would put browser
    // globals in scope for every other module here.
    const links = await page
      .evaluate<string[]>(
        `Array.from(document.querySelectorAll("a[href]")).map((a) => a.href).filter(Boolean)`,
      )
      .catch(() => [] as string[]);

    const origin = new URL(base).origin;
    const paths = [
      ...new Set(
        links
          .map((href) => {
            try {
              const url = new URL(href, base);
              return url.origin === origin ? url.pathname : null;
            } catch {
              return null;
            }
          })
          .filter((p): p is string => Boolean(p)),
      ),
    ];

    return { prefix, links: paths };
  } finally {
    await context.close().catch(() => {});
  }
}
