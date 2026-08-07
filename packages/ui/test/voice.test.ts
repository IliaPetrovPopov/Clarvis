import assert from "node:assert/strict";
import test from "node:test";
import { pickVoice, tierOf } from "../src/useVoice.ts";

/**
 * Voice selection.
 *
 * Subtle enough to be worth pinning: it used to name one voice and take it
 * wherever it existed, which meant the oldest voice on the system beat every
 * better one installed beside it. The rules below are the ones that fixed
 * that, and each has a way of quietly coming back.
 */

/** The API shape, reduced to what selection reads. */
const V = (name: string, lang: string, uri?: string) =>
  ({
    name,
    lang,
    voiceURI: uri ?? name,
    localService: true,
    default: false,
  }) as SpeechSynthesisVoice;

/** Enumerated from a real machine with no downloaded voices. */
const STOCK_MAC = [
  V("Samantha", "en-US"),
  V("Albert", "en-US"),
  V("Bad News", "en-US"),
  V("Bubbles", "en-US"),
  V("Cellos", "en-US"),
  V("Daniel", "en-GB"),
  V("Eddy (English (United Kingdom))", "en-GB"),
  V("Flo (English (United Kingdom))", "en-GB"),
  V("Fred", "en-US"),
  V("Jester", "en-US"),
  V("Organ", "en-US"),
  V("Reed (English (United Kingdom))", "en-GB"),
  V("Rishi", "en-IN"),
  V("Rocko (English (United Kingdom))", "en-GB"),
  V("Trinoids", "en-US"),
  V("Whisper", "en-US"),
];

test("a modern voice beats the legacy one that used to be hardcoded", () => {
  const picked = pickVoice(STOCK_MAC);
  assert.equal(tierOf(picked), "modern");
  assert.notEqual(picked?.name, "Daniel", "Daniel is concatenative and cannot be made to sound human");
});

test("quality wins over accent", () => {
  // A premium voice in the wrong accent still beats a legacy one in the right
  // accent: neural synthesis is a different technology, not a refinement.
  const withPremium = [...STOCK_MAC, V("Ava (Premium)", "en-US", "com.apple.voice.premium.en-US.Ava")];
  const picked = pickVoice(withPremium);
  assert.equal(tierOf(picked), "premium");
  assert.equal(picked?.name, "Ava (Premium)");
});

test("premium outranks enhanced outranks neural outranks modern", () => {
  const all = [
    ...STOCK_MAC,
    V("Google UK English Male", "en-GB"),
    V("Oliver (Enhanced)", "en-GB", "com.apple.voice.enhanced.en-GB.Oliver"),
    V("Serena (Premium)", "en-GB", "com.apple.voice.premium.en-GB.Serena"),
  ];
  assert.equal(pickVoice(all)?.name, "Serena (Premium)");

  const noPremium = all.filter((v) => !/premium/i.test(v.name));
  assert.equal(pickVoice(noPremium)?.name, "Oliver (Enhanced)");

  const noApple = noPremium.filter((v) => !/enhanced/i.test(v.name));
  assert.equal(tierOf(pickVoice(noApple)), "neural");
});

test("a novelty voice is never chosen", () => {
  // These are indistinguishable from real voices in the API - same language,
  // same localService flag - so any "first English voice" fallback can land on
  // Trinoids. That is reachable, not theoretical.
  for (const list of [
    [V("Bubbles", "en-US"), V("Trinoids", "en-US"), V("Samantha", "en-US")],
    [V("Bad News", "en-US"), V("Jester", "en-US"), V("Daniel", "en-GB")],
  ]) {
    const picked = pickVoice(list);
    assert.ok(picked, "something must be chosen");
    assert.ok(
      !/Bubbles|Trinoids|Bad News|Jester/.test(picked.name),
      `picked a novelty voice: ${picked.name}`,
    );
  }
});

test("British is preferred within a tier, never across one", () => {
  const picked = pickVoice([
    V("Reed (English (United States))", "en-US"),
    V("Reed (English (United Kingdom))", "en-GB"),
  ]);
  assert.match(picked!.name, /United Kingdom/);
});

test("the favoured order is intent, not whatever the system listed first", () => {
  // Eddy used to win over Reed purely because it came earlier in the array.
  // Both are the same tier and the same accent, so the tie is broken on
  // register: a briefing read by a characterful voice is worse than one read
  // plainly.
  const picked = pickVoice([
    V("Eddy (English (United Kingdom))", "en-GB"),
    V("Reed (English (United Kingdom))", "en-GB"),
  ]);
  assert.match(picked!.name, /^Reed/);

  const reversed = pickVoice([
    V("Reed (English (United Kingdom))", "en-GB"),
    V("Eddy (English (United Kingdom))", "en-GB"),
  ]);
  assert.match(reversed!.name, /^Reed/, "order in the input must not change the answer");
});

test("nothing English at all still yields a real voice", () => {
  const picked = pickVoice([V("Bubbles", "en-US"), V("Anna", "de-DE")]);
  assert.equal(picked?.name, "Anna");
});
