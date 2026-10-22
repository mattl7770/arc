/**
 * The calendar seam — the ONLY file that touches `expo-calendar` (2026-10-21,
 * docs/decisions.md "Calendar context to the model").
 *
 * READ-ONLY BY CONSTRUCTION. The slice of the library typed below has no create,
 * update or delete in it; nothing in ARC can write to the calendar through this
 * file because nothing here can name a write.
 *
 * ## Guarded, exactly like the HealthKit and backup seams
 *
 * `expo-calendar` creates its native handle at import time
 * (`requireNativeModule('CalendarNext')`), which THROWS when the module is not
 * in the running binary — the web logic-check preview, the headless suites, and
 * every build before the one that adds it. So the library is required lazily,
 * inside try/catch, once; when it is absent every call here reports
 * `unavailable` and nothing throws into the app. Do not "simplify" it into a
 * top-level import.
 *
 * ## Asks only when told to
 *
 * {@link calendarAccess} and {@link readCalendarEvents} only CHECK permission
 * (`getCalendarPermissions`, which never prompts). The one call that can raise
 * the iOS dialog is {@link requestCalendarAccess}, and its one caller is the
 * Calendar switch in Settings › Coach, when the owner turns it on.
 *
 * Full access, never write-only: on iOS 17+ write-only access returns no
 * events, and the native requester maps it to `denied`, which is what it is
 * for ARC's purpose.
 *
 * ## Plain shapes out
 *
 * The native event is a shared object whose getters reach into EventKit. Five
 * properties are read off it — title, start, end, all-day, location — plus its
 * calendar id (to name the calendar) and status (to drop a cancelled event),
 * and the handle is dropped. Notes, attendees, URLs and organisers are never
 * read, so they exist nowhere in JavaScript.
 */
import type { CalendarEventFact } from './format';

/** What iOS says about ARC's calendar access, plus "this binary has no calendar module". */
export type CalendarAccess = 'granted' | 'denied' | 'undetermined' | 'unavailable';

/** One read: the events, or why there are none. */
export type CalendarRead =
  | { ok: true; events: CalendarEventFact[] }
  | { ok: false; reason: 'no-access' | 'unavailable' | 'error' };

/** A read that has not answered by now is abandoned, so a turn is never held up. */
export const CALENDAR_READ_TIMEOUT_MS = 2_500;

type PermissionResponse = { status?: string; granted?: boolean };
type NativeCalendar = { id?: unknown; title?: unknown };
type NativeEvent = {
  title?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  allDay?: unknown;
  location?: unknown;
  calendarId?: unknown;
  status?: unknown;
};

/** The slice of expo-calendar this module touches: reads and permission only. */
type CalendarModule = {
  getCalendarPermissions(writeOnly?: boolean): Promise<PermissionResponse>;
  requestCalendarPermissions(writeOnly?: boolean): Promise<PermissionResponse>;
  getCalendars(entityType?: string): Promise<NativeCalendar[]>;
  listEvents(calendars: string[], startDate: Date, endDate: Date): Promise<NativeEvent[]>;
};

let cached: CalendarModule | null = null;
let loaded = false;

function load(): CalendarModule | null {
  if (loaded) return cached;
  loaded = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-calendar') as Partial<CalendarModule>;
    cached =
      typeof mod.getCalendarPermissions === 'function' &&
      typeof mod.requestCalendarPermissions === 'function' &&
      typeof mod.getCalendars === 'function' &&
      typeof mod.listEvents === 'function'
        ? (mod as CalendarModule)
        : null;
  } catch {
    cached = null;
  }
  return cached;
}

function accessOf(response: PermissionResponse | null | undefined): CalendarAccess {
  if (response?.granted === true || response?.status === 'granted') return 'granted';
  if (response?.status === 'undetermined') return 'undetermined';
  return 'denied';
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('calendar read timed out')), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

/** Whether this binary carries the calendar module at all. */
export function calendarModuleAvailable(): boolean {
  return load() !== null;
}

/** ARC's calendar access as iOS reports it. Never prompts; never throws. */
export async function calendarAccess(): Promise<CalendarAccess> {
  const mod = load();
  if (!mod) return 'unavailable';
  try {
    return accessOf(await mod.getCalendarPermissions(false));
  } catch {
    return 'unavailable';
  }
}

/**
 * Ask iOS for full calendar access — the system dialog, the first time; after a
 * refusal iOS answers `denied` without asking again, and only iOS Settings can
 * change it. Called from the Settings switch only. Never throws: a binary
 * built without the usage string rejects, and that reads as `unavailable`.
 */
export async function requestCalendarAccess(): Promise<CalendarAccess> {
  const mod = load();
  if (!mod) return 'unavailable';
  try {
    return accessOf(await mod.requestCalendarPermissions(false));
  } catch {
    return 'unavailable';
  }
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value : null;
const iso = (value: unknown): string | null => {
  const raw = value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : null;
  return raw !== null && !Number.isNaN(new Date(raw).getTime()) ? raw : null;
};

/**
 * Every event on every calendar overlapping `[start, end)`, as plain facts.
 * Checks permission first and never prompts. Never throws.
 */
export async function readCalendarEvents(start: Date, end: Date): Promise<CalendarRead> {
  const mod = load();
  if (!mod) return { ok: false, reason: 'unavailable' };
  try {
    return await withTimeout(
      (async (): Promise<CalendarRead> => {
        if (accessOf(await mod.getCalendarPermissions(false)) !== 'granted') {
          return { ok: false, reason: 'no-access' };
        }
        // Every event calendar, by id — passed explicitly, because an empty id
        // list reaches EventKit as an empty calendar set rather than "all".
        const names = new Map<string, string | null>();
        for (const calendar of await mod.getCalendars('event')) {
          if (typeof calendar.id === 'string') names.set(calendar.id, text(calendar.title));
        }
        if (names.size === 0) return { ok: true, events: [] };
        const raw = await mod.listEvents([...names.keys()], start, end);
        const events: CalendarEventFact[] = [];
        for (const event of raw) {
          // iOS spells it 'cancelled' (ios/Conversions/EnumConversions.swift)
          // while the TS enum says 'canceled'; both mean the event is off.
          if (event.status === 'cancelled' || event.status === 'canceled') continue;
          const startIso = iso(event.startDate);
          if (startIso === null) continue;
          events.push({
            title: text(event.title) ?? '',
            start: startIso,
            end: iso(event.endDate) ?? startIso,
            allDay: event.allDay === true,
            location: text(event.location),
            calendar: typeof event.calendarId === 'string' ? (names.get(event.calendarId) ?? null) : null,
          });
        }
        return { ok: true, events };
      })(),
      CALENDAR_READ_TIMEOUT_MS
    );
  } catch {
    return { ok: false, reason: 'error' };
  }
}
