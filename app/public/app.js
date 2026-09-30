/* The little the pages do in the browser. Everything works without it; this
 * adds confirmations, the people filter, the live wish preview and the QR
 * code that follows the WhatsApp link along. */

// Ask before anything that posts in a group or removes something.
document.addEventListener("submit", (event) => {
  const form = event.target;
  const question = form.dataset.confirm;
  if (question && !window.confirm(question)) {
    event.preventDefault();
    return;
  }
  // One click, one post: a second click while the first is sending would
  // only queue up behind it.
  const button = event.submitter;
  if (button) setTimeout(() => (button.disabled = true), 0);
});

// Back to a page from the browser's cache: its buttons work again.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) for (const button of document.querySelectorAll("button[disabled]")) button.disabled = false;
});

// People: filter the table by name as you type.
for (const input of document.querySelectorAll("[data-filter]")) {
  const table = document.getElementById(input.dataset.filter);
  const empty = document.querySelector(`[data-filter-empty="${input.dataset.filter}"]`);
  input.addEventListener("input", () => {
    const query = input.value.trim().toLowerCase();
    let shown = 0;
    for (const row of table.tBodies[0].rows) {
      const match = !query || row.dataset.name.includes(query);
      row.hidden = !match;
      if (match) shown++;
    }
    if (empty) empty.hidden = shown > 0;
  });
}

// Groups: the wish message shows only while wishes are ticked.
for (const box of document.querySelectorAll("input[data-shows]")) {
  const target = document.getElementById(box.dataset.shows);
  if (target) box.addEventListener("change", () => (target.hidden = !box.checked));
}

// Groups: the wish preview follows the message as it is typed. The same
// rules as app/src/messages.mjs (renderWish) and views.mjs (whatsappFormat).
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function renderWish(template, values) {
  return template
    .replace(/\{(name|first_name|age|ordinal_age|group)\}/g, (_, key) => values[key] ?? "")
    .split("\n")
    .map((line) => line.replace(/(\S) {2,}/g, "$1 ").replace(/(\S) +([,.!?])/g, "$1$2").trimEnd())
    .join("\n")
    .trim();
}

function whatsappFormat(text) {
  return escapeHtml(text)
    .replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?])/gm, "$1<em>$2</em>")
    .replace(/~([^~\n]+)~/g, "<s>$1</s>");
}

for (const textarea of document.querySelectorAll("textarea[data-preview]")) {
  const bubble = document.getElementById(textarea.dataset.preview);
  if (!bubble) continue;
  const sample = JSON.parse(bubble.dataset.sample);
  textarea.addEventListener("input", () => {
    const template = textarea.value.trim() || bubble.dataset.default;
    bubble.innerHTML = whatsappFormat(renderWish(template, { ...sample, group: bubble.dataset.group }));
  });
}

// WhatsApp: while a QR is on offer or the link is connecting, follow the
// bridge — a new QR every 20 s, and a fresh page once the state moves on.
const wa = document.querySelector("[data-wa-state]");
if (wa && ["pairing", "connecting"].includes(wa.dataset.waState)) {
  const startedIn = wa.dataset.waState;
  let shownQr = null;
  const image = () => wa.querySelector("[data-qr]");
  const poll = async () => {
    try {
      const response = await fetch("/whatsapp/status.json", { cache: "no-store" });
      if (!response.ok) return;
      const status = await response.json();
      if (status.state !== startedIn) {
        window.location.reload();
        return;
      }
      if (status.has_qr && status.qr_expires_at !== shownQr) {
        shownQr = status.qr_expires_at;
        const img = document.createElement("img");
        img.src = `/whatsapp/qr.svg?t=${encodeURIComponent(shownQr)}`;
        img.width = 264;
        img.height = 264;
        img.alt = "QR code for linking WhatsApp";
        img.dataset.qr = "";
        image()?.replaceWith(img);
      }
    } catch {
      // The next poll tries again.
    }
  };
  poll();
  setInterval(poll, 2000);
}
