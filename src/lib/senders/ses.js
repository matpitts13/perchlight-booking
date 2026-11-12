// Copied from perchlight-forms src/lib/senders/ses.js (from perchlight-list);
// a message with an .ics attachment is sent as Raw content (our own MIME). Carry fixes across.
// Amazon SES, v2 API over signed fetch (SigV4, service "ses").
// POST /v2/email/outbound-emails (SendEmail), Simple content with headers.
// No idempotency keys. Sending speed is limited by each account's approved rate.
import { signRequest } from "../sigv4.js";
import { classifyHttp, describe, request, safeJson } from "./common.js";
import { mime, b64 } from "../mime.js";

/** SES error types that mean a setup problem. */
const CONFIG = new Set([
  "AccountSuspendedException",
  "SendingPausedException",
  "MailFromDomainNotVerifiedException",
  "NotFoundException",
  "AccessDeniedException",
  "UnrecognizedClientException",
  "InvalidSignatureException",
  "SignatureDoesNotMatch",
]);
const THROTTLED = new Set(["TooManyRequestsException", "LimitExceededException", "ThrottlingException"]);
const REJECTED = new Set(["MessageRejected"]);

/** @returns {import("./index.js").EmailSender} */
export function sesSender({ accessKeyId, secretAccessKey, region, configurationSet }, from) {
  const base = `https://email.${region}.amazonaws.com`;
  const toHeaders = (h) => Object.entries(h ?? {}).map(([Name, Value]) => ({ Name, Value }));

  return {
    name: "ses",
    idempotent: false,

    async send(m) {
      const path = "/v2/email/outbound-emails";
      const body = JSON.stringify({
        FromEmailAddress: m.from ?? from,
        Destination: { ToAddresses: [m.to] },
        ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
        Content: m.calendar
          ? { Raw: { Data: b64(mime({ from: m.from ?? from, to: m.to, replyTo: m.headers?.["Reply-To"], subject: m.subject, text: m.text, html: m.html, calendar: { ...m.calendar, inline: false } })) } }
          : {
              Simple: {
                Subject: { Data: m.subject, Charset: "UTF-8" },
                Body: { Text: { Data: m.text, Charset: "UTF-8" }, Html: { Data: m.html, Charset: "UTF-8" } },
                Headers: toHeaders(m.headers),
              },
            },
      });
      const { headers } = await signRequest({
        method: "POST",
        url: base + path,
        headers: { "Content-Type": "application/json" },
        body,
        accessKeyId,
        secretAccessKey,
        region,
        service: "ses",
      });
      const r = await request(base + path, { method: "POST", headers, body });
      if (r.networkError) return { status: "unknown", error: `SES unreachable: ${r.networkError}` };
      if (r.res.ok) return { status: "sent", id: safeJson(r.text)?.MessageId ?? null };
      const data = safeJson(r.text);
      const type = String(r.res.headers.get("x-amzn-ErrorType") ?? data?.__type ?? data?.code ?? "").split(":")[0].split("#").pop();
      const error = describe("SES", r.res.status, `${type} ${data?.message ?? data?.Message ?? r.text}`);
      if (CONFIG.has(type)) return { status: "config", error };
      if (THROTTLED.has(type)) return { status: "throttled", error };
      if (REJECTED.has(type)) return { status: "rejected", error };
      return { status: classifyHttp(r.res.status) ?? "rejected", error };
    },
  };
}
