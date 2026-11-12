// perchlight-booking: the time picker. No framework, no cookies, no storage.
// Times come from the API as UTC instants and are shown in the visitor's zone
// (detected, changeable); only UTC instants are ever sent back.
(() => {
  "use strict";
  const app = document.getElementById("app");
  const typeId = decodeURIComponent(location.pathname.replace(/^\/+|\/+$/g, ""));
  const DAY = 86400000;
  let info = null;
  let type = null;
  let zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  let week = 0;
  let tsWidget = null;

  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "on") for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
      else if (v !== false && v !== null && v !== undefined) n.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return n;
  };
  const show = (...kids) => app.replaceChildren(...kids);
  const fmt = (o) => new Intl.DateTimeFormat(undefined, { timeZone: zone, ...o });
  const dayName = (ms) => fmt({ weekday: "long", day: "numeric", month: "long" }).format(ms);
  const time = (ms) => fmt({ hour: "2-digit", minute: "2-digit" }).format(ms);
  const when = (ms) => fmt({ dateStyle: "full", timeStyle: "short" }).format(ms);
  const dayKey = (ms) => fmt({ year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);

  async function api(path, body) {
    const res = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = { ok: false, error: "Something went wrong. Please try again." };
    }
    return { status: res.status, data };
  }

  function message(text, extra = []) {
    return el("p", { class: "note", role: "status" }, text, ...extra);
  }

  async function start() {
    const r = await api("/api/types");
    if (!r.data.ok) return show(message(r.data.error));
    info = r.data;
    if (!typeId) return listTypes();
    type = info.types.find((t) => t.id === typeId);
    if (!type) return show(el("h1", {}, "Not found"), el("p", {}, "There's no booking type here. "), el("a", { href: "/" }, "See all"));
    if (!type.on) return show(el("h1", {}, type.name), message("This booking type isn't set up correctly."));
    if (info.turnstileSiteKey) loadTurnstile();
    renderWeek();
  }

  function listTypes() {
    show(
      el("h1", {}, `Book a time with ${info.owner.name}`),
      el("ul", {}, info.types.filter((t) => t.on).map((t) => el("li", {}, el("a", { href: `/${encodeURIComponent(t.id)}` }, t.name), ` (${t.minutes} minutes)`))),
      info.noJs ? el("p", { class: "muted" }, el("a", { href: "/nojs/" }, "Book without JavaScript")) : "",
    );
  }

  function loadTurnstile() {
    window.onTsLoad = () => {
      const box = document.getElementById("ts");
      if (box && window.turnstile) tsWidget = window.turnstile.render(box, { sitekey: info.turnstileSiteKey });
    };
    document.head.append(el("script", { src: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTsLoad", async: true }));
  }
  const tsToken = () => (window.turnstile && tsWidget !== null ? window.turnstile.getResponse(tsWidget) || "" : "");
  const tsReset = () => window.turnstile && tsWidget !== null && window.turnstile.reset(tsWidget);

  function zonePicker() {
    const list = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [zone];
    const input = el("input", { id: "zone", list: "zones", value: zone, autocomplete: "off" });
    input.addEventListener("change", () => {
      if (list.includes(input.value) || input.value === "UTC") {
        zone = input.value;
        renderWeek();
      }
    });
    return el("label", {}, "Times shown in ", input, el("datalist", { id: "zones" }, list.map((z) => el("option", { value: z }))));
  }

  async function renderWeek(note) {
    const from = Date.now() + week * 7 * DAY;
    const head = [
      el("h1", {}, `${type.name} with ${info.owner.name}`),
      el("p", {}, `${type.minutes} minutes`, type.approval ? " · needs approval" : ""),
      type.description ? el("p", {}, type.description) : "",
      zonePicker(),
      note ? message(note) : "",
    ];
    show(...head, el("p", {}, "Loading times…"));
    const r = await api(`/api/slots?type=${encodeURIComponent(type.id)}&from=${new Date(from).toISOString()}&to=${new Date(from + 7 * DAY).toISOString()}`);
    if (!r.data.ok) return show(...head, message(r.data.error));
    if (r.data.paused) return show(...head, message(r.data.message));
    const days = new Map();
    for (const iso of r.data.slots) {
      const ms = Date.parse(iso);
      const k = dayKey(ms);
      if (!days.has(k)) days.set(k, []);
      days.get(k).push(ms);
    }
    const grid = el("div", {});
    if (!days.size) grid.append(el("p", {}, "No free times this week."));
    for (const list of days.values()) {
      grid.append(el("section", { class: "day" }, el("h3", {}, dayName(list[0])), list.map((ms) => el("button", { type: "button", class: "slot", on: { click: () => hold(ms) } }, time(ms)))));
    }
    const nav = el(
      "p",
      { class: "nav" },
      week > 0 ? el("button", { type: "button", on: { click: () => { week--; renderWeek(); } } }, "Earlier") : "",
      el("button", { type: "button", on: { click: () => { week++; renderWeek(); } } }, "Later"),
    );
    show(...head, info.turnstileSiteKey ? el("div", { id: "ts" }) : "", grid, nav);
    if (info.turnstileSiteKey && window.turnstile) window.onTsLoad();
  }

  async function hold(ms) {
    if (info.turnstileSiteKey && !tsToken()) return alertNote("Please complete the check above first.");
    const r = await api("/api/hold", { type: type.id, start: new Date(ms).toISOString(), turnstile: tsToken() });
    tsReset();
    if (r.status === 409 && r.data.nearest) {
      return renderWeek(`${r.data.error} Nearest free times: ${r.data.nearest.map((t) => when(Date.parse(t))).join("; ") || "none this week"}.`);
    }
    if (!r.data.ok) return alertNote(r.data.error);
    detailsForm(ms, r.data);
  }

  function alertNote(text) {
    const old = app.querySelector(".note");
    const n = message(text);
    if (old) old.replaceWith(n);
    else app.prepend(n);
    n.focus?.();
  }

  function detailsForm(ms, h) {
    const locs = type.locations;
    const label = (l) => l.label || { video: "Video call", "in-person": "In person", phone: l.who === "owner-number" ? "Phone (you call)" : "Phone (we call you)" }[l.kind];
    const field = (name, text, attrs = {}) => [el("label", {}, text, " ", el(attrs.tag || "input", { name, ...attrs, tag: null })), el("span", { class: "err", id: `${name}-err` })];
    const form = el(
      "form",
      { novalidate: true },
      field("name", "Name", { required: true, maxlength: 100, autocomplete: "name" }),
      field("email", "Email", { type: "email", required: true, maxlength: 254, autocomplete: "email" }),
      info.questions.phone !== "off" || locs.some((l) => l.kind === "phone" && l.who !== "owner-number") ? field("phone", "Phone (optional, needed if we call you)", { type: "tel", maxlength: 30, autocomplete: "tel" }) : "",
      info.questions.notes !== "off" ? field("notes", "Notes (optional)", { tag: "textarea", maxlength: 2000, rows: 3 }) : "",
      locs.length > 1
        ? el("fieldset", {}, el("legend", {}, "Where"), locs.map((l, i) => el("label", {}, el("input", { type: "radio", name: "location", value: l.key, checked: i === 0 }), " ", label(l))), el("span", { class: "err", id: "location-err" }))
        : el("input", { type: "hidden", name: "location", value: locs[0].key }),
      el("div", { class: "hp", "aria-hidden": "true" }, el("label", {}, "Leave this empty ", el("input", { name: "website", tabindex: "-1", autocomplete: "off" }))),
      el("button", { type: "submit" }, type.approval ? "Send request" : "Book"),
      el("button", { type: "button", class: "slot", on: { click: () => renderWeek() } }, "Pick another time"),
    );
    const left = el("span", {});
    const tick = () => {
      const s = Math.max(0, Math.round((Date.parse(h.expiresAt) - Date.now()) / 1000));
      left.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    };
    tick();
    const timer = setInterval(tick, 1000);
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = Object.fromEntries(new FormData(form));
      form.querySelectorAll(".err").forEach((n) => (n.textContent = ""));
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      const r = await api("/api/confirm", { holdId: h.holdId, token: h.token, timeZone: zone, ...fd });
      btn.disabled = false;
      if (r.data.ok) {
        clearInterval(timer);
        if (r.data.manageUrl) location.href = r.data.manageUrl;
        else show(el("h1", {}, "Check your email"), message(r.data.message));
        return;
      }
      if (r.data.errors) {
        for (const [k, v] of Object.entries(r.data.errors)) {
          const n = document.getElementById(`${k}-err`);
          if (n) n.textContent = v;
        }
        return alertNote(r.data.error);
      }
      if (r.data.code === "expired") {
        clearInterval(timer);
        return show(
          el("h1", {}, "Your hold ran out"),
          r.data.stillFree ? el("p", {}, "The time is still free. ", el("button", { type: "button", on: { click: () => hold(ms) } }, "Hold it again")) : el("p", {}, "Someone else took it meanwhile."),
          el("button", { type: "button", class: "slot", on: { click: () => renderWeek() } }, "Pick another time"),
        );
      }
      alertNote(r.data.error);
    });
    show(el("h1", {}, type.name), el("p", {}, when(ms), ` (${zone.replace(/_/g, " ")})`), el("p", { class: "muted" }, "Held for you for ", left, "."), form);
    form.querySelector("input[name=name]").focus();
  }

  start().catch(() => show(message("Something went wrong. Please reload the page.")));
})();
