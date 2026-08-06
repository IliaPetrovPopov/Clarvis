import "./styles.css";
import { initScene } from "./scene";

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

/* ------------------------------------------------------------------ scene */

const canvas = document.getElementById("scene");
if (canvas instanceof HTMLCanvasElement) initScene(canvas);

/* ------------------------------------------------- hero power-on sequence */

// Stagger indices are assigned here rather than in markup so the cascade order
// follows document order automatically as sections are edited.
document.querySelectorAll<HTMLElement>("[data-boot]").forEach((el, i) => {
  el.style.setProperty("--b", String(i));
});
requestAnimationFrame(() => document.body.classList.add("booted"));

/* ----------------------------------------------------------- scroll reveal */

const revealables = document.querySelectorAll<HTMLElement>("[data-reveal]");

// Fail visible, not blank: with no observer support, or with motion reduced,
// everything shows immediately rather than being left at opacity 0.
if (reduced || !("IntersectionObserver" in window)) {
  revealables.forEach((el) => el.classList.add("is-in"));
} else {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        io.unobserve(entry.target); // reveal once, never re-animate on scroll-back
      }
    },
    { rootMargin: "0px 0px -12% 0px", threshold: 0.12 },
  );
  revealables.forEach((el) => io.observe(el));
}

/* ------------------------------------------- nav backdrop and mobile menu */

const nav = document.getElementById("nav");
const navToggle = document.getElementById("navToggle");
const navLinks = document.getElementById("navLinks");

function closeMenu() {
  document.body.classList.remove("nav-open");
  navToggle?.setAttribute("aria-expanded", "false");
  navToggle?.setAttribute("aria-label", "Open menu");
}

navToggle?.addEventListener("click", () => {
  const open = document.body.classList.toggle("nav-open");
  navToggle.setAttribute("aria-expanded", String(open));
  navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
});

// Any in-page jump should dismiss the overlay, otherwise the target scrolls
// behind a panel that is still covering it.
navLinks?.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("a")) closeMenu();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("nav-open")) {
    closeMenu();
    navToggle?.focus();
  }
});

/* ------------------------------------------------------- telemetry rails */

const railSection = document.getElementById("railSection");
const railFill = document.getElementById("railFill");
const railPct = document.getElementById("railPct");
const sections = Array.from(document.querySelectorAll<HTMLElement>("[data-sec]"));

function syncChrome() {
  if (nav) nav.classList.toggle("is-stuck", window.scrollY > 24);

  const max = document.documentElement.scrollHeight - window.innerHeight;
  const pct = max > 0 ? Math.min(Math.round((window.scrollY / max) * 100), 100) : 0;
  if (railFill) railFill.style.width = `${pct}%`;
  if (railPct) railPct.textContent = String(pct).padStart(3, "0");

  // Whichever section owns the upper third of the viewport is the current one.
  if (railSection) {
    const marker = window.innerHeight * 0.33;
    let current = sections[0];
    for (const s of sections) {
      if (s.getBoundingClientRect().top <= marker) current = s;
    }
    const label = current?.dataset.sec;
    if (label && railSection.textContent !== label) railSection.textContent = label;
  }
}

syncChrome();
window.addEventListener("scroll", syncChrome, { passive: true });
window.addEventListener("resize", syncChrome, { passive: true });

/* --------------------------------------------------------- cursor reticle */

const reticle = document.getElementById("reticle");
if (reticle && finePointer && !reduced) {
  let x = 0;
  let y = 0;
  let tx = 0;
  let ty = 0;
  let raf = 0;

  const loop = () => {
    // Trails slightly behind the pointer so it reads as a tracked lock rather
    // than a second cursor glued to the real one.
    x += (tx - x) * 0.18;
    y += (ty - y) * 0.18;
    reticle.style.transform = `translate(${x}px, ${y}px)`;
    raf = requestAnimationFrame(loop);
  };

  window.addEventListener(
    "pointermove",
    (e) => {
      tx = e.clientX;
      ty = e.clientY;
      if (!raf) {
        reticle.classList.add("is-live");
        raf = requestAnimationFrame(loop);
      }
    },
    { passive: true },
  );

  document.addEventListener("pointerleave", () => reticle.classList.remove("is-live"));
}

/* --------------------------------------------------------- counting stats */

function countUp(el: HTMLElement, to: number, ms = 1100) {
  if (reduced) {
    el.textContent = String(to);
    return;
  }
  const start = performance.now();
  const tick = (now: number) => {
    const p = Math.min((now - start) / ms, 1);
    // Ease-out cubic, so the number settles rather than stopping dead.
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = String(Math.round(to * eased));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const counters = document.querySelectorAll<HTMLElement>(".count");
if ("IntersectionObserver" in window) {
  const co = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        countUp(el, Number(el.dataset.to ?? 0));
        co.unobserve(el);
      }
    },
    { threshold: 0.6 },
  );
  counters.forEach((el) => co.observe(el));
} else {
  counters.forEach((el) => (el.textContent = el.dataset.to ?? "0"));
}

/* ------------------------------------------------------------------- form */

const form = document.querySelector<HTMLFormElement>(".form");
form?.addEventListener("submit", (e) => {
  e.preventDefault();
  const input = form.querySelector<HTMLInputElement>("input[type=email]");
  const status = form.querySelector<HTMLElement>(".form__status");
  if (!input || !status) return;

  const value = input.value.trim();
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);

  if (!valid) {
    status.dataset.error = "true";
    status.textContent = "That email does not look right. Check it and try again.";
    input.focus();
    return;
  }

  // No backend yet. Say so plainly rather than faking a success state - the
  // whole product is about not claiming things that did not happen.
  delete status.dataset.error;
  status.textContent = "Captured locally. Waitlist delivery is not wired up yet.";
  input.value = "";
});
