# Answer key

Do not read this file when evaluating a run. It is the ground truth the
benchmark scores against, and a fleet that has read it is measuring nothing.

| # | Axis            | Bug                                                        | Where |
|---|-----------------|------------------------------------------------------------|-------|
| 1 | adversarial     | Session cookie is set without `HttpOnly`                    | `server.mjs` login POST |
| 2 | adversarial     | Note titles are interpolated into HTML unescaped (stored XSS) | `server.mjs` notes GET |
| 3 | happy-path      | An empty note title is accepted and creates a blank row     | `server.mjs` notes POST |
| 4 | i18n-rtl        | The login error is untranslated in Arabic                   | `LOCALES.ar.bad` |
| 5 | responsive-a11y | The header toolbar cannot wrap and overflows below ~380px   | `.toolbar` CSS |
| 6 | rbac-scope      | `/admin` answers 200 to a viewer instead of refusing        | `server.mjs` admin route |

| 7 | i18n-rtl        | Nav links drop `?lang`, so an Arabic user is thrown back to English on every click | `server.mjs` `page()` nav |

Bug 7 was not seeded. It was written by accident and the fleet found it on its
first full run, where it was reported as *unmatched* rather than scored against
the fleet. That is exactly why unmatched findings are never counted as false
positives: the target really can hold bugs nobody put there.

Bug 6 is the interesting one: the page *looks* correct to a human, because the
contents are hidden. Only an assertion on the response - not on what is visible -
catches it. A fleet that reports 1-5 and misses 6 is exactly the failure mode
this benchmark is for.
