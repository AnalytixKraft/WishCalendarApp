/* The frame every page sits in, the calendar leaf, and the pages shown
 * before signing in (or when something is wrong). */

import { MONTHS, WEEKDAYS, ageOn, formatDayMonth, weekdayOf, zonedNow } from "../dates.mjs";
import { KIND_ICON } from "../messages.mjs";
import { html, raw } from "./html.mjs";

/* What the app is called on its pages. (Inside, it keeps its first name —
 * the Docker project, the volumes, the cookie — so a rename loses nothing.) */
export const APP_NAME = "Wish Calendar";

export const iconOf = (kind) => KIND_ICON[kind] ?? KIND_ICON.birthday;
export const occasionWord = (kind) => (kind === "anniversary" ? "anniversary" : "birthday");

/* The linked number, as +<digits>, from WhatsApp's `me`. */
export const phoneOf = (me) => (me?.id ? `+${me.id.split("@")[0].split(":")[0]}` : "");

/* "12:21", or "30 Sep, 12:21" — in the app's time zone, spelled the way the
 * rest of the app spells dates. */
export function clockTime(iso, timeZone, withDate = false) {
  const t = zonedNow(new Date(iso), timeZone);
  const time = `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
  return withDate ? `${formatDayMonth(t)}, ${time}` : time;
}

/* ------------------------------------------------------------------ frame */

const NAV = [
  ["today", "/", "Today"],
  ["calendar", "/calendar", "Calendar"],
  ["notes", "/notes", "Notes"],
  ["people", "/people", "People"],
  ["settings", "/settings", "Settings"],
];

export function layout({ title, active = null, body, flash = null, signedIn = true, wide = false, assets }) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title} · ${APP_NAME}</title>
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${assets.css}">
<script src="${assets.js}" defer></script>
</head>
<body>
${signedIn
  ? html`<header class="masthead">
  <a class="brand" href="/"><span class="brand__mark" aria-hidden="true"></span>${APP_NAME}</a>
  <nav class="nav" aria-label="Main">
    ${NAV.map(([key, href, label]) => html`<a href="${href}"${key === active ? raw(' aria-current="page"') : ""}>${label}</a>`)}
  </nav>
  <form method="post" action="/logout" class="masthead__signout"><button type="submit" class="linkish">Sign out</button></form>
</header>`
  : ""}
<main class="page${signedIn ? "" : " page--bare"}${wide ? " page--wide" : ""}">
${flash ? html`<div class="flash flash--${flash.type}" role="${flash.type === "error" ? "alert" : "status"}">${flash.text}</div>` : ""}
${body}
</main>
</body>
</html>`;
}

/* ------------------------------------------------------------- the leaf */

/* A page of a tear-off wall calendar: the day's numeral (red on Sundays, as
 * printed calendars do), and the names written on it in pen. `heading` is
 * the level its (visually hidden) title takes in the page's outline. */
export function leaf({ date, size, people = [], caption = null, heading = "h3" }) {
  const weekday = WEEKDAYS[weekdayOf(date)];
  const sunday = weekdayOf(date) === 0;
  const names = people.map((p) => ({ name: p.name, kind: p.kind, years: ageOn(p, date) }));
  const title = `${weekday} ${date.day} ${MONTHS[date.month - 1]}${caption ? `, ${caption}` : ""}`;
  return html`<article class="leaf leaf--${size}${sunday ? " leaf--sunday" : ""}">
  <div class="leaf__binding" aria-hidden="true"></div>
  <div class="leaf__paper">
    ${raw(`<${heading} class="visually-hidden">`)}${title}${raw(`</${heading}>`)}
    <p class="leaf__month" aria-hidden="true">${size === "large" ? `${MONTHS[date.month - 1]} ${date.year}` : MONTHS[date.month - 1].slice(0, 3)}</p>
    <p class="leaf__day" aria-hidden="true">${date.day}</p>
    <p class="leaf__weekday" aria-hidden="true">${size === "large" ? weekday : weekday.slice(0, 3)}</p>
    ${names.length
      ? html`<ul class="leaf__names">${names.map(
          (n) => html`<li><span aria-hidden="true">${iconOf(n.kind)}</span> ${n.name}${n.years ? html` <span class="leaf__age">(${n.kind === "anniversary" ? `${n.years} yrs` : n.years})</span>` : ""}<span class="visually-hidden">, ${occasionWord(n.kind)}</span></li>`,
        )}</ul>`
      : size === "large"
        ? html`<p class="leaf__blank">No birthdays or anniversaries today</p>`
        : ""}
  </div>
</article>`;
}

/* --------------------------------------------------------- sign in, setup */

export function signInPage({ today, error, assets }) {
  return layout({
    title: "Sign in",
    signedIn: false,
    assets,
    body: html`<div class="signin">
  ${leaf({ date: today, size: "small", heading: "p" })}
  <form method="post" action="/login" class="card signin__form">
    <h1>${APP_NAME}</h1>
    <label class="field">
      <span class="field__label">Password</span>
      <input type="password" name="password" autocomplete="current-password" required autofocus>
    </label>
    ${error ? html`<p class="field__error" role="alert">${error}</p>` : ""}
    <button type="submit" class="button">Sign in</button>
    <p class="hint">First time: the password is ADMIN_PASSWORD in the .env file on the computer that runs this app. Forgot a password set in Settings? Run <code>bash scripts/reset-password.sh</code> there.</p>
  </form>
</div>`,
  });
}

export function notConfiguredPage({ problems, assets }) {
  return layout({
    title: "Setup needed",
    signedIn: false,
    assets,
    body: html`<div class="card narrow">
  <h1>Finish the setup</h1>
  <p>This app will not open until these are fixed in the .env file:</p>
  <ul class="problems">${problems.map((p) => html`<li>${p}</li>`)}</ul>
  <p>From the project folder, run <code>bash scripts/setup.sh</code>, then <code>docker compose up -d</code>.</p>
</div>`,
  });
}

export function errorPage({ status, message, assets, signedIn = true }) {
  return layout({
    title: status === 404 ? "Not found" : "Something went wrong",
    assets,
    signedIn,
    body: html`<div class="card narrow"><h1>${status === 404 ? "Not found" : "Something went wrong"}</h1><p>${message}</p><p><a href="/">Back to today</a></p></div>`,
  });
}
