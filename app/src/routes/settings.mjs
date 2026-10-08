/* Settings: linking WhatsApp, when and where messages go, alerts, and the
 * password. */

import { renderSVG } from "uqr";
import { COOKIE, MAX_AGE_S, MAX_PASSWORD, MIN_PASSWORD } from "../auth.mjs";
import { isValidTimeZone, parseTime } from "../dates.mjs";
import { clientAddress, describeError, readForm, redirect, send, sendJson, serializeCookie } from "../http.mjs";
import { DEFAULT_ANNIVERSARY_TEMPLATE, DEFAULT_TEMPLATE } from "../messages.mjs";
import { formatPhone, normalizePhone } from "../phone.mjs";
import { NotSendable } from "../scheduler.mjs";
import { plural } from "../views/html.mjs";
import { settingsPage } from "../views/settings.mjs";
import { readMessage, readSendTo } from "./forms.mjs";

function timeZones(current) {
  const zones = Intl.supportedValuesOf("timeZone");
  return zones.includes(current) ? zones : [current, ...zones];
}

export function settingsRoutes({ db, bridge, scheduler, log, assets, auth, throttle, waStatus, knownGroups }) {
  /* WhatsApp is a section of Settings now; old links still arrive. */
  const whatsapp = (ctx) => redirect(ctx.res, "/settings#whatsapp");

  /* For the WhatsApp section's polling (Settings). Never the QR itself — that is only ever
   * the image below. */
  async function whatsappStatusJson(ctx) {
    const { status, error } = await waStatus();
    sendJson(
      ctx.res,
      200,
      status
        ? { state: status.state, has_qr: Boolean(status.qr), qr_expires_at: status.qr_expires_at, since: status.since }
        : { state: "unreachable", error },
    );
  }

  async function whatsappQr(ctx) {
    const { status } = await waStatus();
    if (!status?.qr) return send(ctx.res, 404, "No QR code right now.", { "content-type": "text/plain; charset=utf-8" });
    send(ctx.res, 200, renderSVG(status.qr, { border: 2 }), { "content-type": "image/svg+xml" });
  }

  async function whatsappPair(ctx) {
    await readForm(ctx.req);
    try {
      await bridge.pair();
      ctx.back("/settings#whatsapp");
    } catch (err) {
      ctx.back("/settings#whatsapp", "error", describeError(err));
    }
  }

  async function whatsappLogout(ctx) {
    await readForm(ctx.req);
    try {
      const status = await bridge.logout();
      ctx.back("/settings#whatsapp", status.last_error ? "info" : "ok", status.last_error || "Unlinked. Nothing is sent until a phone is linked again.");
    } catch (err) {
      ctx.back("/settings#whatsapp", "error", describeError(err));
    }
  }

  async function renderSettings(ctx, { status = 200, values, errors = {} }) {
    const wa = await waStatus();
    const { groups } = await knownGroups();
    ctx.page(status, settingsPage({ values, errors, timeZones: timeZones(values.timezone), groups, wa, assets, flash: ctx.flash }));
  }

  /* Settings → Password. The current one first, counted like a sign-in, so
   * a borrowed session cannot be turned into a guessing machine. Answers go
   * back as a flash message, never with what was typed. */
  async function passwordSave(ctx) {
    const { req } = ctx;
    const form = await readForm(req, 10_000);
    const address = clientAddress(req);
    const wait = throttle.waitMinutes(address);
    if (wait) return ctx.back("/settings", "error", `Too many wrong passwords. Try again in ${plural(wait, "minute")}.`);
    const next = form.raw("next");
    if (!auth.checkPassword(form.raw("current"))) {
      throttle.fail(address);
      log.warn({ address }, "password not changed: wrong current password");
      return ctx.back("/settings", "error", "The current password is not right, so the password was not changed.");
    }
    if (next.length < MIN_PASSWORD || next.length > MAX_PASSWORD) {
      return ctx.back("/settings", "error", `The new password needs ${MIN_PASSWORD} to ${MAX_PASSWORD} characters. Nothing was changed.`);
    }
    if (next !== form.raw("again")) return ctx.back("/settings", "error", "The two new passwords are not the same. Nothing was changed.");
    auth.setPassword(next);
    throttle.reset(address);
    log.info({ address }, "password changed");
    // This browser stays signed in (a cookie under the new key); every other
    // one is signed out by the change itself.
    ctx.back("/settings", "ok", "Password changed. Every other browser is signed out.", {
      cookies: [serializeCookie(COOKIE, auth.issue(), { maxAge: MAX_AGE_S, secure: ctx.secure })],
    });
  }

  /* Settings → Alerts → Send a test alert: to where alerts go, as saved. */
  async function testAlert(ctx) {
    await readForm(ctx.req);
    try {
      const to = await scheduler.sendTestAlert();
      ctx.back("/settings", "ok", `Test alert sent to ${to.label}.`);
    } catch (err) {
      ctx.back("/settings", "error", `The test alert was not sent: ${err instanceof NotSendable ? err.message : describeError(err)}`);
    }
  }

  function settingsForm(ctx) {
    const values = db.settings.get();
    return renderSettings(ctx, { values: { ...values, myPhone: formatPhone(values.myPhone) } });
  }

  async function settingsSave(ctx) {
    const form = await readForm(ctx.req);
    const before = db.settings.get();
    const values = {
      enabled: form.has("enabled"),
      wishTime: form.get("wishTime"),
      reminderTime: form.get("reminderTime"),
      timezone: isValidTimeZone(form.get("timezone")) ? form.get("timezone") : before.timezone,
      daysAhead: form.get("daysAhead"),
      template: readMessage(form, "template"),
      anniversaryTemplate: readMessage(form, "anniversaryTemplate"),
      myPhone: form.get("myPhone"),
      reminderTo: form.get("reminderTo"),
      // A Settings page opened before alerts existed has no such field: saving
      // it keeps them as they are, rather than turning them off.
      alertTo: form.has("alertTo") ? form.get("alertTo") : before.alertTo,
      countryCode: form.get("countryCode").replace(/^\+/, ""),
    };
    const errors = {};
    if (parseTime(values.wishTime) === null) errors.wishTime = "Enter a time like 08:00.";
    if (parseTime(values.reminderTime) === null) errors.reminderTime = "Enter a time like 07:00.";
    const daysAhead = Number(values.daysAhead);
    if (values.daysAhead === "" || !Number.isInteger(daysAhead) || daysAhead < 0 || daysAhead > 30) {
      errors.daysAhead = "Enter a whole number from 0 to 30.";
    }
    if (!/^[1-9]\d{0,3}$/.test(values.countryCode)) errors.countryCode = "Enter a country code, like 91.";
    const myPhone = normalizePhone(values.myPhone, errors.countryCode ? before.countryCode : values.countryCode);
    if (myPhone.error) errors.myPhone = myPhone.error;
    const reminderTo = readSendTo(values.reminderTo, myPhone.phone, { direct: "your", self: true });
    if (reminderTo.error && !myPhone.error) errors.reminderTo = reminderTo.error;
    const alertTo = readSendTo(values.alertTo, myPhone.phone, { direct: "your", self: true });
    if (alertTo.error && !myPhone.error) errors.alertTo = alertTo.error;
    if (Object.keys(errors).length) return renderSettings(ctx, { status: 422, values, errors });

    db.settings.save({
      ...values,
      daysAhead,
      template: values.template || DEFAULT_TEMPLATE,
      anniversaryTemplate: values.anniversaryTemplate || DEFAULT_ANNIVERSARY_TEMPLATE,
      myPhone: myPhone.phone,
      reminderTo: reminderTo.sendTo,
      alertTo: alertTo.sendTo,
    });
    let text = "Settings saved.";
    if (values.enabled && !before.enabled) {
      scheduler.sendingTurnedOn();
      const due = scheduler.agenda().filter((job) => job.to && job.due && job.delivery?.status !== "sent");
      text = due.length ? `Sending is on. ${plural(due.length, "message")} due today will go out within a minute.` : "Sending is on.";
    } else if (!values.enabled && before.enabled) {
      text = "Sending is paused. Nothing goes out on its own until you turn it back on.";
    }
    ctx.back("/settings", "ok", text);
  }

  return [
    ["GET", /^\/whatsapp$/, whatsapp],
    ["GET", /^\/whatsapp\/status\.json$/, whatsappStatusJson],
    ["GET", /^\/whatsapp\/qr\.svg$/, whatsappQr],
    ["POST", /^\/whatsapp\/pair$/, whatsappPair],
    ["POST", /^\/whatsapp\/logout$/, whatsappLogout],
    ["GET", /^\/settings$/, settingsForm],
    ["POST", /^\/settings\/password$/, passwordSave],
    ["POST", /^\/settings\/test-alert$/, testAlert],
    ["POST", /^\/settings$/, settingsSave],
  ];
}
