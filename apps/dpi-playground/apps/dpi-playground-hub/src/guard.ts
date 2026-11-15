import type { RequestHandler } from "express";

const err = (code: string, message: string) => ({ error: { code, message } });

/**
 * The hub holds every device token and has no login of its own, so it only answers requests
 * whose Host is one it serves (blocks DNS rebinding) from its own origin (blocks CSRF), and
 * only accepts JSON writes (forces a CORS preflight that cross-origin pages cannot pass).
 *
 * None of those three is identity — a non-browser client passes all of them by typing a
 * header. `requiredLogin` adds the missing check, and it is worth being precise about what it
 * buys and what it does not.
 *
 * When the hub sits behind `tailscale serve`, serve injects `Tailscale-User-Login` and
 * overwrites any value the client sent (verified 2026-11-14: a peer's forged
 * `attacker@evil.com` arrived as its real login). That makes the header trustworthy **only**
 * while the port is not directly reachable — a local process can set any identity it likes
 * against the loopback bind. So this gate guards the tailnet boundary, never the machine.
 *
 * It does not make the hub secure against the operator's own devices: every node on a
 * single-user tailnet reports the same login, so all of them pass. It stops *other* tailnet
 * users and shared nodes, which is the day this exists for.
 */
export function guard(allowedHosts: Set<string>, requiredLogin?: string): RequestHandler {
  return (req, res, next) => {
    const host = (req.headers.host ?? "").toLowerCase();
    if (!allowedHosts.has(host))
      return void res.status(421).json(err("invalid", `Unknown Host header: ${host}`));
    if (requiredLogin) {
      const login = String(req.headers["tailscale-user-login"] ?? "").toLowerCase();
      if (login !== requiredLogin)
        return void res
          .status(403)
          .json(
            err(
              "unauthorized",
              login
                ? `Tailnet identity ${login} is not authorized for this hub`
                : "This hub requires a tailnet identity; it must be reached through tailscale serve",
            ),
          );
    }
    const origin = req.headers.origin;
    if (origin) {
      let originHost = "";
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {}
      if (originHost !== host)
        return void res
          .status(403)
          .json(err("unauthorized", "Cross-origin requests are not allowed"));
    }
    if (["POST", "PUT", "PATCH"].includes(req.method) && !req.is("application/json"))
      return void res.status(415).json(err("invalid", "JSON required"));
    next();
  };
}
