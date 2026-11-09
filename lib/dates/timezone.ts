/**
 * Timezone handling.
 *
 * The bot says "what time is it" for a clinic in Iran, but the server it runs
 * on is almost certainly UTC (Vercel is). `new Date()` alone would answer with
 * the server's clock, which is 3.5 hours behind Tehran and a different calendar
 * day after 20:30 UTC. So every "now" in this project is a `TZDate` pinned to
 * the configured zone.
 *
 * Verified: the same instant is 1405/08/18 in UTC and 1405/08/19 in Tehran.
 */

import { TZDate } from "@date-fns/tz";

import { getConfig } from "@/lib/config";
import { logWarn } from "@/lib/log";

let warnedZone: string | null = null;

export function configuredZone(): string {
  return getConfig().timeZone;
}

/**
 * `now` as seen in the configured zone.
 * Falls back to UTC (with one warning) if TIME_ZONE is not a valid IANA name,
 * so a typo in the environment can never take the bot down.
 */
export function nowInZone(now: Date = new Date(), zone: string = configuredZone()): TZDate {
  const build = (name: string): TZDate | null => {
    try {
      const date = new TZDate(now.getTime(), name);
      // TZDate does NOT throw on an unknown zone — it quietly returns NaN.
      // Verified: new TZDate(ms, "Not/AZone").getTime() === NaN.
      return Number.isFinite(date.getTime()) ? date : null;
    } catch {
      return null;
    }
  };

  const wanted = build(zone);
  if (wanted) return wanted;

  if (warnedZone !== zone) {
    warnedZone = zone;
    logWarn("dates.bad_timezone", { zone, fallback: "UTC" });
  }
  return build("UTC") ?? new TZDate(now.getTime());
}

/** Any instant, re-pinned to the configured zone (used for parsed user dates). */
export function inZone(value: Date, zone: string = configuredZone()): TZDate {
  return nowInZone(value, zone);
}

const ZONE_FA: Record<string, string> = {
  "Asia/Tehran": "به وقت تهران",
  UTC: "به وقت جهانی (UTC)",
};

export function zoneLabel(zone: string = configuredZone()): string {
  return ZONE_FA[zone] ?? `به وقت ${zone}`;
}
