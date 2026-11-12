// Email senders. Adapted from perchlight-forms src/lib/senders/index.js
// (itself from perchlight-list): adds the calendar invite, and splits
// "who sends to you" from "who sends to visitors".
//   To you: the free send_email binding (EMAIL) to your verified address,
//     as raw MIME with a text/calendar part; an email service if EMAIL is missing.
//   To visitors: only an email service (MAIL_PROVIDER), since send_email
//     reaches verified addresses only.
import { EmailMessage } from "cloudflare:email";
import { mime, addressOnly, icsAttachment, headerSafe } from "../mime.js";
import { redactAddresses } from "./common.js";
import { resendSender } from "./resend.js";
import { sesSender } from "./ses.js";
import { mailgunSender } from "./mailgun.js";
import { postmarkSender } from "./postmark.js";
import { cloudflareSender } from "./cloudflare.js";

/**
 * @typedef {object} Message
 * @property {string} to
 * @property {string} subject
 * @property {string} text
 * @property {string} html
 * @property {Record<string, string>} [headers]   only Reply-To is ever set
 * @property {{ method: string, ics: string, inline?: boolean }} [calendar]
 */

/**
 * sent | rejected (this address only, don't retry) | retry | throttled
 * (nothing sent, try later) | config (setup problem) | unknown (may have
 * been sent) | conflict (idempotency key reused: treated as unknown).
 * @typedef {{ status: "sent", id: string | null }
 *   | { status: "rejected" | "retry" | "throttled" | "config" | "unknown" | "conflict", error: string }} SendResult
 */

export const PROVIDERS = ["cloudflare-routing", "resend", "ses", "mailgun", "postmark", "cloudflare"];

export function providerName(env) {
  return (String(env.MAIL_PROVIDER ?? "").trim() || "cloudflare-routing").toLowerCase();
}

/** The free send_email route: only reaches addresses verified in Email Routing. */
export function routingSender(binding, from) {
  return {
    name: "cloudflare-routing",
    idempotent: false,
    async send(m) {
      try {
        const raw = mime({ from, to: m.to, replyTo: m.headers?.["Reply-To"], subject: m.subject, text: m.text, html: m.html, calendar: m.calendar });
        await binding.send(new EmailMessage(addressOnly(from), addressOnly(m.to), raw));
        return { status: "sent", id: null };
      } catch (err) {
        const msg = redactAddresses(err instanceof Error ? err.message : String(err));
        if (/not allowed|not verified|verified|destination|E_RECIPIENT|E_SENDER|domain/i.test(msg)) {
          return {
            status: "config",
            error: `send_email: ${msg}. Check the address is a verified destination in Email Routing and MAIL_FROM is on that domain.`,
          };
        }
        return { status: "retry", error: `send_email: ${msg}` };
      }
    },
  };
}

/** Wraps an email service so the calendar goes as an attachment. */
function withAttachments(sender) {
  return {
    ...sender,
    send: (m, o) => sender.send({ ...m, subject: headerSafe(m.subject), attachments: icsAttachment(m.calendar) }, o),
  };
}

/** The email service named by MAIL_PROVIDER, or { error }. */
export function providerSender(env, from = String(env.MAIL_FROM ?? "").trim()) {
  if (!from) return { error: "MAIL_FROM isn't set in wrangler.jsonc." };
  const provider = providerName(env);
  const missing = (what) => ({ error: `MAIL_PROVIDER is "${provider}" but ${what} isn't set.` });
  const ok = (s) => ({ sender: withAttachments(s) });
  switch (provider) {
    case "cloudflare-routing":
      return { error: "Emails to visitors need MAIL_PROVIDER set to an email service (resend, ses, mailgun, postmark or cloudflare)." };
    case "resend":
      return env.RESEND_API_KEY ? ok(resendSender(env.RESEND_API_KEY, from)) : missing("RESEND_API_KEY");
    case "ses":
      return env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_REGION
        ? ok(sesSender({ accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, region: env.AWS_REGION, configurationSet: env.SES_CONFIGURATION_SET || "" }, from))
        : missing("AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY or AWS_REGION");
    case "mailgun":
      return env.MAILGUN_API_KEY && env.MAILGUN_DOMAIN
        ? ok(mailgunSender({ apiKey: env.MAILGUN_API_KEY, domain: env.MAILGUN_DOMAIN, region: env.MAILGUN_REGION || "us" }, from))
        : missing("MAILGUN_API_KEY or MAILGUN_DOMAIN");
    case "postmark":
      return env.POSTMARK_SERVER_TOKEN ? ok(postmarkSender({ serverToken: env.POSTMARK_SERVER_TOKEN }, from)) : missing("POSTMARK_SERVER_TOKEN");
    case "cloudflare":
      return env.EMAIL ? ok(cloudflareSender(env.EMAIL, from)) : missing('the "EMAIL" send_email binding');
    default:
      return { error: `MAIL_PROVIDER "${provider}" isn't supported. Use ${PROVIDERS.join(", ")}.` };
  }
}

/** Sender for emails to you (the owner). */
export function ownerSender(env) {
  const from = String(env.MAIL_FROM ?? "").trim();
  if (!from) return { error: "MAIL_FROM isn't set in wrangler.jsonc." };
  if (env.EMAIL && typeof env.EMAIL.send === "function" && providerName(env) !== "cloudflare") return { sender: routingSender(env.EMAIL, from) };
  if (providerName(env) === "cloudflare-routing") return { error: 'The "EMAIL" send_email binding is missing from wrangler.jsonc.' };
  return providerSender(env, from);
}

/** Sender for emails to visitors (needs an email service). */
export function visitorSender(env) {
  return providerSender(env, String(env.VISITOR_MAIL_FROM ?? "").trim() || String(env.MAIL_FROM ?? "").trim());
}

export function canEmailVisitors(env) {
  return providerName(env) !== "cloudflare-routing";
}
