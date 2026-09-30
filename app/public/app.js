/* The little the pages do in the browser. Everything works without it; this
 * adds confirmations, the people filter, the live wish preview and the QR
 * code that follows the WhatsApp link along. */

// Ask before anything that sends a message or removes something. A button
// can ask its own question (a row's "Send now" in the People table), else
// the form's.
document.addEventListener("submit", (event) => {
  const form = event.target;
  const question = event.submitter?.dataset.confirm || form.dataset.confirm;
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

// A message box left empty sends the default. Clicking into it puts the
// default in, ready to change for this one; left unchanged, it goes back to
// empty — still following the default, wherever that is edited later.
// On a person's page the name may still be being typed: the default is made
// theirs (views.mjs, personalize) when the box is clicked, not before.
const personalize = (template, name) =>
  name ? template.replaceAll("{name}", name).replaceAll("{first_name}", name.split(/\s+/)[0]) : template;
for (const box of document.querySelectorAll("textarea[data-default-message]")) {
  const nameInput = box.form?.querySelector('input[name="name"]');
  box.addEventListener("focus", () => {
    if (box.value.trim() !== "") return;
    const template = box.dataset.defaultTemplate;
    box.dataset.defaultMessage = template ? personalize(template, nameInput?.value.trim()) : box.dataset.defaultMessage;
    box.value = box.dataset.defaultMessage;
    box.dispatchEvent(new Event("input"));
    // The click that focused it would leave the cursor mid-text, where it
    // landed on mouse-up: the end is where one expects to start typing. The
    // listener is short-lived, so a later click to place the cursor wins.
    const toEnd = () => box.setSelectionRange(box.value.length, box.value.length);
    setTimeout(toEnd, 0);
    box.addEventListener("mouseup", toEnd, { once: true });
    setTimeout(() => box.removeEventListener("mouseup", toEnd), 600);
  });
  box.addEventListener("blur", () => {
    if (box.value.trim() === box.dataset.defaultMessage.trim()) {
      box.value = "";
      box.dispatchEvent(new Event("input"));
    }
  });
}

// Upload a list: a chosen file is read into the list box, to be checked
// before it is added.
for (const input of document.querySelectorAll("input[data-file-into]")) {
  const box = document.getElementById(input.dataset.fileInto);
  input.closest("[data-file-field]").hidden = false;
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (file) box.value = (await file.text()).replace(/^﻿/, ""); // Excel's byte-order mark
  });
}

// A person's wish preview follows the message as it is typed, and the
// group's name as "Send wish to" changes. The same rules as
// app/src/messages.mjs (renderWish) and views.mjs (whatsappFormat).
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
  const update = () => {
    const template = textarea.value.trim() || bubble.dataset.default;
    bubble.innerHTML = whatsappFormat(renderWish(template, { ...sample, group: bubble.dataset.group }));
  };
  textarea.addEventListener("input", update);
  for (const select of document.querySelectorAll(`select[data-group-for="${bubble.id}"]`)) {
    select.addEventListener("change", () => {
      const option = select.selectedOptions[0];
      bubble.dataset.group = option?.parentElement.tagName === "OPTGROUP" ? option.textContent : "";
      update();
    });
  }
  // The preview follows the name as it is typed.
  const nameInput = textarea.form?.querySelector('input[name="name"]');
  nameInput?.addEventListener("input", () => {
    const name = nameInput.value.trim();
    sample.name = name || "Their name";
    sample.first_name = sample.name.split(/\s+/)[0];
    textarea.placeholder = personalize(textarea.dataset.defaultTemplate ?? textarea.placeholder, name);
    update();
  });
  // Birthday or anniversary: each has its own default message.
  for (const radio of document.querySelectorAll(`input[data-kind-for="${bubble.id}"]`)) {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      const fallback = radio.value === "anniversary" ? bubble.dataset.defaultAnniversary : bubble.dataset.defaultBirthday;
      bubble.dataset.default = fallback;
      if (textarea.value.trim() === textarea.dataset.defaultMessage?.trim()) textarea.value = "";
      textarea.dataset.defaultTemplate = fallback;
      textarea.dataset.defaultMessage = personalize(fallback, nameInput?.value.trim());
      textarea.placeholder = personalize(fallback, nameInput?.value.trim());
      update();
    });
  }
}

// WhatsApp (in Settings): while a QR is on offer or the link is connecting,
// follow the bridge — a new QR every 20 s, and a fresh page once the state
// moves on. Not over settings being edited below it, though: then it says so
// instead of reloading.
const wa = document.querySelector("[data-wa-state]");
let editing = false;
document.addEventListener("input", (event) => {
  if (!event.target.closest("[data-wa-state]")) editing = true;
});
if (wa && ["pairing", "connecting"].includes(wa.dataset.waState)) {
  const startedIn = wa.dataset.waState;
  let timer = null;
  let shownQr = null;
  const image = () => wa.querySelector("[data-qr]");
  const poll = async () => {
    try {
      const response = await fetch("/whatsapp/status.json", { cache: "no-store" });
      if (!response.ok) return;
      const status = await response.json();
      if (status.state !== startedIn) {
        if (editing) {
          clearInterval(timer);
          wa.querySelector(".wa-changed").hidden = false;
        } else {
          window.location.reload();
        }
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
  timer = setInterval(poll, 2000);
}
