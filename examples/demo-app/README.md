# demo-app

A small notes app used as a test target for Clarvis.

## Running

    npm run dev

It listens on <http://localhost:4600> and needs no install step.

## Roles

Seeded accounts are in `seed.json`:

| Role   | Username           | Can reach `/admin` |
|--------|--------------------|--------------------|
| admin  | `ada@demo.test`    | yes                |
| viewer | `linus@demo.test`  | no                 |

## Test fixtures

`POST /__reset` clears every note and session back to `seed.json`. It answers
only to loopback. Use it to clean up after a test that creates records.

## Intended behaviour

- A signed-out visitor must be redirected to `/login`.
- A viewer must not be able to reach `/admin`. The route must refuse, not merely
  hide the contents.
- A note title must not be empty. An empty submission must be rejected.
- Note titles are user input and must be escaped before display.
- The session cookie must be `HttpOnly`.
- Arabic (`?lang=ar`) must render right-to-left with no untranslated strings.
- Every control must stay reachable down to a 320px viewport.

This app violates several of the rules above on purpose. See `BUGS.md`.
