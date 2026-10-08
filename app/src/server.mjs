/* The web app: node:http, server-rendered pages, plain form posts. Every page
 * but sign-in needs the session cookie; every post must come from one of
 * these pages (isSameOrigin). Each area's pages and buttons are in routes/;
 * this is what they share: the assets, the request context, WhatsApp's
 * status and groups, and the sign-in in front of them all. */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COOKIE, MAX_AGE_S, createAuth, createThrottle } from "./auth.mjs";
import {
  HttpError,
  clientAddress,
  describeError,
  isHttps,
  isSameOrigin,
  parseCookies,
  readForm,
  redirect,
  send,
  sendHtml,
  sendJson,
  serializeCookie,
} from "./http.mjs";
import { calendarRoutes } from "./routes/calendar.mjs";
import { notesRoutes } from "./routes/notes.mjs";
import { peopleRoutes } from "./routes/people.mjs";
import { settingsRoutes } from "./routes/settings.mjs";
import { todayRoutes } from "./routes/today.mjs";
import { plural } from "./views/html.mjs";
import { errorPage, notConfiguredPage, signInPage } from "./views/layout.mjs";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const FLASH = "bdr_flash";
const STATIC_TYPES = { css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", svg: "image/svg+xml" };

/* The stylesheet, script and icon, read once and addressed by a hash of
 * their content, so a browser can cache them for good and still never run
 * an old copy after an upgrade. */
async function loadAssets() {
  const files = new Map();
  for (const name of ["style.css", "app.js", "favicon.svg"]) {
    const body = await readFile(join(PUBLIC_DIR, name));
    const hash = createHash("sha256").update(body).digest("hex").slice(0, 12);
    files.set(name, { body, hash, type: STATIC_TYPES[name.split(".").pop()] });
  }
  return {
    files,
    css: `/static/style.css?v=${files.get("style.css").hash}`,
    js: `/static/app.js?v=${files.get("app.js").hash}`,
  };
}

export async function createApp({ config, problems = [], db, bridge, scheduler, log }) {
  const assets = await loadAssets();
  const auth = problems.length ? null : createAuth({ password: config.adminPassword, secret: config.sessionSecret, store: db.password });
  const throttle = createThrottle();

  /* Per request: the cookies, a flash message left by the last redirect, and
   * two ways to answer — render a page (which clears the flash), or go back
   * somewhere with a new one (and any other cookies to set on the way). */
  function context(req, res, url) {
    const cookies = parseCookies(req.headers.cookie);
    let flash = null;
    if (cookies[FLASH]) {
      try {
        const parsed = JSON.parse(Buffer.from(cookies[FLASH], "base64url").toString("utf8"));
        if (["ok", "error", "info"].includes(parsed?.type) && typeof parsed.text === "string") flash = parsed;
      } catch {
        // A mangled flash is no flash.
      }
    }
    const secure = isHttps(req);
    return {
      req,
      res,
      url,
      cookies,
      flash,
      secure,
      page(status, body) {
        sendHtml(res, status, body, cookies[FLASH] ? { "set-cookie": serializeCookie(FLASH, "", { maxAge: 0, secure }) } : {});
      },
      back(location, type = null, text = null, { cookies: extra = [] } = {}) {
        const payload = text ? Buffer.from(JSON.stringify({ type, text })).toString("base64url") : null;
        const setCookie = [...extra, ...(payload ? [serializeCookie(FLASH, payload, { maxAge: 60, secure })] : [])];
        redirect(res, location, setCookie.length ? { "set-cookie": setCookie } : {});
      },
    };
  }

  async function waStatus() {
    try {
      const status = await bridge.status();
      scheduler.noteStatus(status);
      return { status, error: null };
    } catch (err) {
      return { status: null, error: describeError(err) };
    }
  }

  /* The groups "Send to" can choose from: fresh from WhatsApp when it is
   * connected (and remembered), else the ones it listed last time. */
  async function knownGroups() {
    const { status, error } = await waStatus();
    if (status?.state === "open") {
      try {
        const groups = await bridge.groups();
        db.chats.remember(groups);
        return { groups: groups.map((g) => ({ id: g.id, subject: g.subject || "Unnamed group" })), note: null };
      } catch (err) {
        return { groups: db.chats.all(), note: `${describeError(err)} These are the groups it listed before.` };
      }
    }
    const groups = db.chats.all();
    const why = error || "WhatsApp is not connected";
    return {
      groups,
      note: groups.length
        ? `${why.replace(/\.$/, "")} — the groups below are the ones it listed before.`
        : `${why.replace(/\.$/, "")}, so its groups cannot be listed yet. Link it in Settings.`,
    };
  }

  /* ------------------------------------------------------------ handlers */

  async function login(ctx) {
    const { req, res } = ctx;
    const address = clientAddress(req);
    const today = scheduler.today().date;
    const wait = throttle.waitMinutes(address);
    if (wait) {
      return ctx.page(429, signInPage({ today, error: `Too many wrong passwords. Try again in ${plural(wait, "minute")}.`, assets }));
    }
    const form = await readForm(req, 10_000);
    if (!auth.checkPassword(form.raw("password"))) {
      throttle.fail(address);
      log.warn({ address }, "wrong password");
      return ctx.page(401, signInPage({ today, error: "That is not the password.", assets }));
    }
    throttle.reset(address);
    log.info({ address }, "signed in");
    redirect(res, "/", { "set-cookie": serializeCookie(COOKIE, auth.issue(), { maxAge: MAX_AGE_S, secure: isHttps(req) }) });
  }

  const shared = { db, bridge, scheduler, log, assets, auth, throttle, waStatus, knownGroups };
  const routes = [...todayRoutes(shared), ...calendarRoutes(shared), ...notesRoutes(shared), ...peopleRoutes(shared), ...settingsRoutes(shared)];

  function serveStatic(res, name, url) {
    const file = assets.files.get(name);
    if (!file) return send(res, 404, "Not found", { "content-type": "text/plain; charset=utf-8" });
    const cache = url.searchParams.get("v") === file.hash ? "public, max-age=31536000, immutable" : "no-cache";
    send(res, 200, file.body, { "content-type": file.type, "cache-control": cache });
  }

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url || "/", "http://app");
    } catch {
      return send(res, 400, "Bad request", { "content-type": "text/plain; charset=utf-8" });
    }
    const path = url.pathname;
    if (path === "/healthz") return sendJson(res, 200, { ok: true });
    if (path.startsWith("/static/")) return serveStatic(res, path.slice("/static/".length), url);
    if (problems.length) return sendHtml(res, 503, notConfiguredPage({ problems, assets }));

    const ctx = context(req, res, url);
    if (req.method === "POST" && !isSameOrigin(req)) {
      return ctx.page(403, errorPage({ status: 403, message: "That form was sent from another site, so it was not accepted.", assets, signedIn: false }));
    }
    const signedIn = auth.verify(ctx.cookies[COOKIE]);
    if (path === "/login") {
      if (req.method === "POST") return login(ctx);
      if (signedIn) return redirect(res, "/");
      return ctx.page(200, signInPage({ today: scheduler.today().date, assets }));
    }
    if (path === "/logout" && req.method === "POST") {
      return redirect(res, "/login", { "set-cookie": serializeCookie(COOKIE, "", { maxAge: 0, secure: isHttps(req) }) });
    }
    if (!signedIn) {
      if (req.method === "GET" && !/\.(json|svg)$/.test(path)) return redirect(res, "/login");
      return send(res, 401, "Sign in first.", { "content-type": "text/plain; charset=utf-8" });
    }
    const method = req.method === "HEAD" ? "GET" : req.method;
    for (const [routeMethod, pattern, handler] of routes) {
      const match = pattern.exec(path);
      if (match && routeMethod === method) return handler(ctx, match);
    }
    ctx.page(404, errorPage({ status: 404, message: "There is no page at this address.", assets }));
  }

  return createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) {
        return sendHtml(res, err.status, errorPage({ status: err.status, message: err.message, assets }));
      }
      log.error({ err: err?.stack || String(err), method: req.method, path: req.url }, "request failed");
      sendHtml(
        res,
        500,
        errorPage({ status: 500, message: "The app hit an unexpected error. Its log says more: docker compose logs app.", assets }),
      );
    }
  });
}
