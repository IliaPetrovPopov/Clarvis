/**
 * Ambient wireframe scene behind the hero.
 *
 * Hand-rolled 3D projection on a 2D canvas rather than a WebGL library: the
 * whole scene is a sphere, orbit rings and some tracked nodes, so pulling in
 * three.js would add hundreds of kilobytes to a marketing page for geometry
 * that fits in a couple hundred lines. Everything here is decorative and the
 * canvas is `aria-hidden`.
 *
 * Two things matter for it not looking cheap:
 *
 * 1. Depth is resolved PER SEGMENT, not per line. Shading a whole latitude ring
 *    with one alpha makes the sphere read as a flat doily; shading each little
 *    segment by its own depth is what gives it volume. Segments are bucketed by
 *    alpha so this still costs a handful of strokes per frame rather than one
 *    per segment.
 *
 * 2. The scan is part of the globe, not a shape drawn on top of it. An earlier
 *    version painted a fixed-width rectangle across the canvas, which clipped
 *    partway across the screen and read as exactly what it was. Now a latitude
 *    band sweeps the sphere and brightens the wireframe it passes through, so
 *    there are no edges to notice.
 */

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const CYAN = "34, 217, 255";
const LAT = 18;
const LON = 34;
const ALPHA_BUCKETS = 14;

function rotate(p: Vec3, ry: number, rx: number): Vec3 {
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);

  const x1 = p.x * cy - p.z * sy;
  const z1 = p.x * sy + p.z * cy;

  return {
    x: x1,
    y: p.y * cx - z1 * sx,
    z: p.y * sx + z1 * cx,
  };
}

/** Sphere as a shared vertex list plus edge indices, so each vertex transforms once. */
function buildSphere() {
  const verts: Vec3[] = [];
  const idx = (i: number, j: number) => i * LON + (j % LON);

  for (let i = 0; i <= LAT; i++) {
    const phi = (i / LAT) * Math.PI;
    for (let j = 0; j < LON; j++) {
      const theta = (j / LON) * Math.PI * 2;
      verts.push({
        x: Math.sin(phi) * Math.cos(theta),
        y: Math.cos(phi),
        z: Math.sin(phi) * Math.sin(theta),
      });
    }
  }

  const edges: Array<[number, number]> = [];
  for (let i = 1; i < LAT; i++) {
    for (let j = 0; j < LON; j++) edges.push([idx(i, j), idx(i, j + 1)]);
  }
  for (let i = 0; i < LAT; i++) {
    for (let j = 0; j < LON; j++) edges.push([idx(i, j), idx(i + 1, j)]);
  }

  return { verts, edges };
}

function buildRing(radius: number, tilt: number, segments = 128): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const x = radius * Math.cos(a);
    const z = radius * Math.sin(a);
    pts.push({ x, y: z * Math.sin(tilt), z: z * Math.cos(tilt) });
  }
  return pts;
}

export function initScene(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return () => {};

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let w = 0;
  let h = 0;
  let baseRadius = 200;

  const { verts, edges } = buildSphere();
  const projected = verts.map(() => ({ x: 0, y: 0, z: 0 }));

  const rings = [
    { pts: buildRing(1.34, 0.4), speed: 0.00034, alpha: 0.16 },
    { pts: buildRing(1.62, -0.58), speed: -0.00022, alpha: 0.11 },
    { pts: buildRing(1.17, 1.12), speed: 0.00048, alpha: 0.08 },
  ];

  // Tracked contacts, spread evenly by a fibonacci spiral rather than randomly
  // so they never clump.
  const NODES = 22;
  const nodes: Vec3[] = Array.from({ length: NODES }, (_, i) => {
    const phi = Math.acos(1 - (2 * (i + 0.5)) / NODES);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    return {
      x: Math.sin(phi) * Math.cos(theta),
      y: Math.cos(phi),
      z: Math.sin(phi) * Math.sin(theta),
    };
  });

  // Precomputed near-neighbour pairs, drawn as faint links between contacts.
  const links: Array<[number, number]> = [];
  for (let i = 0; i < NODES; i++) {
    for (let j = i + 1; j < NODES; j++) {
      const dx = nodes[i].x - nodes[j].x;
      const dy = nodes[i].y - nodes[j].y;
      const dz = nodes[i].z - nodes[j].z;
      if (Math.hypot(dx, dy, dz) < 0.62) links.push([i, j]);
    }
  }

  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  const buckets: Path2D[] = [];
  let scanPath = new Path2D();

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    baseRadius = Math.min(w, h) * (w < 900 ? 0.34 : 0.3);
  }

  function onPointerMove(e: PointerEvent) {
    pointer.tx = (e.clientX / window.innerWidth - 0.5) * 2;
    pointer.ty = (e.clientY / window.innerHeight - 0.5) * 2;
  }

  let raf = 0;
  let t = 0;
  let running = true;

  function draw() {
    ctx!.clearRect(0, 0, w, h);

    pointer.x += (pointer.tx - pointer.x) * 0.04;
    pointer.y += (pointer.ty - pointer.y) * 0.04;

    const ry = t * 0.00019 + pointer.x * 0.4;
    const rx = Math.sin(t * 0.00012) * 0.2 + pointer.y * 0.26;
    const fov = 640;

    // Sits right of centre so the headline column stays on clean background.
    const cx = w / 2 + (w < 900 ? 0 : w * 0.24);
    const cy = h / 2 + (w < 900 ? -h * 0.06 : 0);

    // Scan travels along the sphere's own axis, so it reads as a latitude band
    // sweeping pole to pole regardless of how the globe is turned.
    const scanY = Math.sin(t * 0.00035);
    const SCAN_WIDTH = 0.26;

    const toScreen = (p: Vec3) => {
      const r = rotate(p, ry, rx);
      const depth = fov / (fov + r.z * baseRadius);
      return {
        x: cx + r.x * baseRadius * depth,
        y: cy + r.y * baseRadius * depth,
        z: r.z,
      };
    };

    /* --- atmosphere: a soft limb glow so the sphere sits in space --------- */
    const glow = ctx!.createRadialGradient(cx, cy, baseRadius * 0.55, cx, cy, baseRadius * 1.5);
    glow.addColorStop(0, `rgba(${CYAN}, 0.055)`);
    glow.addColorStop(0.62, `rgba(${CYAN}, 0.028)`);
    glow.addColorStop(1, `rgba(${CYAN}, 0)`);
    ctx!.fillStyle = glow;
    ctx!.beginPath();
    ctx!.arc(cx, cy, baseRadius * 1.5, 0, Math.PI * 2);
    ctx!.fill();

    /* --- transform every vertex once ------------------------------------- */
    for (let i = 0; i < verts.length; i++) {
      const s = toScreen(verts[i]);
      projected[i].x = s.x;
      projected[i].y = s.y;
      projected[i].z = s.z;
    }

    /* --- wireframe, bucketed by per-segment depth ------------------------ */
    for (let b = 0; b < ALPHA_BUCKETS; b++) buckets[b] = new Path2D();
    scanPath = new Path2D();

    for (const [a, b] of edges) {
      const pa = projected[a];
      const pb = projected[b];

      // Depth of this segment's midpoint: -1 is nearest, +1 furthest.
      const mz = (pa.z + pb.z) / 2;
      // Front segments bright, back segments barely there.
      const facing = (1 - mz) / 2;
      const depthAlpha = 0.02 + Math.pow(facing, 2.6) * 0.38;

      // Model-space latitude of the segment, for the scan band.
      const my = (verts[a].y + verts[b].y) / 2;
      // Every meridian converges at the poles, so an untapered scan lights a
      // dense knot of segments there and reads as a bright blob. Fading the
      // band out as it approaches either pole keeps the sweep even.
      const poleTaper = 1 - Math.pow(Math.abs(my), 3);
      const near = (1 - Math.min(Math.abs(my - scanY) / SCAN_WIDTH, 1)) * poleTaper;

      if (near > 0.08 && facing > 0.35) {
        scanPath.moveTo(pa.x, pa.y);
        scanPath.lineTo(pb.x, pb.y);
        continue;
      }

      const bucket = Math.min(ALPHA_BUCKETS - 1, Math.floor((depthAlpha / 0.52) * ALPHA_BUCKETS));
      buckets[bucket].moveTo(pa.x, pa.y);
      buckets[bucket].lineTo(pb.x, pb.y);
    }

    ctx!.lineWidth = 1;
    for (let b = 0; b < ALPHA_BUCKETS; b++) {
      const alpha = 0.02 + (b / (ALPHA_BUCKETS - 1)) * 0.38;
      ctx!.strokeStyle = `rgba(${CYAN}, ${alpha.toFixed(3)})`;
      ctx!.stroke(buckets[b]);
    }

    /* --- the scanned band, lit from inside the wireframe ------------------ */
    ctx!.save();
    ctx!.shadowColor = `rgba(${CYAN}, 0.8)`;
    ctx!.shadowBlur = 9;
    ctx!.strokeStyle = `rgba(150, 240, 255, 0.52)`;
    ctx!.lineWidth = 1.05;
    ctx!.stroke(scanPath);
    ctx!.restore();

    /* --- links between tracked contacts ---------------------------------- */
    ctx!.strokeStyle = `rgba(${CYAN}, 0.09)`;
    ctx!.lineWidth = 1;
    ctx!.beginPath();
    for (const [i, j] of links) {
      const a = toScreen(nodes[i]);
      const b = toScreen(nodes[j]);
      if (a.z > 0.15 || b.z > 0.15) continue; // behind the sphere
      ctx!.moveTo(a.x, a.y);
      ctx!.lineTo(b.x, b.y);
    }
    ctx!.stroke();

    /* --- orbit rings, each with a leading tracer -------------------------- */
    rings.forEach((ring, idx) => {
      const spin = t * ring.speed;
      ctx!.beginPath();
      for (let i = 0; i < ring.pts.length; i++) {
        const s = toScreen(rotate(ring.pts[i], spin, 0));
        if (i === 0) ctx!.moveTo(s.x, s.y);
        else ctx!.lineTo(s.x, s.y);
      }
      ctx!.strokeStyle = `rgba(${CYAN}, ${ring.alpha})`;
      ctx!.lineWidth = 1;
      ctx!.stroke();

      const lead = ring.pts[Math.floor(((t * 0.00022 * (idx + 1)) % 1) * ring.pts.length)];
      const ls = toScreen(rotate(lead, spin, 0));
      ctx!.save();
      ctx!.shadowColor = `rgba(${CYAN}, 1)`;
      ctx!.shadowBlur = 10;
      ctx!.fillStyle = `rgba(180, 245, 255, 0.9)`;
      ctx!.beginPath();
      ctx!.arc(ls.x, ls.y, 1.7, 0, Math.PI * 2);
      ctx!.fill();
      ctx!.restore();
    });

    /* --- tracked contacts ------------------------------------------------- */
    for (let i = 0; i < nodes.length; i++) {
      const s = toScreen(nodes[i]);
      if (s.z > 0.2) continue;

      const pulse = 0.5 + 0.5 * Math.sin(t * 0.0015 + i * 1.7);
      const front = Math.min(1, (0.2 - s.z) / 1.2);
      const lit = 1 - Math.min(Math.abs(nodes[i].y - scanY) / SCAN_WIDTH, 1);

      ctx!.beginPath();
      ctx!.arc(s.x, s.y, 1 + pulse * 1.3, 0, Math.PI * 2);
      ctx!.fillStyle = `rgba(${CYAN}, ${(0.18 + pulse * 0.4) * front + lit * 0.4})`;
      ctx!.fill();

      // A reticle expands out of whichever contacts the scan is crossing.
      if (lit > 0.4) {
        ctx!.beginPath();
        ctx!.arc(s.x, s.y, 4 + (1 - lit) * 10, 0, Math.PI * 2);
        ctx!.strokeStyle = `rgba(150, 240, 255, ${(lit - 0.4) * 0.5})`;
        ctx!.lineWidth = 1;
        ctx!.stroke();
      }
    }

    if (!reduced) t += 16;
    if (running) raf = requestAnimationFrame(draw);
  }

  resize();
  draw();

  // Pause on hidden tabs; an idle marketing page should not burn a core
  // animating something nobody is looking at.
  const onVisibility = () => {
    if (document.hidden && running) {
      running = false;
      cancelAnimationFrame(raf);
    } else if (!document.hidden && !running) {
      running = true;
      draw();
    }
  };

  window.addEventListener("resize", resize, { passive: true });
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    running = false;
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    window.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
