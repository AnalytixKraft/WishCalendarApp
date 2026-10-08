/* Today, and its two buttons: send today's messages now, and retry one. */

import { isoDate, upcomingBirthdays } from "../dates.mjs";
import { readForm } from "../http.mjs";
import { destinationOf } from "../scheduler.mjs";
import { plural } from "../views/html.mjs";
import { todayPage } from "../views/today.mjs";

function outcomeFlash(result, planned) {
  switch (result.outcome) {
    case "busy":
      return ["info", "Messages are already going out. Check back in a minute."];
    case "idle":
      return ["info", planned ? "Nothing left to send today — everything that can go has gone out." : "Nothing to send today."];
    case "waiting":
      return ["error", `Nothing was sent. ${result.detail}`];
    case "sent":
      return ["ok", `Sent ${plural(result.sent, "message")}.`];
    case "failed":
      return ["error", `${result.sent} sent, ${result.failed} not sent — see Today’s messages.`];
    default:
      return ["info", "Done."];
  }
}

export function todayRoutes({ db, scheduler, assets, waStatus }) {
  async function today(ctx) {
    const { settings, date } = scheduler.today();
    const people = db.people.active();
    ctx.page(
      200,
      todayPage({
        today: date,
        settings,
        wa: await waStatus(), // first: it tells the scheduler who is linked
        reminderLabel: destinationOf(settings.reminderTo, settings.myPhone, db.chats.names())?.label ?? null,
        alertLabel: destinationOf(settings.alertTo, settings.myPhone, db.chats.names())?.label ?? null,
        agenda: scheduler.agenda(),
        upcoming: upcomingBirthdays(people, date, 30),
        recent: db.deliveries.recent(15),
        last: scheduler.last,
        counts: { people: db.people.count(), unassigned: people.filter((p) => !p.sendTo).length },
        journal: db.journal.get(isoDate(date)),
        assets,
        flash: ctx.flash,
      }),
    );
  }

  async function runNow(ctx) {
    await readForm(ctx.req);
    const planned = scheduler.agenda().length;
    ctx.back("/", ...outcomeFlash(await scheduler.run({ force: true }), planned));
  }

  async function retry(ctx) {
    const form = await readForm(ctx.req);
    ctx.back("/", ...outcomeFlash(await scheduler.run({ force: true, only: form.get("key") }), 1));
  }

  return [
    ["GET", /^\/$/, today],
    ["POST", /^\/run$/, runNow],
    ["POST", /^\/retry$/, retry],
  ];
}
