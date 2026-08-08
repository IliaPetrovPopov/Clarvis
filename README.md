# Clarvis

A team of AI QA agents that inspect a project, then test it in a real browser.

Personal tool. It runs on your machine, drives your own Claude Code login, and
writes everything into the project it is testing.

## The idea

An agent asked to test a feature it cannot reach will still write tests, they
will all pass, and the report will say the feature works. That report is
indistinguishable from a thorough one. Everything below exists to make that
outcome impossible to produce silently.

So the shape of every fleet is the same, and the model sits in the middle of it:

```
code  ->  agent  ->  code
```

Code gathers the evidence, an agent reasons over it, and code checks the result
against something that cannot be argued with. An agent can phrase a requirement,
but it cannot introduce one. It can propose a spec, but it cannot decide the
spec is good enough to run. It can call a finding real, but the pass and fail
counts come from Playwright's JSON reporter, never from an agent's account of
its own work.

## The fleets

| Codename | Key | Produces | |
|---|---|---|---|
| **SCOUT** | `recon` | `profile.json` | mandatory |
| **ARCHIVE** | `research` | `context.json` | optional |
| **FOREMAN** | `lead` | `plan.json` | optional |
| **PROVER** | `qa` | `run.json` | optional |
| **SCRIBE** | `delivery` | `drafts.json` | optional |
| **JUDGE** | `release` | `verdict.json` | optional |

You pick the teams per project, once, from the terminal:

```sh
cd ~/code/my-app
clarvis init
```

That is an interactive checklist. SCOUT is always in; everything else is a
choice, and turning one on pulls in what it reads from. Pass `--fleet` to skip
the prompt and script it.

Fleets you leave out are not silently absent. Every run prints what it lost:

```
DEGRADED PROVER without ARCHIVE (high): No finding can cite a spec or
         acceptance criteria, because nothing gathered them.
```

## Commands

You work from the terminal, inside the repo being tested. The dashboard is
where you look at what came back.

```sh
clarvis init                          # pick the teams for this project
clarvis recon                         # how to boot it, how to log in, what to never touch
clarvis research                      # gather requirements, verify every quote
clarvis run                           # plan, author, gate, run, triage, draft, judge
clarvis smoke [--live]                # run the whole pipeline against the demo app and check it
clarvis benchmark                     # score a run against a known set of seeded bugs
clarvis guard                         # print the safety decision without running anything
clarvis ui --open                     # the dashboard, in a browser
```

Every command takes `--project <dir>`; without it they use the current
directory.

Add `--dry-run` to `recon` or `research` to see exactly what would be sent to a
model, at no cost.

## As a desktop application

```sh
./packages/desktop/build.sh /Applications
```

A native window around the same dashboard. It uses WKWebView - the system
webview - so nothing is bundled and the whole application is about 300KB;
Electron would have been two hundred megabytes for a rendering engine already
installed on the machine.

It owns the server: on launch it starts `clarvis ui` if nothing is answering,
and on quit it stops what it started. A server that was already running is left
alone and left running, because it belongs to whoever started it - most likely
a terminal being watched.

Needs Xcode's command line tools, which is what supplies `swiftc`. The
interpreter path is resolved at build time and baked into the bundle, because
an app launched from the dock inherits almost no PATH and would not otherwise
find a node managed by nvm. Rebuild after moving the repository.

## The code graph (optional)

If `graphify` is installed, `clarvis init` offers to build a code graph for the
project. It is local AST parsing - no model call, no usage against your plan -
and it feeds two things nothing else can supply:

- **SCOUT** fills `risk.hotspots` from the graph's most-connected nodes:
  the places where a change reaches furthest.
- **FOREMAN** gets the blast radius of the changed files. Filenames say what was
  edited; the graph says what depends on it, and "this file is imported by the
  auth middleware" is the signal that moves rbac to the top.

Entirely optional. Without it, ranking falls back to filenames and keywords and
the run says so. Clarvis never runs `graphify label` or semantic extraction -
those call a model, and a setup step should not quietly spend your allowance.

## Where everything is written

**Outside the project. Always.** Running Clarvis against a repository leaves no
mark on it.

```
~/.clarvis/
  projects.json                    the registry: paths, names, team selections
  projects/<name>-<hash>/
    profile.json                   how to boot it, log in, what to never touch
    context.json                   requirements, each traced to a quote
    plan.json                      the lead's ranking and what it deferred
    ledger.json                    what is already known and what was dismissed
    runs/<id>/                     run.json, drafts, verdict, traces, screenshots
    scratch/                       the authored specs
    transcripts/                   one JSONL per agent invocation, redacted
```

The directory name is derived from the project's absolute path, so renaming the
folder keeps its identity and two projects sharing a basename never collide.
Each project's state is entirely separate from every other's.

This used to live in a `.clarvis/` folder inside the repository, which was wrong
in several ways at once: megabytes of Playwright traces in a working tree, a
noisy `git status` in a repo that was clean, a `.gitignore` edit needed to make
it tolerable, and agent transcripts - which contain retrieved text from the
project - one `git add -A` away from being committed.

`CLARVIS_HOME` moves the whole store. The test suite sets it to a temp
directory, so running the tests never touches your real state.

**The one exception is opt-in.** `clarvis run --promote` writes confirmed
findings' specs into the project as regression tests, because that is the point
of them. Nothing else ever writes inside a project.

State is not small - traces dominate, since triage re-runs each failing test
three times in fresh browser processes. Every run prunes to the last 10
(`--keep-runs`).

## Safety

The guard is plain code with no agent in it, and it fails closed at every
branch.

- **Mutating tests need either two independent yeses or a database of our own.**
  The two yeses are `data.disposable === true` AND a `safeTargets` match, and
  neither is ever set by recon - a human sets `disposable`. The alternative is
  provenance: a database Clarvis created for this run, holding nothing but seed
  data, dropped when the run ends. That is stronger evidence than the flag,
  because a flag can be set optimistically by someone who did not check. It
  applies only to a live sandbox object provisioned in this process - never to
  a config value or a name pattern - and it does not weaken anything below.
- **Every reachable target must still be this machine**, sandbox or not. A
  disposable database says nothing about a spec that can reach a real service
  beside it.
- **Nothing is removed without the sandbox marker in its name**, so a bug in
  name derivation destroys nothing. A journal is written before anything is
  created, so a run killed outright is cleaned up by the next one.
- **`forbiddenHosts` beats everything**, including `safeTargets: ["*"]`. The
  list is the union of what the safety agent found and what a static scan found
  in the project's own files, so it is still written when the agent fails.
- **No agent writes a file.** The spec author returns source; code writes it.
  Claude Code grants read and write together per directory, so an agent able to
  write its spec could also edit the app under test - and a tester that can
  modify the system under test invalidates every result it produces.
- **No agent gets a shell or network access.** Connectors are code.
- **A live `.env` is never read.** Templates only.
- **A credential that does not appear verbatim in the project is dropped.**

## The smoke run

`clarvis smoke` runs the entire pipeline against the bundled demo app and then
checks properties of the result that no unit test can see: that every stage
fired, that none took long enough to be a hang, that the record holds what the
dashboard reads, and that something was actually authored rather than a stale
spec being picked up.

It exists because of a pattern rather than a bug. Work kept being called
finished on a passing test suite and a clean typecheck, and the integration
bugs were found later by a person asking whether it worked - warm-up walking
forty-seven routes serially, a progress scale the run could never reach the end
of, tokens computed and discarded. Each was invisible to the tests and obvious
within one real run.

Agents are stubbed by default, so it takes about four seconds and no usage. The
stub returns a real spec that passes the gate and drives a real browser -
anything less would make the check green by never reaching the interesting
part. `--live` calls the real agents, for a change that alters what one is
asked to do.

## When there is no account to test with

Recon looks for credentials in seed files and fixtures. Often that works; on a
real application it frequently does not, and then every route behind a login is
untestable. Provisioning a database made it worse rather than better - a fresh
database is empty, so the sandbox meant to unlock the mutating axes handed the
fleet an application with no users at all.

So the fleet registers one, through the application's own signup form.

Not by writing to the database. A user is not a row: it is a row plus a hash
with the right cost factor, plus a tenant key, plus whatever the application
does on creation. Reading the models and inserting a record means reproducing
every invariant by hand, and getting one wrong produces an account that exists
and cannot do anything - which then fails tests in ways that look like product
defects. The signup form already knows all of it, and it is the one path that
needs no knowledge of the stack.

Creating an account is a write, so the guard decides. The identity carries the
fixture prefix and a random tail, and it is proven by logging in with it
afterwards rather than by the form appearing to submit.

**It goes in a database of our own, not yours.** Provisioning is attempted
whenever a mutating axis is wanted - not only when the guard was about to
refuse, which is what it used to do, and which meant a project marked
`disposable: true` never got a sandbox and had test accounts written into its
real development database instead. Being allowed to write somewhere is not a
reason to write there: consenting to mutating tests against seeded data is not
consenting to permanent test accounts.

Where no sandbox can be made and the guard still permits writes, the run says
`WRITING TO A REAL DATABASE`, records every identifier it created, and closes
the account afterwards through the application's own delete-account flow -
proven by the account no longer being able to log in. What could not be removed
is listed by name, because residue nobody can name is residue nobody removes.

**Signup grants whatever role signup grants**, which is the lowest one. An admin
cannot be made this way, and the run says so rather than guessing at an
elevation route and quietly testing the wrong thing.

## Lessons: the fleet learning from itself

Two signals were being thrown away at the end of every run. The gate refuses a
spec and says exactly what was wrong with it. Triage rules a failure to be the
test's fault rather than the application's, and explains how. Both are the spec
author being corrected, in detail, by something that is not the spec author.

They are kept now, generalised into a sentence, and put in the author's brief
next time. A lesson whose mistake stops recurring is retired, so the brief does
not fill with advice about problems nobody has.

**Agents never edit their own prompts, code, or rules.** An agent that could
rewrite the standard it is judged against would drift towards whatever made its
own output look good, and nothing downstream would notice. It proposes a
sentence; code vets it. Anything that would make the author's job easier at the
cost of the result meaning something is refused outright - skipping a flaky
test, preferring a visibility check to a real assertion, swallowing an error,
touching the guard. The agent does not get a vote on those.

## The spec gate

Every authored spec is statically checked before it is allowed to run. It is
rejected for: no assertions, assertions on literals, a lone `toBeDefined`,
`test.skip`, `test.only`, a swallowed `catch`, any hardcoded host from the
deny-list, and for admitting a gap in a comment while leaving `untested` empty.

A rejected spec is not written. The axis is reported as not run, which is
honest; a green axis that asserted nothing is not.

## What a full run does

1. **FOREMAN** ranks the axes worth running for this change, and says what
   deferring the rest costs. It can reorder and explain; it cannot invent a
   route, resurrect an axis the guard refused, or drop one silently - anything
   it does not plan is listed as deferred, with the cost stated.
2. The application is booted, then **looked at**. Every role logs in once, in
   code, and the session is verified rather than assumed - so no spec writes a
   login flow, which was the most repeated and least reliable code in the
   system. Routes come from the framework's own routing convention; each is
   visited and its accessibility tree captured. Whether a route needs a session
   is observed by trying it anonymously, not inferred from middleware.
3. If a mutating axis was asked for and the guard would otherwise refuse, a
   disposable database is **created** rather than requested: the project's own
   compose service, or a fresh database beside the one already running locally,
   or a container. Whichever works, the result is a database that did not exist
   before the run and is dropped after it - which is stronger evidence than the
   `disposable` flag, because a flag can be set by someone who did not check.
   The application boots pointed at it. Nothing is ever removed unless its name
   carries the sandbox marker, and a journal written before anything is created
   means a killed run is cleaned up by the next one.
4. Under a mutating guard, the project's own seed command runs first: the team's
   model of their data is more faithful than any this tool could construct. The
   database that command would write to is checked separately from the HTTP
   target, because a seed script reads a connection string the guard has never
   seen - and a local app with a shared remote database passes every other check.
5. **PROVER** authors one spec per axis in parallel, against snapshots of the
   real pages rather than source it has to interpret. Each is gated, run, and
   every failure re-run three times in isolation with the fault attributed.
6. **SCRIBE** drafts a ticket for each confirmed finding. It never files
   anything: `decidePublish` refuses unless writes are explicitly enabled, the
   finding is CONFIRMED, a human approved that specific ticket, no duplicate is
   suspected, the project is allow-listed and the per-run cap has room. Refused
   drafts are still written to disk to be read and filed by hand.
7. **JUDGE** decides ship or hold. The verdict is `decideRelease` - plain
   code, not a model, because nobody should be told "ship it" by something that
   might be having an off day. The agent only writes the notes and states the
   limits, and is given the verdict rather than asked for one.

## Differential testing - the previous version as the oracle

```sh
clarvis diff --base main
```

Everything else hinges on finding a written requirement to cite. For
regressions, none of that is needed: run the same specs against the base ref and
against the branch, and a test that passed there and fails here is a regression.
The old version is the oracle.

The base is checked out into a `git worktree` and booted on its own port, so
your working tree is never touched and both versions are up at once. The
classification is what matters:

| base | head | verdict |
|---|---|---|
| pass | fail | **regression** - caused by this change |
| fail | fail | pre-existing - real, but not this branch's doing |
| fail | pass | fixed by this change |

Calling a pre-existing failure a regression sends someone hunting through a diff
that never touched it, so a test that ran on only one side is `inconclusive`
rather than either.

## Memory across runs

```sh
clarvis ledger                                   # what is already known
clarvis ledger dismiss <id> --note "why"         # stop reporting it
clarvis ledger reopen <id>
```

A tester that re-reports a dismissed finding every morning gets ignored inside a
fortnight. Findings carry an identity across runs, keyed on the axis, route and
role - not the title, which is model-authored and drifts.

A dismissed finding is **still found** and reported as `known` rather than
filed. A dismissal needs a stated reason: without one nobody can tell it from a
mistake six months later. And a finding is only called `fixed` when the axis
that would have found it actually ran - absence is not evidence otherwise.

## Promotion - the specs you keep

A spec that caught a real bug is a regression test, and it used to be
overwritten by the next run. Confirmed findings now have their specs promoted
into `tests/clarvis/` with a header saying what they caught and what they are
entitled to claim. An edited file is never silently overwritten.

That is what makes the tool compound: after twenty runs you have twenty real
tests rather than twenty deleted scratch files.

## A taxonomy from your own history

```sh
clarvis taxonomy
```

The seven axes are a generic model of failure, identical for every codebase -
and they are also the system's entire model of what can go wrong, so anything
outside them is never looked for at all. Your project's real failure modes are
in its git log: four hundred commits of things that did break, described by
whoever fixed them.

Each derived axis must cite at least two real commits that were actually
supplied. One occurrence is an incident, not a pattern, and a theme supported by
invented evidence is supported by nothing.

## Tiers

A red test is evidence, not a verdict. `CONFIRMED` needs all three:

1. it reproduces on every isolated re-run,
2. triage places the fault in the application rather than in the spec,
3. something written by a human says the behaviour is wrong.

Miss any one and it stays `PLAUSIBLE`. Only `CONFIRMED` findings can ever be
published to a tracker. This is what makes ARCHIVE load-bearing rather than
optional: with no human-authored source, nothing is publishable.

Tier and severity stay separate in the UI. Tier (confidence) drives prominence;
severity (impact) gets the only colour. A discarded critical recedes; a
confirmed low still reads as solid.

## The benchmark

`examples/demo-app` is a dependency-free notes app with six deliberately seeded
bugs and `bugs.json` as the answer key.

```sh
node examples/demo-app/server.mjs &
clarvis recon --project examples/demo-app
clarvis run   --project examples/demo-app
clarvis benchmark --project examples/demo-app
```

The scorer reports misses first, excludes axes that did not run, and reports
findings that match no seeded bug as **unmatched** rather than as false
positives - the app may hold bugs nobody seeded, and scoring those against the
fleet would train it toward reporting less.

**No detection-rate claim may be made without this.** And the seeded benchmark
alone is weak evidence: the bugs and the axes that look for them were written by
the same person. The commands below exist because of that.

## Measuring the tester, not the bugs

```sh
clarvis mutate    # break the code, see if the specs notice
clarvis history   # mine real bug fixes out of this project's own git log
clarvis measure variance|ablation|calibration
```

**`mutate`** is the number that does not depend on which bugs happen to exist.
It flips a comparison, negates a condition, swaps `&&` for `||` - then runs the
suite and asks whether anything failed. A kill rate is a direct measurement of
the specs, on any codebase, with no answer key to write.

It edits source files in place, so the safety is structural: it refuses outside
a git repository, refuses any file with uncommitted changes, restores in a
`finally`, and re-reads to prove the restore worked. Mutants that never actually
ran are excluded from the rate rather than counted as survivors.

**`history`** mines bug-fix commits from the project's own log. Each one gives a
commit to check out (the parent of the fix) and ground truth written by whoever
fixed it, years before this tool existed. Heuristic, and it says so - a message
saying "fix" is a claim by its author, not a verified defect.

**`measure`** answers what a single run is worth:
- `variance` repeats the same input and reports the spread. The planner defers
  an axis in one run and plans it in the next, so coverage is a random variable
  and every detection number inherits that.
- `ablation` compares runs with a fleet removed, so "ARCHIVE helps" becomes a
  number rather than an assertion. Arms with fewer than 3 runs are flagged as
  indistinguishable from noise.
- `calibration` scores triage against human labels, and separates the two
  mistakes: calling a real bug a test fault deletes it silently, while the
  reverse only wastes a review.

## What a run costs

Nothing, in dollars, if you have no `ANTHROPIC_API_KEY` set. Auth is your Claude
Code login, so a run consumes your plan's usage allowance rather than being
billed to a card.

The figures printed as `usage` are what the same tokens would have cost at API
rates, which is the only number the CLI reports. They are labelled
`$x.xx equivalent` when there is no key to bill, and `--max-usd` is a ceiling on
that same measure. It is still worth watching: a full six-team run over seven
axes is a real amount of usage, not a rounding error.

## What this does not claim

False positives are reducible: repeated cold reproduction, fault attribution and
mandatory oracles do most of that work. **False negatives are not.** A run that
reports nothing is meaningless without coverage, so every run carries an explicit
list of what it did not cover, and that list is rendered next to the verdict.

## Layout

pnpm workspace, TypeScript with no build step (Node 22 `--experimental-strip-types`).

```
packages/core       types, guard, boot, runner, store, agents, connectors
packages/ui         Vite + React dashboard; always fetches run data, never imports it
packages/cli        the clarvis command
examples/demo-app   the benchmark target
schema/*.json       the contract of record
fixtures/           sample profile and run, used for UI dev
```

```sh
pnpm install
pnpm --filter @clarvis/core test    # 361 tests
pnpm -r typecheck
pnpm dev:ui                         # http://localhost:5273
```

`scripts/make-app.sh` builds `~/Applications/Clarvis.app`, which opens the
dashboard in a browser.
