// The booking config the tests use. Owner in London, Mon–Fri 09:00–17:00.
export const TEST_CONFIG = {
  owner: {
    name: "Sam Example",
    email: "sam@example.com",
    timeZone: "Europe/London",
    weekly: {
      mon: [["09:00", "17:00"]],
      tue: [["09:00", "12:00"], ["13:00", "17:00"]],
      wed: [["09:00", "17:00"]],
      thu: [["09:00", "17:00"]],
      fri: [["09:00", "17:00"]],
      sat: [],
      sun: [],
    },
    holidays: ["2026-04-03"],
    dailyCap: 6,
  },
  defaults: { minNoticeHours: 4, horizonDays: 60, bufferAfterMinutes: 15, stepMinutes: 15, holdMinutes: 10, requestHours: 48, reminders: [1440, 60] },
  types: {
    "30min": { name: "Call", minutes: 30, locations: ["video", "phone"], dailyCap: 4 },
    "60min": { name: "Workshop", minutes: 60, locations: ["in-person"], approval: true },
    "15min": { name: "Quick chat", minutes: 15, locations: ["video"], bufferAfterMinutes: 0 },
    broken: { name: "Broken", minutes: 7, locations: ["video"] },
  },
  locations: {
    video: { kind: "video", link: "https://meet.example.com/sam" },
    phone: { kind: "phone", who: "visitor-gives-number" },
    "in-person": { kind: "in-person", address: "1 Example Street, London" },
  },
  questions: { phone: "optional", notes: "optional" },
  visitorEmail: "none",
  noJs: true,
};

/** The same, with an email service for visitors. */
export const PROVIDER_CONFIG = { ...TEST_CONFIG, visitorEmail: "provider" };
export const CONFIRM_CONFIG = { ...TEST_CONFIG, visitorEmail: "provider-confirm" };
