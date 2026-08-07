import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A deliberately small notes app: login, a list, a create form, and an admin
 * page only one role may reach.
 *
 * It exists to be TESTED, not to be good. Some of the behaviour below is wrong
 * on purpose - see BUGS.md, which is the answer key for the benchmark. Nothing
 * here should be copied into anything real.
 *
 * No dependencies: node's own http module, in-memory state. It must start with
 * `node server.mjs` on any machine, because a benchmark fixture that needs an
 * install step is a benchmark fixture that does not run.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(readFileSync(path.join(here, "seed.json"), "utf8"));

const PORT = Number(process.env.PORT ?? 4600);

/** username -> { password, role, name } */
const users = new Map(seed.users.map((u) => [u.username, u]));
/** sessionId -> username */
const sessions = new Map();

let notes = seed.notes.map((n, i) => ({ id: String(i + 1), ...n }));
let nextId = notes.length + 1;

const LOCALES = {
  en: {
    dir: "ltr",
    title: "Notes",
    login: "Sign in",
    username: "Username",
    password: "Password",
    add: "Add note",
    admin: "Admin",
    logout: "Sign out",
    empty: "No notes yet.",
    denied: "You do not have access to this page.",
    bad: "Wrong username or password.",
  },
  ar: {
    dir: "rtl",
    title: "ملاحظات",
    login: "تسجيل الدخول",
    username: "اسم المستخدم",
    password: "كلمة المرور",
    add: "إضافة ملاحظة",
    admin: "المشرف",
    logout: "تسجيل الخروج",
    empty: "لا توجد ملاحظات.",
    denied: "ليس لديك حق الوصول إلى هذه الصفحة.",
    // BUG 4 (i18n): untranslated, renders English inside an RTL document.
    bad: "Wrong username or password.",
  },
};

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(v.join("="));
  }
  return out;
}

function currentUser(req) {
  const sid = cookies(req).sid;
  if (!sid) return undefined;
  const username = sessions.get(sid);
  return username ? users.get(username) : undefined;
}

function page(t, body, { user, locale = "en" } = {}) {
  return `<!doctype html>
<html lang="${locale}" dir="${t.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(t.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 24px; max-width: 720px; }
  header { display: flex; gap: 16px; align-items: center; margin-bottom: 24px; }
  h1 { font-size: 20px; margin: 0; flex: 1; min-width: 190px; }
  form { display: grid; gap: 8px; max-width: 320px; }
  input, button { font: inherit; padding: 8px 10px; }
  li { padding: 8px 0; border-bottom: 1px solid #8884; }
  .error { color: #c00; }
  nav { white-space: nowrap; }
  nav a { margin-inline-end: 12px; }
  /* BUG 5 (responsive): a min-width on the title plus a non-wrapping toolbar
     means the nav is pushed past the edge and clipped below ~430px, so the
     sign-out link becomes unreachable on a phone. */
  .toolbar { display: flex; flex-wrap: nowrap; gap: 12px; overflow: hidden; }
</style>
</head>
<body>
<header class="toolbar">
  <h1>${escape(t.title)}</h1>
  ${user ? `<nav><a href="/notes">${escape(t.title)}</a><a href="/admin">${escape(t.admin)}</a><a href="/logout">${escape(t.logout)}</a></nav>` : ""}
</header>
${body}
</body>
</html>`;
}

function send(res, status, html) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function redirect(res, to, extraHeaders = {}) {
  res.writeHead(302, { location: to, ...extraHeaders });
  res.end();
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return new URLSearchParams(Buffer.concat(chunks).toString());
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const locale = LOCALES[url.searchParams.get("lang")] ? url.searchParams.get("lang") : "en";
  const t = LOCALES[locale];
  const user = currentUser(req);
  const q = locale === "en" ? "" : `?lang=${locale}`;

  // Teardown for test fixtures. Loopback only: a reset route reachable from
  // anywhere is a denial-of-service button, and this app is a test target, not
  // a demonstration of good practice.
  if (url.pathname === "/__reset" && req.method === "POST") {
    const remote = req.socket.remoteAddress ?? "";
    if (!/^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(remote)) {
      res.writeHead(403).end();
      return;
    }
    reset();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === "/" ) {
    return redirect(res, user ? `/notes${q}` : `/login${q}`);
  }

  /* --------------------------------------------------------------- register */

  /*
    A signup form, so the fixture has the one path in that needs no prior
    credential. Enrolment exists because a real application often ships none,
    and a provisioned database is empty even when it does - so without this
    there is no way to reach anything behind a login, and the demo app could
    not exercise the step at all.

    Deliberately grants the lowest role. Signup is not how anyone becomes an
    admin, and a fixture that pretended otherwise would let a bug through.
  */
  if (url.pathname === "/register" && req.method === "GET") {
    return send(
      res,
      200,
      page(
        t,
        `<form method="post" action="/register${q}">
           <label>Email<input name="email" type="email" data-testid="email" autocomplete="email"></label>
           <label>Name<input name="name" data-testid="name" autocomplete="name"></label>
           <label>Password<input name="password" type="password" data-testid="password" autocomplete="new-password"></label>
           <label>Confirm<input name="confirm" type="password" data-testid="confirm" autocomplete="new-password"></label>
           <button type="submit" data-testid="submit">Create account</button>
         </form>`,
        { locale },
      ),
    );
  }

  if (url.pathname === "/register" && req.method === "POST") {
    const body = await readBody(req);
    const email = (body.get("email") ?? "").trim();
    const password = body.get("password") ?? "";

    const problem =
      !email || !email.includes("@")
        ? "A valid email is required."
        : password.length < 8
          ? "The password must be at least 8 characters."
          : password !== (body.get("confirm") ?? "")
            ? "The passwords do not match."
            : users.has(email)
              ? "That account already exists."
              : undefined;

    if (problem) {
      return send(res, 400, page(t, `<p role="alert">${escape(problem)}</p>`, { locale }));
    }

    users.set(email, {
      username: email,
      password,
      role: "viewer",
      name: (body.get("name") ?? "").trim() || "New user",
    });

    // Signed in on creation, as most applications do. Same cookie shape as
    // login, seeded bug included - the fixture must not be quietly safer on
    // one path than the other.
    const sid = randomUUID();
    sessions.set(sid, email);
    return redirect(res, `/notes${q}`, { "set-cookie": `sid=${sid}; Path=/; SameSite=Lax` });
  }

  /* ------------------------------------------------------------------ login */

  if (url.pathname === "/login" && req.method === "GET") {
    return send(
      res,
      200,
      page(
        t,
        `<form method="post" action="/login${q}">
           <label>${escape(t.username)}<input name="username" data-testid="username" autocomplete="username"></label>
           <label>${escape(t.password)}<input name="password" type="password" data-testid="password" autocomplete="current-password"></label>
           <button type="submit" data-testid="submit">${escape(t.login)}</button>
         </form>`,
        { locale },
      ),
    );
  }

  if (url.pathname === "/login" && req.method === "POST") {
    const body = await readBody(req);
    const found = users.get(body.get("username") ?? "");

    if (!found || found.password !== body.get("password")) {
      return send(
        res,
        401,
        page(t, `<p class="error" data-testid="error">${escape(t.bad)}</p><p><a href="/login${q}">${escape(t.login)}</a></p>`, { locale }),
      );
    }

    const sid = randomUUID();
    sessions.set(sid, found.username);
    // BUG 1 (security): the session cookie is missing HttpOnly, so any injected
    // script can read it.
    return redirect(res, `/notes${q}`, { "set-cookie": `sid=${sid}; Path=/; SameSite=Lax` });
  }

  if (url.pathname === "/logout") {
    const sid = cookies(req).sid;
    if (sid) sessions.delete(sid);
    return redirect(res, `/login${q}`, { "set-cookie": "sid=; Path=/; Max-Age=0" });
  }

  /* ------------------------------------------------------------------ notes */

  if (url.pathname === "/notes" && req.method === "GET") {
    if (!user) return redirect(res, `/login${q}`);

    const visible = notes.filter((n) => n.owner === user.username || user.role === "admin");
    return send(
      res,
      200,
      page(
        t,
        `<form method="post" action="/notes${q}">
           <label>${escape(t.add)}<input name="title" data-testid="note-title"></label>
           <button type="submit" data-testid="note-submit">${escape(t.add)}</button>
         </form>
         <ul data-testid="notes">
           ${
             visible.length
               ? visible
                   // BUG 2 (XSS): note titles are interpolated unescaped.
                   .map((n) => `<li data-testid="note">${n.title}</li>`)
                   .join("")
               : `<li data-testid="empty">${escape(t.empty)}</li>`
           }
         </ul>`,
        { user, locale },
      ),
    );
  }

  if (url.pathname === "/notes" && req.method === "POST") {
    if (!user) return redirect(res, `/login${q}`);
    const body = await readBody(req);
    const title = (body.get("title") ?? "").trim();

    // BUG 3 (validation): an empty title is accepted and creates a blank row.
    notes.push({ id: String(nextId++), title, owner: user.username });
    return redirect(res, `/notes${q}`);
  }

  /* ------------------------------------------------------------------ admin */

  if (url.pathname === "/admin") {
    if (!user) return redirect(res, `/login${q}`);

    // BUG 6 (RBAC): the role check is on the RENDERED CONTENT only. A non-admin
    // gets 200 and the page frame, when the route should refuse outright.
    const rows =
      user.role === "admin"
        ? notes.map((n) => `<li data-testid="admin-note">${escape(n.title)} - ${escape(n.owner)}</li>`).join("")
        : `<li class="error" data-testid="denied">${escape(t.denied)}</li>`;

    return send(res, 200, page(t, `<ul data-testid="admin-notes">${rows}</ul>`, { user, locale }));
  }

  send(res, 404, page(t, "<p>Not found.</p>", { user, locale }));
});

server.listen(PORT, () => {
  console.log(`demo-app listening on http://localhost:${PORT}`);
});

/** Reset between benchmark runs without restarting the process. */
function reset() {
  notes = seed.notes.map((n, i) => ({ id: String(i + 1), ...n }));
  nextId = notes.length + 1;
  sessions.clear();
}
