/* Today: the day's leaf, what goes out today and how it went, and what is
 * coming up. */

import { STATE_LABELS } from "../bridge.mjs";
import { alertSummary } from "../messages.mjs";
import { html, plural } from "./html.mjs";
import { clockTime, iconOf, layout, leaf, phoneOf } from "./layout.mjs";
import { yourDayCard } from "./calendar.mjs";
import { journalCard } from "./notes.mjs";

function waSummary(wa) {
  if (wa.error) return html`<p class="status"><span class="dot dot--bad" aria-hidden="true"></span><span class="status__text">${wa.error}</span></p>`;
  const s = wa.status;
  if (s.state === "open") {
    return html`<p class="status"><span class="dot dot--ok" aria-hidden="true"></span><span class="status__text">Connected as <strong>${s.me?.name || phoneOf(s.me)}</strong>${s.me?.name ? html` <span class="muted">${phoneOf(s.me)}</span>` : ""}</span></p>`;
  }
  return html`<p class="status"><span class="dot dot--bad" aria-hidden="true"></span><span class="status__text">Not connected — ${STATE_LABELS[s.state] || s.state}. <a href="/settings#whatsapp">${s.state === "idle" ? "Link a phone" : "See Settings"}</a></span></p>`;
}

function deliveryLine(job, timeZone) {
  if (!job.to) {
    return html`<span class="tick tick--failed" aria-hidden="true">!</span><span>Won’t be sent — no “Send to” chosen. <a href="/people/${job.person.id}">Choose one</a></span>`;
  }
  const d = job.delivery;
  if (d?.status === "sent") return html`<span class="tick tick--sent" aria-hidden="true">✓</span><span>Sent at ${clockTime(d.updated_at, timeZone)}</span>`;
  if (d?.status === "sending") return html`<span class="tick tick--sending" aria-hidden="true">…</span><span>Sending</span>`;
  if (d?.status === "failed") {
    return html`<span class="tick tick--failed" aria-hidden="true">✕</span><span>Not sent (${plural(d.attempts, "try", "tries")}): ${d.error}</span>`;
  }
  return html`<span class="tick tick--due" aria-hidden="true">◷</span><span>${job.due ? "Due now" : `Goes out at ${job.time}`}</span>`;
}

function jobTitle(job) {
  const to = (label) => html` <span class="arrow" aria-hidden="true">→</span><span class="visually-hidden">, to</span> ${label}`;
  switch (job.kind) {
    case "wish":
      return html`<span aria-hidden="true">${iconOf(job.person.kind)}</span> Wish for <strong>${job.person.name}</strong>${job.to ? to(job.to.label) : ""}`;
    case "agenda":
      return html`<span aria-hidden="true">🗓️</span> Your day${to(job.to.label)}`;
    case "event":
      return html`<span aria-hidden="true">⏰</span> Reminder: <strong>${job.title}</strong>${to(job.to.label)}`;
    default:
      return html`Your reminder${to(job.to.label)}`;
  }
}

/* What a row of Recent messages was. */
function recentTitle(d) {
  switch (d.kind) {
    case "wish":
      return `Wish for ${d.person_name}`;
    case "reminder":
      return "Your reminder";
    case "alert":
      return `Alert: ${alertSummary(d.text)}`;
    case "agenda":
      return "Your day";
    case "event":
      return `Reminder: ${d.title ?? "an event"}`;
    default:
      return `Preview of ${d.person_name ?? "a wish"}`;
  }
}

function recentResult(d) {
  switch (d.status) {
    case "sent":
      return html`<span class="tick tick--sent" aria-hidden="true">✓</span> Sent`;
    case "sending":
      return html`<span class="tick tick--sending" aria-hidden="true">…</span> Sending`;
    case "pending":
      return html`<span class="tick tick--due" aria-hidden="true">◷</span> Waiting to be sent`;
    default:
      return html`<span class="tick tick--failed" aria-hidden="true">✕</span> ${d.error}`;
  }
}

export function todayPage({ today, settings, reminderLabel, alertLabel, wa, agenda, upcoming, recent, last, counts, journal, yourDay, assets, flash }) {
  const todays = upcoming.filter((u) => u.inDays === 0).map((u) => u.person);
  const later = new Map();
  for (const u of upcoming.filter((u) => u.inDays > 0)) {
    const key = u.inDays;
    if (!later.has(key)) later.set(key, { date: u.date, inDays: u.inDays, people: [] });
    later.get(key).people.push(u.person);
  }

  const setupSteps = [
    [wa.status?.state === "open", html`<a href="/settings#whatsapp">Link the WhatsApp number</a> that will send the messages`],
    [counts.people > 0, html`<a href="/people/import">Upload your list</a>, or <a href="/people/new">add people</a> one by one`],
    [
      counts.people > 0 && counts.unassigned === 0,
      html`<a href="/people">Choose where each wish goes</a>${counts.people && counts.unassigned ? ` — ${plural(counts.unassigned, "person has", "people have")} no “Send to” yet` : ""}`,
    ],
    [settings.enabled, html`<a href="/settings">Turn sending on</a>, and choose where your reminder goes`],
  ];
  const setupDone = setupSteps.every(([done]) => done);

  return layout({
    title: "Today",
    active: "today",
    assets,
    flash,
    body: html`<h1 class="visually-hidden">Today</h1>
<div class="today">
  <section class="today__leaf" aria-label="Today’s birthdays and anniversaries">
    ${leaf({ date: today, size: "large", people: todays, heading: "h2" })}
  </section>

  <div class="today__side">
    ${setupDone
      ? ""
      : html`<section class="card setup">
      <h2>Getting started</h2>
      <ol class="setup__steps">
        ${setupSteps.map(([done, text]) => html`<li class="${done ? "is-done" : ""}"><span class="setup__mark" aria-hidden="true">${done ? "✓" : ""}</span><span>${text}${done ? html`<span class="visually-hidden"> (done)</span>` : ""}</span></li>`)}
      </ol>
    </section>`}

    ${yourDayCard({ date: today, ...yourDay })}

    ${journalCard({ date: today, page: journal })}

    <section class="card">
      <h2 class="eyebrow">WhatsApp</h2>
      ${waSummary(wa)}
      <h2 class="eyebrow">Sending</h2>
      ${settings.enabled
        ? html`<p class="status"><span class="dot dot--ok" aria-hidden="true"></span><span class="status__text">On — wishes at ${settings.wishTime}, ${reminderLabel ? `your reminder at ${settings.reminderTime} to ${reminderLabel}` : "no reminder"}, ${alertLabel ? `alerts to ${alertLabel}` : "no alerts"} <span class="muted">(${settings.timezone})</span></span></p>`
        : html`<p class="status"><span class="dot dot--off" aria-hidden="true"></span><span class="status__text">Paused — nothing goes out on its own. <a href="/settings">Turn sending on</a></span></p>`}
      ${last.waiting ? html`<p class="notice">Messages are waiting: ${last.waiting}</p>` : ""}
      <form method="post" action="/run" class="inline-form" data-confirm="Send every message for today that has not gone out yet, now?">
        <button type="submit" class="button">Send today’s messages now</button>
      </form>
    </section>

    <section class="card">
      <h2>Today’s messages</h2>
      ${agenda.length
        ? html`<ul class="jobs">${agenda.map(
            (job) => html`<li class="job job--${!job.to ? "failed" : job.delivery?.status || "due"}">
          <p class="job__title">${jobTitle(job)}</p>
          <p class="job__state">${deliveryLine(job, settings.timezone)}</p>
          ${job.to && job.delivery?.status === "failed"
            ? html`<form method="post" action="/retry" class="inline-form"><input type="hidden" name="key" value="${job.key}"><button type="submit" class="button button--small button--quiet">Retry now</button></form>`
            : ""}
        </li>`,
          )}</ul>`
        : html`<p class="empty">Nothing to send today — no birthdays, and nothing on the calendar${reminderLabel ? " or for the reminder to mention" : ""}.</p>`}
    </section>
  </div>
</div>

<section class="upcoming" aria-labelledby="upcoming-title">
  <h2 id="upcoming-title">Coming up <span class="muted">· next 30 days</span></h2>
  ${later.size
    ? html`<ol class="leaves">${[...later.values()].map((d) => {
        const when = d.inDays === 1 ? "Tomorrow" : `In ${d.inDays} days`;
        return html`<li>${leaf({ date: d.date, size: "small", people: d.people, caption: when })}<p class="leaves__when" aria-hidden="true">${when}</p></li>`;
      })}</ol>`
    : html`<p class="empty">No birthdays in the next 30 days.${counts.people === 0 ? html` <a href="/people/import">Upload your list</a>` : ""}</p>`}
</section>

<section class="card">
  <h2>Recent messages</h2>
  ${recent.length
    ? html`<div class="table-wrap"><table class="table">
    <thead><tr><th scope="col">When</th><th scope="col">Message</th><th scope="col">To</th><th scope="col">Result</th></tr></thead>
    <tbody>${recent.map(
      (d) => html`<tr>
      <td class="nowrap">${clockTime(d.updated_at, settings.timezone, true)}</td>
      <td>${recentTitle(d)}</td>
      <td>${d.chat_subject || "—"}</td>
      <td>${recentResult(d)}</td>
    </tr>`,
    )}</tbody>
  </table></div>`
    : html`<p class="empty">Nothing sent yet.</p>`}
</section>`,
  });
}
