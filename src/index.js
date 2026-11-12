// perchlight-booking: a self-hosted booking page on Cloudflare Workers + D1
// + one small Durable Object (the Clock, which holds only an alarm).
// Your event types and weekly hours are in booking.json at the repo root;
// a push redeploys. There is no cron trigger (docs/SDD.md, "Reminders and housekeeping without cron").
import config from "../booking.json";
import { makeWorker } from "./app.js";
import { clockClass } from "./clock.js";

export default makeWorker(config);
export const Clock = clockClass(config);