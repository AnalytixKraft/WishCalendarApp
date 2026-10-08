/* The app's side of the WhatsApp bridge's HTTP API (whatsapp/README.md has
 * the contract). Every failure becomes a BridgeError whose message is a
 * sentence for the person reading the page, and whose `code` is the bridge's
 * own, or `unreachable` / `app_token_missing` from this side. */

export class BridgeError extends Error {
  constructor({ code, status = null, state = null, detail = null }) {
    super(explain(code, state, detail));
    this.code = code;
    this.status = status;
    this.state = state;
    this.detail = detail;
  }
}

export const STATE_LABELS = {
  unconfigured: "the bridge has no token",
  idle: "no phone linked",
  pairing: "waiting for the QR code to be scanned",
  connecting: "connecting",
  open: "connected",
  conflict: "another WhatsApp Web session took over",
};

export function explain(code, state, detail) {
  switch (code) {
    case "unreachable":
      return "The WhatsApp bridge is not answering. Check that its container is running: docker compose ps.";
    case "app_token_missing":
    case "bridge_token_not_configured":
      return "WHATSAPP_BRIDGE_TOKEN is not set. Run bash scripts/setup.sh, then docker compose up -d.";
    case "unauthorized":
      return "The app and the WhatsApp bridge hold different tokens. Run docker compose up -d so both read WHATSAPP_BRIDGE_TOKEN from .env again.";
    case "not_connected":
      return `WhatsApp is not connected (${STATE_LABELS[state] || state || "unknown state"}). Link a phone in Settings → WhatsApp.`;
    case "not_a_member":
      return "The linked WhatsApp number is not a member of this group. Add it to the group, then retry.";
    case "admins_only":
      return "Only admins can send messages in this group. Make the linked number an admin, then retry.";
    case "not_on_whatsapp":
      return "That number is not on WhatsApp. Check it on the People page — with the country code.";
    case "rate_limited":
      return `Too many direct messages this hour (${detail || "the bridge's limit"}), to keep the number from being flagged as spam. The rest go out on the next tries.`;
    case "groups_failed":
      return `WhatsApp did not send the list of groups${detail ? ` (${detail})` : ""}. Try again in a minute.`;
    case "send_failed":
      return `WhatsApp did not take the message${detail ? `: ${detail}` : "."}`;
    case "invalid_text":
      return "The message is empty or longer than 20,000 characters.";
    case "invalid_chat_id":
      return "That is not a WhatsApp group or phone number.";
    default:
      return `The WhatsApp bridge answered "${code}"${detail ? `: ${detail}` : "."}`;
  }
}

/* Codes that are about the connection (or the hour's allowance), not about
 * one message: trying the next message right away would only fail the same
 * way. */
export const CONNECTION_CODES = new Set([
  "unreachable",
  "app_token_missing",
  "bridge_token_not_configured",
  "unauthorized",
  "not_connected",
  "rate_limited",
]);

export function createBridge({ url, token, fetchImpl = globalThis.fetch }) {
  async function call(method, path, { body, timeoutMs }) {
    if (!token) throw new BridgeError({ code: "app_token_missing" });
    let res;
    try {
      res = await fetchImpl(url + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err?.name === "TimeoutError";
      throw new BridgeError({
        code: timedOut && path === "/send" ? "send_failed" : "unreachable",
        detail: timedOut
          ? `no answer within ${timeoutMs / 1000} s — it may still arrive, and a retry will not post it twice`
          : null,
      });
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      // Not JSON: whatever answered is not the bridge.
    }
    if (!res.ok || !data) {
      throw new BridgeError({
        code: data?.error || "unreachable",
        status: res.status,
        state: data?.state ?? null,
        detail: data?.message ?? null,
      });
    }
    return data;
  }

  return {
    status: () => call("GET", "/status", { timeoutMs: 10_000 }),
    pair: () => call("POST", "/pair", { timeoutMs: 15_000 }),
    logout: () => call("POST", "/logout", { timeoutMs: 20_000 }),
    groups: async () => (await call("GET", "/groups", { timeoutMs: 40_000 })).groups,
    // Above the bridge's own 30 s send timeout, so its answer arrives first.
    send: ({ chatId, text, key }) =>
      call("POST", "/send", { body: { chat_id: chatId, text, idempotency_key: key }, timeoutMs: 45_000 }),
    // 📅 messages, held until we say we have them — and the chats they
    // count in, as the bridge has them: {commands, chats}.
    commands: () => call("GET", "/commands", { timeoutMs: 10_000 }),
    ackCommands: (ids) => call("POST", "/commands/ack", { body: { ids }, timeoutMs: 10_000 }),
    setCommandChats: (chats) => call("POST", "/commands/chats", { body: { chats }, timeoutMs: 10_000 }),
  };
}
