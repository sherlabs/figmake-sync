import { randomUUID } from "node:crypto";
import { request } from "node:https";
import * as path from "node:path";
import fs from "fs-extra";
import { app } from "electron";

const MEASUREMENT_ID = "G-S2TBWXV98P";
const API_SECRET = "PqPHg7IVS7WIQWEi_Y3mZw";
const ENDPOINT = `https://www.google-analytics.com/mp/collect?measurement_id=${MEASUREMENT_ID}&api_secret=${API_SECRET}`;

let clientId: string | null = null;

async function getClientId(): Promise<string> {
  if (clientId) return clientId;
  const file = path.join(app.getPath("userData"), "analytics-id.json");
  try {
    const data = await fs.readJson(file) as { clientId?: unknown };
    if (typeof data.clientId === "string") {
      clientId = data.clientId;
      return clientId;
    }
  } catch {
    // no file yet
  }
  clientId = randomUUID();
  await fs.outputJson(file, { clientId });
  return clientId;
}

function sendRaw(body: string): void {
  try {
    const url = new URL(ENDPOINT);
    const req = request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      () => {},
    );
    req.on("error", () => {});
    req.write(body);
    req.end();
  } catch {
    // never throw from analytics
  }
}

export async function trackEvent(
  name: string,
  params: Record<string, string | number> = {},
): Promise<void> {
  try {
    const cid = await getClientId();
    const payload = JSON.stringify({
      client_id: cid,
      events: [{ name, params: { engagement_time_msec: "1", ...params } }],
    });
    sendRaw(payload);
  } catch {
    // never throw from analytics
  }
}
