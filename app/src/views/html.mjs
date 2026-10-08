/* The one way pages are written: `html` escapes whatever it interpolates
 * unless it is already html (or raw()), so a name typed as <script> stays
 * text. */

class Html {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

function render(value) {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  return escape(value);
}

export const raw = (value) => new Html(String(value));

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Html(out);
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* WhatsApp's own markup — *bold*, _italic_, ~strike~ — on text that is
 * already escaped. */
export const formatMarks = (escaped) =>
  escaped
    .replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?])/gm, "$1<em>$2</em>")
    .replace(/~([^~\n]+)~/g, "<s>$1</s>");

/* A message as WhatsApp shows it. Escaped first, so the markup added here is
 * the only markup. app.js does the same for the live preview. */
export const whatsappFormat = (text) => raw(formatMarks(escape(text)));

export function selectOptions(options, selected) {
  return options.map(([value, label]) => html`<option value="${value}"${String(value) === String(selected) ? raw(" selected") : ""}>${label}</option>`);
}
