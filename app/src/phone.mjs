/* WhatsApp numbers, as people type them — "98765 43210", "+91 98765-43210",
 * "09876543210", "0091 98765 43210" — kept as digits with the country code
 * first (E.164 without the +), which is what WhatsApp addresses them by. */

/* → {phone: "919876543210"} (or {phone: ""} for nothing), or {error}.
 * A number without a country code gets `countryCode` (Settings): a 10-digit
 * national number, or one written with a leading 0. */
export function normalizePhone(input, countryCode = "91") {
  const raw = String(input ?? "").trim();
  if (!raw) return { phone: "" };
  let digits = raw.replace(/[\s().\-/]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  else if (digits.startsWith("00")) digits = digits.slice(2);
  else if (/^0\d{10}$/.test(digits)) digits = countryCode + digits.slice(1);
  else if (/^\d{10}$/.test(digits)) digits = countryCode + digits;
  if (!/^[1-9]\d{7,14}$/.test(digits)) {
    return { error: `“${raw}” is not a phone number — write it with the country code, like +91 98765 43210` };
  }
  return { phone: digits };
}

/* "919876543210" → "+91 98765 43210"; other countries just get the +. */
export function formatPhone(digits) {
  if (!digits) return "";
  if (/^91\d{10}$/.test(digits)) return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  return `+${digits}`;
}

export const directJid = (digits) => `${digits}@s.whatsapp.net`;

/* "919876543210:12@s.whatsapp.net" (a JID, perhaps with its device) → the
 * digits; anything else → "". */
export function phoneOfJid(jid) {
  const m = /^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/.exec(String(jid ?? ""));
  return m ? m[1] : "";
}
