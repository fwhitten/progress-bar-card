import type { CalendarEvent, HomeAssistant, RawCalendarEvent } from "./types";

const CACHE_TTL = 5 * 60 * 1000;
/** Long enough for sibling cards reacting to one state change to share a request. */
export const FRESH_MAX_AGE = 2000;
const DAY = 24 * 60 * 60 * 1000;

interface CacheEntry {
  createdAt: number;
  events: Promise<RawCalendarEvent[]>;
}

/**
 * Raw responses are cached per entity and window so several cards pointed at
 * the same calendar share one round trip into the integration.
 */
const cache = new Map<string, CacheEntry>();

const pad = (value: number): string => String(value).padStart(2, "0");

/** calendar.get_events validates against local wall-clock stamps, not ISO offsets. */
const localStamp = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
  `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

/**
 * All-day events arrive as bare dates. `new Date("2026-09-11")` would read that
 * as UTC midnight and shift the bar by the local offset, so build it by parts.
 */
const parseStamp = (value: string): { ms: number; dateOnly: boolean } => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return { ms: new Date(year, month - 1, day).getTime(), dateOnly: true };
  }
  return { ms: new Date(value).getTime(), dateOnly: false };
};

export const parseEvents = (
  raw: RawCalendarEvent[] | undefined,
  includeAllDay: boolean,
): CalendarEvent[] => {
  if (!Array.isArray(raw)) return [];
  const events: CalendarEvent[] = [];

  for (const item of raw) {
    if (!item?.start || !item?.end) continue;
    if (item.status?.toLowerCase() === "cancelled") continue;

    const start = parseStamp(item.start);
    const end = parseStamp(item.end);
    if (Number.isNaN(start.ms) || Number.isNaN(end.ms) || end.ms <= start.ms) continue;

    // A bare date on the start is what marks an event as all-day; the end is exclusive.
    const allDay = start.dateOnly;
    if (allDay && !includeAllDay) continue;

    events.push({
      key: `${item.start}|${item.end}|${item.summary ?? ""}`,
      summary: item.summary?.trim() || "(No title)",
      location: item.location,
      start: start.ms,
      end: end.ms,
      allDay,
    });
  }

  events.sort((a, b) => a.start - b.start || a.end - b.end);
  return events;
};

/**
 * `maxAgeMs` lets a caller ask for fresher data without defeating the sharing:
 * cards reacting to the same state change still collapse onto one request.
 */
export const fetchCalendarEvents = (
  hass: HomeAssistant,
  entityId: string,
  lookAheadDays: number,
  maxAgeMs: number = CACHE_TTL,
): Promise<RawCalendarEvent[]> => {
  const key = `${entityId}|${lookAheadDays}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.createdAt < maxAgeMs) return hit.events;

  // Start at midnight so an event already in progress, or an all-day event,
  // still overlaps the window.
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(now + lookAheadDays * DAY);

  const events = Promise.resolve(
    hass.callService(
      "calendar",
      "get_events",
      { start_date_time: localStamp(from), end_date_time: localStamp(to) },
      { entity_id: entityId },
      false,
      true,
    ),
  )
    .then((result) => {
      const response = (
        result as { response?: Record<string, { events?: RawCalendarEvent[] }> } | undefined
      )?.response;
      return response?.[entityId]?.events ?? [];
    })
    .catch((err) => {
      cache.delete(key);
      throw err;
    });

  cache.set(key, { createdAt: now, events });
  return events;
};

export const invalidateCalendar = (entityId: string): void => {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${entityId}|`)) cache.delete(key);
  }
};

/** Every event in progress at `now`, in start order. */
export const eventsInProgress = (events: CalendarEvent[], now: number): CalendarEvent[] =>
  events.filter((event) => event.start <= now && now < event.end);

export const nextEventAfter = (
  events: CalendarEvent[],
  now: number,
): CalendarEvent | undefined => events.find((event) => event.start > now);

/**
 * The two most significant units, with seconds only once under an hour:
 * "3d 4h", "2h 15m", "4m 20s", "45s".
 */
export const formatDuration = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};

/** How long until the displayed countdown would change. */
export const tickInterval = (remainingMs: number): number =>
  remainingMs < 60 * 60 * 1000 ? 1000 : 60 * 1000;

/** Fallback for when get_events is unavailable: the one event the entity exposes. */
export const eventFromAttributes = (
  attributes: Record<string, unknown>,
  includeAllDay: boolean,
): CalendarEvent | undefined => {
  const start = attributes.start_time;
  const end = attributes.end_time;
  if (typeof start !== "string" || typeof end !== "string") return undefined;

  const allDay = attributes.all_day === true;
  if (allDay && !includeAllDay) return undefined;

  // Attribute stamps are local wall-clock with a space separator.
  const startMs = new Date(start.replace(" ", "T")).getTime();
  const endMs = new Date(end.replace(" ", "T")).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return undefined;

  const summary = typeof attributes.message === "string" ? attributes.message : "";
  return {
    key: `${start}|${end}|${summary}`,
    summary: summary.trim() || "(No title)",
    location: typeof attributes.location === "string" ? attributes.location : undefined,
    start: startMs,
    end: endMs,
    allDay,
  };
};
