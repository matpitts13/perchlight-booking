// Checks for what visitors type. Everything is length-limited and stripped
// of control characters; nothing a visitor types ever goes into a header raw.

/** One plain address: no display name, no spaces, quotes, angle brackets or commas. */
export function isEmail(s) {
  return typeof s === "string" && s.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(s);
}

/** Single-line text: control characters (CR/LF included) become spaces. */
export function oneLine(s, max) {
  return String(s ?? "").replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Multi-line text: keeps line breaks, drops other control characters. */
export function multiLine(s, max) {
  return String(s ?? "").replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim().slice(0, max);
}

export function isPhone(s) {
  return typeof s === "string" && /^[+0-9 ().-]{5,30}$/.test(s) && /\d{5}/.test(s.replace(/\D/g, ""));
}

/**
 * The visitor's details for a booking.
 * @returns {{ ok: true, value: object } | { ok: false, errors: Record<string, string> }}
 */
export function checkDetails(cfg, type, input) {
  const errors = {};
  const name = oneLine(input.name, 100);
  const email = oneLine(input.email, 254).toLowerCase();
  const phone = oneLine(input.phone, 30);
  const notes = multiLine(input.notes, 2000);
  const location = String(input.location ?? (type.locations.length === 1 ? type.locations[0] : ""));
  if (!name) errors.name = "Name is required";
  if (!isEmail(email)) errors.email = "Enter one email address, like name@example.com";
  if (!type.locations.includes(location)) errors.location = "Choose where to meet";
  const loc = cfg.locations[location];
  const phoneNeeded = cfg.questions.phone === "required" || (loc?.kind === "phone" && loc.who === "visitor-gives-number");
  if (cfg.questions.phone === "off" && !phoneNeeded) {
    // not asked
  } else if (phone && !isPhone(phone)) errors.phone = "Enter a phone number (digits, spaces, + ( ) - only)";
  else if (!phone && phoneNeeded) errors.phone = "A phone number is needed for a phone call";
  if (cfg.questions.notes === "required" && !notes) errors.notes = "Please add a note";
  const tz = oneLine(input.timeZone, 64);
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      email,
      phone: cfg.questions.phone === "off" && !phoneNeeded ? "" : phone,
      notes: cfg.questions.notes === "off" ? "" : notes,
      location,
      timeZone: tz,
    },
  };
}
