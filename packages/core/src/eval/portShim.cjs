"use strict";

/**
 * Move every port an application binds, without touching the application.
 *
 * Running a second copy of a program means every port it listens on collides
 * with the first. Rewriting a boot command handles the port named there, and
 * environment variables handle the ones a project happens to expose - but
 * neither reaches a number hardcoded in a source file, and a real project
 * usually has at least one: a dev server on one port with a websocket, a worker
 * or a metrics endpoint on the next, written directly in the source. No amount
 * of configuration moves those.
 *
 * So this moves them at the only place they all pass through. Every server in
 * Node - http, https, net, ws, Next, Vite, Express - ends at
 * `net.Server.prototype.listen`. Offsetting there catches all of them, in the
 * app and in its dependencies, whatever the port is written in.
 *
 * It is injected with `--require` through NODE_OPTIONS, so it lives entirely in
 * Clarvis's own directory. The project is never modified, never copied, and
 * would behave identically if this file did not exist.
 *
 * Four rules keep it safe:
 *
 *   1. ONLY `listen`. Outbound connections are untouched, so the application
 *      still reaches its real database, its real API, its real everything. A
 *      shim that moved those would silently point the base at the wrong data.
 *   2. Port 0 stays 0. It means "any free port", which is already collision
 *      free and where the caller reads back what it got.
 *   3. A unix socket path is passed through unchanged. It is not a port.
 *   4. Any failure falls through to the original behaviour. A shim that could
 *      break an application would be worse than the problem it solves.
 */

const net = require("node:net");

const OFFSET = Number(process.env.CLARVIS_PORT_OFFSET || 0);
const QUIET = process.env.CLARVIS_PORT_SHIM_QUIET === "1";

if (Number.isFinite(OFFSET) && OFFSET !== 0) {
  const original = net.Server.prototype.listen;

  /** Ports below this are system services the app is unlikely to own. */
  const MIN_PORT = 1024;
  const MAX_PORT = 65535;

  const shift = (port) => {
    const value = Number(port);

    // 0 means "pick any free port" - already collision free, and the caller
    // reads back whatever it was given.
    if (!Number.isInteger(value) || value === 0) return port;
    if (value < MIN_PORT || value > MAX_PORT) return port;

    const moved = value + OFFSET;
    if (moved < MIN_PORT || moved > MAX_PORT) return port;

    if (!QUIET) {
      // On stderr so it cannot corrupt anything parsing stdout.
      process.stderr.write(`[clarvis] listening on ${moved} instead of ${value}\n`);
    }
    return moved;
  };

  net.Server.prototype.listen = function listen(...args) {
    try {
      // listen(options[, callback])
      if (args.length && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) {
        const options = args[0];
        // A unix socket path is not a port.
        if (options.path === undefined && options.port !== undefined) {
          args[0] = { ...options, port: shift(options.port) };
        }
        return original.apply(this, args);
      }

      // listen(port[, host][, backlog][, callback]) - including a numeric string,
      // which is what an env var always is.
      if (args.length && (typeof args[0] === "number" || /^\d+$/.test(String(args[0] ?? "")))) {
        args[0] = shift(args[0]);
      }

      return original.apply(this, args);
    } catch (error) {
      // Never let this be the reason an application fails to start.
      if (!QUIET) {
        process.stderr.write(`[clarvis] port shim skipped: ${error && error.message}\n`);
      }
      return original.apply(this, args);
    }
  };
}
