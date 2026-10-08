/* Settings: the linked WhatsApp, when and where messages go, and the
 * password. */

import { MAX_PASSWORD, MIN_PASSWORD } from "../auth.mjs";
import { DEFAULT_ANNIVERSARY_TEMPLATE, DEFAULT_TEMPLATE, MAX_TEMPLATE } from "../messages.mjs";
import { html, raw, selectOptions } from "./html.mjs";
import { iconOf, layout, phoneOf } from "./layout.mjs";
import { placeholderHelp, sendToOptions } from "./people.mjs";

/* The linked phone: its state, Link or Unlink, and the QR code while
 * linking (app.js follows it along). */
function whatsappSection({ status, error }) {
  const state = status?.state ?? "unreachable";
  let body;
  if (error) {
    body = html`<p class="status"><span class="dot dot--bad" aria-hidden="true"></span><span class="status__text">${error}</span></p>`;
  } else if (state === "open") {
    body = html`<p class="status"><span class="dot dot--ok" aria-hidden="true"></span><span class="status__text">Connected as <strong>${status.me?.name || phoneOf(status.me)}</strong> <span class="muted">${phoneOf(status.me)}</span></span></p>
<p>Keep that phone on, and open WhatsApp on it at least once every two weeks — otherwise WhatsApp unlinks this computer.</p>
<form method="post" action="/whatsapp/logout" class="inline-form" data-confirm="Unlink this WhatsApp number? Nothing is sent until a phone is linked again.">
  <button type="submit" class="button button--danger">Unlink</button>
</form>`;
  } else if (state === "pairing") {
    body = html`<div class="pairing">
  <figure class="qr">
    ${status.qr ? html`<img src="/whatsapp/qr.svg?t=${encodeURIComponent(status.qr_expires_at || "")}" width="264" height="264" alt="QR code for linking WhatsApp" data-qr>` : html`<div class="qr__wait" data-qr>Asking WhatsApp for a code…</div>`}
  </figure>
  <ol class="steps">
    <li>On the phone with the number to link, open WhatsApp.</li>
    <li>Go to <strong>Settings → Linked devices</strong> and tap <strong>Link a device</strong>.</li>
    <li>Point the phone at this code.</li>
  </ol>
</div>
<p class="hint">The code changes every 20 seconds, and stops after about 3 minutes. This section follows along on its own.</p>`;
  } else if (state === "connecting") {
    body = html`<p class="status"><span class="dot dot--off" aria-hidden="true"></span><span class="status__text">Connecting${status.me ? html` as <strong>${status.me.name || phoneOf(status.me)}</strong>` : ""}…</span></p>
${status.last_error ? html`<p class="notice">${status.last_error}</p>` : ""}
<p class="hint">This section follows along on its own. If it stays here for long, check this computer’s internet connection.</p>
<form method="post" action="/whatsapp/logout" class="inline-form" data-confirm="Unlink this WhatsApp number?"><button type="submit" class="button button--quiet">Unlink</button></form>`;
  } else if (state === "conflict") {
    body = html`<p class="status"><span class="dot dot--bad" aria-hidden="true"></span><span class="status__text">Another WhatsApp Web session took over this link.</span></p>
<p class="notice">${status.last_error}</p>
<form method="post" action="/whatsapp/logout" class="inline-form" data-confirm="Unlink, so you can link the phone again?"><button type="submit" class="button">Unlink</button></form>`;
  } else {
    body = html`<p>Link the WhatsApp number that will send the wishes and your reminder.</p>
<div class="warning">
  <p><strong>Use a spare number, not your personal or business one.</strong> WhatsApp does not allow unofficial apps like this one, and can ban the number that uses one — with every chat on it. Messaging people directly draws more attention than posting in groups.</p>
</div>
${status?.last_error ? html`<p class="notice">${status.last_error}</p>` : ""}
<form method="post" action="/whatsapp/pair" class="inline-form"><button type="submit" class="button">Link a phone</button></form>`;
  }
  return html`<section class="card whatsapp" id="whatsapp" data-wa-state="${state}" aria-labelledby="whatsapp-title">
  <h2 class="settings-title" id="whatsapp-title">WhatsApp</h2>
  ${body}
  <p class="wa-changed notice" hidden>WhatsApp’s state has changed — <a href="/settings#whatsapp">reload</a> to see it (your unsaved settings below would be lost).</p>
</section>`;
}

/* --------------------------------------------------------------- settings */

export function settingsPage({ values, errors = {}, timeZones, groups, wa, assets, flash }) {
  const invalid = (e) => (e ? raw(' aria-invalid="true"') : "");
  const error = (e) => (e ? html`<span class="field__error">${e}</span>` : "");
  return layout({
    title: "Settings",
    active: "settings",
    assets,
    flash,
    body: html`<h1>Settings</h1>
${whatsappSection(wa)}
<form method="post" action="/settings" class="card form" novalidate>
  <h2 class="settings-title">Messages</h2>
  <label class="check check--big"><input type="checkbox" name="enabled" value="1"${values.enabled ? raw(" checked") : ""}> <span><strong>Send wishes and reminders automatically</strong><br><span class="hint">Ticked, each goes out at its time. Unticked, the app pauses: nothing goes out on its own — no wishes, reminders, calendar messages or alerts — until you tick it again. The Send now buttons, and the answers to your 📅 messages, work either way.</span></span></label>

  <fieldset class="settings-group">
    <legend>Wishes</legend>
    <label class="field field--short">
      <span class="field__label">Wishes at</span>
      <input type="time" name="wishTime" value="${values.wishTime}" required${invalid(errors.wishTime)}>
      ${error(errors.wishTime)}
    </label>
    <div class="defaults__pair">
      <label class="field">
        <span class="field__label">${iconOf("birthday")} Default birthday message</span>
        <textarea name="template" rows="5" maxlength="${MAX_TEMPLATE}" placeholder="${DEFAULT_TEMPLATE}">${values.template}</textarea>
        ${error(errors.template)}
      </label>
      <label class="field">
        <span class="field__label">${iconOf("anniversary")} Default anniversary message</span>
        <textarea name="anniversaryTemplate" rows="5" maxlength="${MAX_TEMPLATE}" placeholder="${DEFAULT_ANNIVERSARY_TEMPLATE}">${values.anniversaryTemplate}</textarea>
        ${error(errors.anniversaryTemplate)}
      </label>
    </div>
    <span class="hint">Sent for every row whose own message on the People page is empty. Empty here restores the original.</span>
    ${placeholderHelp()}
  </fieldset>

  <fieldset class="settings-group">
    <legend>Your reminder</legend>
    <div class="field-row">
      <label class="field">
        <span class="field__label">Your WhatsApp number</span>
        <input name="myPhone" value="${values.myPhone}" inputmode="tel" autocomplete="off" placeholder="+91 98765 43210"${invalid(errors.myPhone)}>
        ${error(errors.myPhone)}
      </label>
      <label class="field">
        <span class="field__label">Send my daily reminder to</span>
        <select name="reminderTo"${invalid(errors.reminderTo)}>${sendToOptions(values.reminderTo, groups, { self: "This WhatsApp — the linked phone", direct: "My number (below)", none: "Nowhere — no reminder" })}</select>
        ${error(errors.reminderTo)}
      </label>
    </div>
    <div class="field-row">
      <label class="field">
        <span class="field__label">Reminder at</span>
        <input type="time" name="reminderTime" value="${values.reminderTime}" required${invalid(errors.reminderTime)}>
        ${error(errors.reminderTime)}
      </label>
      <label class="field">
        <span class="field__label">Days ahead</span>
        <input type="number" name="daysAhead" value="${values.daysAhead}" min="0" max="30" required${invalid(errors.daysAhead)}>
        ${error(errors.daysAhead)}
      </label>
    </div>
    <p class="hint">Before the wishes go out, the reminder lists every wish of the day — its time, where it goes, what it says — and the birthdays and anniversaries this many days ahead. “This WhatsApp” puts it in the linked phone’s own chat (Message yourself). Previews go to your number, or to the linked phone if you leave it empty.</p>
  </fieldset>

  <fieldset class="settings-group" id="calendar">
    <legend>Calendar</legend>
    <label class="field field--short">
      <span class="field__label">Send my calendar messages to</span>
      <select name="calendarTo"${invalid(errors.calendarTo)}>${sendToOptions(values.calendarTo, groups, { self: "This WhatsApp — the linked phone", direct: "My number (above)", none: "Nowhere — no calendar messages" })}</select>
      ${error(errors.calendarTo)}
    </label>
    <p class="hint">At the reminder time, “Your day” lists the day’s events, the tasks due, and tomorrow’s events — on days that have any. An event with a reminder gets a message of its own at that time. They go apart from the wishes’ reminder; choose a group only if everyone in it may read them.</p>
    <input type="hidden" name="captureShown" value="1">
    <label class="check check--big"><input type="checkbox" name="capture" value="1"${values.capture ? raw(" checked") : ""}> <span><strong>Add to my calendar from WhatsApp</strong><br><span class="hint">Start a message with 📅 — in any group, or in Message yourself — like <code>📅 Dentist Tue 10am</code>, <code>📅 Trip 10-13 Oct</code> or <code>📅 task Pay rent by Fri</code>. Or reply 📅 to someone’s message, to add what it says. Only messages from the linked number count, never anyone else’s. The answer comes in Message yourself; in a group, everyone there sees your 📅 message.</span></span></label>
  </fieldset>

  <fieldset class="settings-group" id="alerts">
    <legend>Alerts</legend>
    <label class="field field--short">
      <span class="field__label">When a wish is not sent, tell</span>
      <select name="alertTo"${invalid(errors.alertTo)}>${sendToOptions(values.alertTo, groups, { self: "This WhatsApp — the linked phone", direct: "My number (above)", none: "No one — no alerts" })}</select>
      ${error(errors.alertTo)}
    </label>
    <p class="hint">An alert says which wish was not sent, and why: as soon as WhatsApp refuses one, or the next morning, at the reminder time, when a day ended while this computer was off or asleep or WhatsApp was not connected. While WhatsApp is not connected, alerts wait for it too. They come from the linked number, so sent to that number itself they land in Message yourself without a notification; in a group, everyone there sees them.</p>
    <div class="form__actions">
      <button type="submit" form="test-alert" class="button button--quiet button--small" data-confirm="Send a test alert now, to where alerts go as last saved?">Send a test alert</button>
      <span class="hint">Goes where alerts go, as last saved.</span>
    </div>
  </fieldset>

  <fieldset class="settings-group">
    <legend>Time and numbers</legend>
    <div class="field-row">
      <label class="field">
        <span class="field__label">Time zone</span>
        <select name="timezone">${selectOptions(timeZones.map((z) => [z, z.replaceAll("_", " ")]), values.timezone)}</select>
      </label>
      <label class="field">
        <span class="field__label">Country code for numbers without one</span>
        <input name="countryCode" value="${values.countryCode}" inputmode="numeric" maxlength="4" autocomplete="off"${invalid(errors.countryCode)}>
        ${error(errors.countryCode)}
      </label>
    </div>
    <p class="hint">If this computer is off or asleep at the set times, the day’s messages go out when it is back — later that day, never twice.</p>
  </fieldset>

  <div class="form__actions"><button type="submit" class="button">Save changes</button></div>
</form>
<form method="post" action="/settings/test-alert" id="test-alert" hidden></form>

<section class="card" id="password" aria-labelledby="password-title">
  <h2 class="settings-title" id="password-title">Password</h2>
  <form method="post" action="/settings/password" class="form">
    <div class="field-row">
      <label class="field">
        <span class="field__label">Current password</span>
        <input type="password" name="current" autocomplete="current-password" required>
      </label>
      <label class="field">
        <span class="field__label">New password <span class="optional">${MIN_PASSWORD}+ characters</span></span>
        <input type="password" name="next" autocomplete="new-password" minlength="${MIN_PASSWORD}" maxlength="${MAX_PASSWORD}" required>
      </label>
      <label class="field">
        <span class="field__label">New password again</span>
        <input type="password" name="again" autocomplete="new-password" minlength="${MIN_PASSWORD}" maxlength="${MAX_PASSWORD}" required>
      </label>
    </div>
    <div class="form__actions"><button type="submit" class="button">Change password</button></div>
    <p class="hint">Changing it signs out every other browser. Forgot it? On the computer that runs the app, run <code>bash scripts/reset-password.sh</code> — then sign in with ADMIN_PASSWORD from its .env file.</p>
  </form>
</section>`,
  });
}
