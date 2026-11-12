// The Worker under test: the app and the Clock, built around TEST_CONFIG.
import { makeWorker } from "../src/app.js";
import { clockClass } from "../src/clock.js";
import { TEST_CONFIG } from "./config.js";

export default makeWorker(TEST_CONFIG);
export const Clock = clockClass(TEST_CONFIG);