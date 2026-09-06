/* ============================================================
   AXE CALENDAR v1.8.0
   An RFC 5545 (iCalendar) renderer for axe.

   The axe viewer renders .ics/.ical with this engine the
   same way it renders Markdown with marked.js. It also exposes a
   Calendar class for embedding in any page.

   No dependencies, no build step, no modules. One classic script.
   Styles live in calendar.css and use axe variables only.

   Author: David M. Anderson
   Built with AI assistance (Claude, Anthropic)
   ============================================================ */

(function (global) {
'use strict';

// ============================================================
// Parser (RFC 5545, producer-agnostic)
//
// Standards only. Vendor-specific encodings (e.g. Scoutbook's
// 00:00-23:45 all-day hack) are normalized at the source that
// emits them, never here. This parser ingests compliant iCal.
// ============================================================

// Unfold folded lines, then split. RFC 5545 folds long lines with
// CRLF + a single space/tab; we also tolerate bare LF and CR.
function unfold(text) {
    return String(text)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\n[ \t]/g, '');
}

// Split on an unquoted delimiter (double-quoted param values may
// contain ; and :). Quote characters are preserved in the output.
function splitUnquoted(str, delim) {
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < str.length; i++) {
        const c = str[i];
        if (c === '"') { inQ = !inQ; cur += c; }
        else if (c === delim && !inQ) { out.push(cur); cur = ''; }
        else cur += c;
    }
    out.push(cur);
    return out;
}

// Split on an un-escaped delimiter (TEXT values escape , and ; with
// a backslash). Escape pairs are kept intact for later unescaping.
function splitUnescaped(str, delim) {
    const out = [];
    let cur = '';
    for (let i = 0; i < str.length; i++) {
        const c = str[i];
        if (c === '\\') { cur += c + (str[i + 1] || ''); i++; }
        else if (c === delim) { out.push(cur); cur = ''; }
        else cur += c;
    }
    out.push(cur);
    return out;
}

// Unescape a TEXT value: \\ \; \, and \n / \N (newline).
function unescapeText(s) {
    if (s == null) return s;
    return s.replace(/\\([\\;,nN])/g, (_, c) =>
        (c === 'n' || c === 'N') ? '\n' : c);
}

// Parse one content line into { name, params, value }.
// The first unquoted colon separates name+params from the value.
function parseContentLine(line) {
    let inQ = false, colon = -1;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') inQ = !inQ;
        else if (c === ':' && !inQ) { colon = i; break; }
    }
    if (colon === -1) return null;

    const left = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const segs = splitUnquoted(left, ';');
    const name = segs.shift().toUpperCase();

    const params = {};
    for (const seg of segs) {
        const eq = seg.indexOf('=');
        if (eq === -1) continue;
        const pname = seg.slice(0, eq).toUpperCase();
        let pval = seg.slice(eq + 1);
        if (pval.length >= 2 && pval[0] === '"' && pval[pval.length - 1] === '"') {
            pval = pval.slice(1, -1);
        }
        params[pname] = pval;
    }
    return { name, params, value };
}

// Parse a DATE or DATE-TIME property into a normalized shape.
// All-day is determined by VALUE=DATE (authoritative) or an
// 8-digit value with no time component. No vendor heuristics.
function parseDate(value, params) {
    value = (value || '').trim();
    const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z)?$/);
    if (!m) return null;

    const [, Y, Mo, D, h, mi, s, z] = m;
    const dateStr = Y + '-' + Mo + '-' + D;

    if (params.VALUE === 'DATE' || h === undefined) {
        return { date: dateStr, datetime: null, tz: null, utc: false, allDay: true };
    }
    return {
        date: null,
        datetime: dateStr + 'T' + h + ':' + mi + ':' + s,
        tz: z ? null : (params.TZID || null),
        utc: !!z,
        allDay: false
    };
}

// CATEGORIES: comma-separated, each item potentially with escaped commas.
function splitCategories(value) {
    return splitUnescaped(value, ',')
        .map(c => unescapeText(c.trim()))
        .filter(c => c.length > 0);
}

// RRULE -> object. expandRecurring() turns it into per-occurrence events
// within a visible window (see the Recurrence section below).
function parseRRule(value) {
    const rule = {};
    const listKeys = ['byday', 'bymonth', 'bymonthday', 'byyearday', 'byweekno', 'byhour', 'byminute', 'bysetpos'];
    for (const part of value.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        const k = part.slice(0, eq).toLowerCase();
        const v = part.slice(eq + 1);
        if (k === 'interval' || k === 'count') rule[k] = parseInt(v, 10);
        else if (listKeys.includes(k)) rule[k] = v.split(',');
        else rule[k] = v;
    }
    return rule;
}

function buildEvent(props, index) {
    const ev = {
        uid: null, dtstamp: null, dtstart: null, dtend: null, duration: null,
        summary: null, description: null, location: null, categories: [],
        status: null, priority: null, url: null, organizer: null, attendees: [],
        rrule: null, exdates: [], classification: null, extensions: {}
    };

    for (const { name, params, value } of props) {
        switch (name) {
            case 'UID': ev.uid = value; break;
            case 'DTSTAMP': ev.dtstamp = value; break;
            case 'DTSTART': ev.dtstart = parseDate(value, params); break;
            case 'DTEND': ev.dtend = parseDate(value, params); break;
            case 'DURATION': ev.duration = value; break;
            case 'SUMMARY': ev.summary = unescapeText(value); break;
            case 'DESCRIPTION': ev.description = unescapeText(value); break;
            case 'LOCATION': ev.location = unescapeText(value); break;
            case 'CATEGORIES': ev.categories.push(...splitCategories(value)); break;
            case 'STATUS': ev.status = value.toUpperCase(); break;
            case 'PRIORITY': {
                const n = parseInt(value, 10);
                ev.priority = isNaN(n) ? null : n;
                break;
            }
            case 'URL': ev.url = value; break;
            case 'ORGANIZER': ev.organizer = value; break;
            case 'ATTENDEE': ev.attendees.push(value); break;
            case 'RRULE': ev.rrule = parseRRule(value); break;
            case 'EXDATE':
                for (const part of value.split(',')) {
                    const d = parseDate(part.trim(), params);
                    if (d) ev.exdates.push(d.allDay ? d.date : d.datetime.slice(0, 10));
                }
                break;
            case 'CLASS': ev.classification = value.toUpperCase(); break;
            default:
                if (name.indexOf('X-') === 0) ev.extensions[name] = unescapeText(value);
                // unknown standard properties: ignored gracefully
        }
    }

    // Need a start to place the event; otherwise it cannot render.
    if (!ev.dtstart) return null;
    // UID is required by RFC but be lenient; synthesize deterministically.
    if (!ev.uid) ev.uid = 'axe-event-' + index;
    return ev;
}

// Parse iCal text -> { prodid, version, calname, events: [...] }.
function parseICal(text) {
    const lines = unfold(text).split('\n');
    const result = { prodid: null, version: null, calname: null, events: [] };

    let cur = null;       // property list of the VEVENT being read
    let skipDepth = 0;    // nested component depth to skip inside a VEVENT
    let index = 0;

    for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = parseContentLine(line);
        if (!parsed) continue;
        const { name, params, value } = parsed;

        if (name === 'BEGIN') {
            const comp = value.toUpperCase();
            if (cur) skipDepth++;                  // e.g. VALARM inside VEVENT
            else if (comp === 'VEVENT') cur = [];
            // VCALENDAR / VTIMEZONE / VTODO / ... : ignored, keep scanning
            continue;
        }
        if (name === 'END') {
            const comp = value.toUpperCase();
            if (skipDepth > 0) skipDepth--;
            else if (comp === 'VEVENT' && cur) {
                const ev = buildEvent(cur, index++);
                if (ev) result.events.push(ev);
                cur = null;
            }
            continue;
        }

        if (cur) {
            if (skipDepth === 0) cur.push({ name, params, value });
        } else {
            if (name === 'PRODID') result.prodid = value;
            else if (name === 'VERSION') result.version = value;
            else if (name === 'X-WR-CALNAME') result.calname = unescapeText(value);
        }
    }
    return result;
}


// ============================================================
// Date / timezone utilities
//
// The display zone defaults to the browser's local zone. A caller
// can override it (viewer dropdown / { timezone }). All-day events
// are zone-independent; timed events resolve to an absolute instant
// and are formatted in the chosen zone.
// ============================================================

const tz = {
    pad(n) { return String(n).padStart(2, '0'); },

    // Wall-clock components in an IANA zone -> offset (ms, east positive).
    offsetAt(utcMs, zone) {
        const dtf = new Intl.DateTimeFormat('en-US', {
            timeZone: zone, hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
        const m = {};
        for (const p of dtf.formatToParts(new Date(utcMs))) m[p.type] = p.value;
        const hour = m.hour === '24' ? 0 : +m.hour;
        const asIfUTC = Date.UTC(+m.year, +m.month - 1, +m.day, hour, +m.minute, +m.second);
        return asIfUTC - utcMs;
    },

    // Interpret Y/M/D h:m:s as wall-clock time in `zone` -> absolute Date.
    // Two-pass to settle DST transition edges.
    wallToInstant(Y, Mo, D, h, mi, s, zone) {
        const guess = Date.UTC(Y, Mo - 1, D, h, mi, s);
        let off = this.offsetAt(guess, zone);
        off = this.offsetAt(guess - off, zone);
        return new Date(guess - off);
    },

    // Y/M/D h:m components of an instant in `zone` (null zone = local).
    partsInZone(instant, zone) {
        if (!zone) {
            return {
                year: instant.getFullYear(), month: instant.getMonth() + 1,
                day: instant.getDate(), hour: instant.getHours(), minute: instant.getMinutes()
            };
        }
        const dtf = new Intl.DateTimeFormat('en-US', {
            timeZone: zone, hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit'
        });
        const m = {};
        for (const p of dtf.formatToParts(instant)) m[p.type] = p.value;
        return {
            year: +m.year, month: +m.month, day: +m.day,
            hour: m.hour === '24' ? 0 : +m.hour, minute: +m.minute
        };
    },

    dayKeyOf(p) { return p.year + '-' + this.pad(p.month) + '-' + this.pad(p.day); },

    // Stable, zone-independent label for an all-day date key.
    dayLabel(dayKey, opts) {
        const [Y, Mo, D] = dayKey.split('-').map(Number);
        const d = new Date(Date.UTC(Y, Mo - 1, D, 12));
        return new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: 'UTC' }, opts)).format(d);
    },

    addDays(dayKey, n) {
        const [Y, Mo, D] = dayKey.split('-').map(Number);
        const d = new Date(Date.UTC(Y, Mo - 1, D + n, 12));
        return d.getUTCFullYear() + '-' + this.pad(d.getUTCMonth() + 1) + '-' + this.pad(d.getUTCDate());
    },

    timeLabel(hour, minute) {
        const ampm = hour < 12 ? 'AM' : 'PM';
        let h12 = hour % 12; if (h12 === 0) h12 = 12;
        return minute === 0 ? h12 + ' ' + ampm
                            : h12 + ':' + this.pad(minute) + ' ' + ampm;
    },

    // Resolve a DTSTART/DTEND part for display in `zone`.
    resolve(part, zone) {
        if (!part) return null;
        if (part.allDay) {
            return { allDay: true, dayKey: part.date, instant: null, hour: 0, minute: 0 };
        }
        const [dp, tp] = part.datetime.split('T');
        const [Y, Mo, D] = dp.split('-').map(Number);
        const [h, mi, s] = tp.split(':').map(Number);

        let instant;
        if (part.utc) instant = new Date(Date.UTC(Y, Mo - 1, D, h, mi, s));
        else if (part.tz) instant = this.wallToInstant(Y, Mo, D, h, mi, s, part.tz);
        else if (zone) instant = this.wallToInstant(Y, Mo, D, h, mi, s, zone);
        else instant = new Date(Y, Mo - 1, D, h, mi, s);

        const p = this.partsInZone(instant, zone);
        return { allDay: false, instant, dayKey: this.dayKeyOf(p), hour: p.hour, minute: p.minute };
    },

    todayKey(zone) {
        return this.dayKeyOf(this.partsInZone(new Date(), zone));
    }
};

// First and last day an event occupies, in the display zone. All-day
// DTEND is exclusive (the day after), so the last day is end - 1.
function eventDayRange(ev, zone) {
    const start = tz.resolve(ev.dtstart, zone);
    let endKey = start.dayKey;
    if (ev.dtend) {
        const end = tz.resolve(ev.dtend, zone);
        if (ev.dtstart.allDay && ev.dtend.allDay) {
            endKey = tz.addDays(end.dayKey, -1);
            if (endKey < start.dayKey) endKey = start.dayKey;
        } else {
            endKey = end.dayKey;
        }
    }
    return { startKey: start.dayKey, endKey, start };
}

// Sortable key for an event's start (all-day sorts to start of day).
function startSortKey(ev, zone) {
    const r = tz.resolve(ev.dtstart, zone);
    if (r.allDay) {
        const [Y, Mo, D] = r.dayKey.split('-').map(Number);
        return Date.UTC(Y, Mo - 1, D, 0, 0, 0);
    }
    return r.instant.getTime();
}


// ============================================================
// Recurrence (RRULE) expansion
//
// A recurring event is replaced, for a given visible window, by one plain
// event per occurrence. Handles the common cases: FREQ DAILY / WEEKLY /
// MONTHLY / YEARLY with INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH,
// WKST, and EXDATE exclusions. Exotic combinations (BYSETPOS, BYWEEKNO,
// BYYEARDAY) degrade to the base pattern. All date math is on Y-M-D keys; the
// occurrence keeps the event's time-of-day and duration.
// ============================================================

var WD_INDEX = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function daysBetween(aKey, bKey) {
    const [ay, am, ad] = aKey.split('-').map(Number);
    const [by, bm, bd] = bKey.split('-').map(Number);
    return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// The ord-th weekday wd (0=Sun..6=Sat) in month (Y, M). ord<0 counts from end.
function nthWeekdayOfMonth(Y, M, wd, ord) {
    const dim = daysInMonth(Y, M);
    const days = [];
    for (let d = 1; d <= dim; d++) {
        const k = Y + '-' + tz.pad(M) + '-' + tz.pad(d);
        if (weekdayOf(k) === wd) days.push(k);
    }
    return ord > 0 ? (days[ord - 1] || null) : (days[days.length + ord] || null);
}

// Day keys in month (Y, M) matching a MONTHLY rule's BY parts.
function monthlyDatesFor(Y, M, rule, seedKey) {
    const dim = daysInMonth(Y, M);
    const mk = (d) => Y + '-' + tz.pad(M) + '-' + tz.pad(d);
    const keys = [];

    if (rule.bymonthday && rule.bymonthday.length) {
        for (const s of rule.bymonthday) {
            let d = parseInt(s, 10);
            if (d < 0) d = dim + d + 1;             // -1 = last day
            if (d >= 1 && d <= dim) keys.push(mk(d));
        }
    } else if (rule.byday && rule.byday.length) {
        for (const tok of rule.byday) {
            const m = tok.match(/^([+-]?\d+)?([A-Z]{2})$/);
            if (!m) continue;
            const wd = WD_INDEX[m[2]];
            if (wd == null) continue;
            if (m[1]) { const k = nthWeekdayOfMonth(Y, M, wd, parseInt(m[1], 10)); if (k) keys.push(k); }
            else for (let d = 1; d <= dim; d++) if (weekdayOf(mk(d)) === wd) keys.push(mk(d));
        }
    } else {
        const d = +seedKey.slice(8, 10);
        if (d <= dim) keys.push(mk(d));             // skip months lacking that day (RFC)
    }
    return keys.sort();
}

// Day keys in year Y matching a YEARLY rule's BY parts.
function yearlyDatesFor(Y, rule, seedKey) {
    const months = (rule.bymonth && rule.bymonth.length)
        ? rule.bymonth.map(s => parseInt(s, 10))
        : [+seedKey.slice(5, 7)];
    const keys = [];
    for (const M of months) {
        if (M < 1 || M > 12) continue;
        // Reuse the monthly logic per month, but fall back to the seed day.
        const sub = (rule.bymonthday && rule.bymonthday.length) || (rule.byday && rule.byday.length)
            ? monthlyDatesFor(Y, M, rule, seedKey)
            : (function () {
                const dim = daysInMonth(Y, M), d = +seedKey.slice(8, 10);
                return d <= dim ? [Y + '-' + tz.pad(M) + '-' + tz.pad(d)] : [];
            })();
        for (const k of sub) keys.push(k);
    }
    return keys.sort();
}

// Chronological occurrence day keys from the seed up to hardStopKey (inclusive),
// capped at `count` occurrences if set. Caller applies range + EXDATE filters.
function generateOccurrences(rule, seedKey, hardStopKey, count) {
    const freq = (rule.freq || '').toUpperCase();
    const interval = Math.max(1, rule.interval || 1);
    const CAP = 3000;
    const out = [];
    const push = (k) => { out.push(k); return !(count && out.length >= count); };

    if (freq === 'DAILY') {
        let k = seedKey;
        while (k <= hardStopKey && out.length < CAP) {
            if (!push(k)) break;
            k = tz.addDays(k, interval);
        }
    } else if (freq === 'WEEKLY') {
        const wkst = WD_INDEX[rule.wkst] != null ? WD_INDEX[rule.wkst] : 1;
        const days = (rule.byday && rule.byday.length)
            ? rule.byday.map(d => WD_INDEX[d.replace(/^[-+]?\d+/, '')]).filter(n => n != null)
            : [weekdayOf(seedKey)];
        days.sort((a, b) => ((a - wkst + 7) % 7) - ((b - wkst + 7) % 7));
        let weekStart = tz.addDays(seedKey, -((weekdayOf(seedKey) - wkst + 7) % 7));
        wloop:
        while (weekStart <= hardStopKey && out.length < CAP) {
            for (const wd of days) {
                const dk = tz.addDays(weekStart, (wd - wkst + 7) % 7);
                if (dk < seedKey || dk > hardStopKey) continue;
                if (!push(dk)) break wloop;
            }
            weekStart = tz.addDays(weekStart, 7 * interval);
        }
    } else if (freq === 'MONTHLY') {
        let Y = +seedKey.slice(0, 4), M = +seedKey.slice(5, 7), g = 0;
        mloop:
        while (g++ < CAP) {
            if ((Y + '-' + tz.pad(M) + '-01') > hardStopKey) break;
            for (const dk of monthlyDatesFor(Y, M, rule, seedKey)) {
                if (dk < seedKey || dk > hardStopKey) continue;
                if (!push(dk)) break mloop;
            }
            M += interval; while (M > 12) { M -= 12; Y++; }
        }
    } else if (freq === 'YEARLY') {
        let Y = +seedKey.slice(0, 4), g = 0;
        yloop:
        while (g++ < CAP) {
            if ((Y + '-12-31') < seedKey) { Y += interval; continue; }
            if ((Y + '-01-01') > hardStopKey) break;
            for (const dk of yearlyDatesFor(Y, rule, seedKey)) {
                if (dk < seedKey || dk > hardStopKey) continue;
                if (!push(dk)) break yloop;
            }
            Y += interval;
        }
    } else {
        out.push(seedKey);   // unknown / no FREQ: just the seed occurrence
    }
    return out;
}

// Shallow clone of `ev` moved to a new start day, preserving time + duration.
function cloneOccurrence(ev, occKey, timePart, dayDelta, endTimePart, hasEnd) {
    const o = Object.assign({}, ev);
    o.rrule = null;
    o.dtstart = ev.dtstart.allDay
        ? { date: occKey, datetime: null, tz: null, utc: false, allDay: true }
        : { date: null, datetime: occKey + 'T' + timePart, tz: ev.dtstart.tz, utc: ev.dtstart.utc, allDay: false };
    if (hasEnd) {
        const endKey = tz.addDays(occKey, dayDelta);
        o.dtend = ev.dtend.allDay
            ? { date: endKey, datetime: null, tz: null, utc: false, allDay: true }
            : { date: null, datetime: endKey + 'T' + endTimePart, tz: ev.dtend.tz, utc: ev.dtend.utc, allDay: false };
    }
    return o;
}

function expandOne(ev, rangeStartKey, rangeEndKey) {
    const ds = ev.dtstart;
    const seedKey = ds.allDay ? ds.date : ds.datetime.slice(0, 10);
    const timePart = ds.allDay ? null : ds.datetime.slice(11);

    let dayDelta = 0, endTimePart = null;
    if (ev.dtend) {
        const deKey = ev.dtend.allDay ? ev.dtend.date : ev.dtend.datetime.slice(0, 10);
        dayDelta = daysBetween(seedKey, deKey);
        endTimePart = ev.dtend.allDay ? null : ev.dtend.datetime.slice(11);
    }

    const rule = ev.rrule;
    const u = rule.until;
    const untilKey = u ? u.slice(0, 4) + '-' + u.slice(4, 6) + '-' + u.slice(6, 8) : null;
    const hardStop = (untilKey && untilKey < rangeEndKey) ? untilKey : rangeEndKey;

    const exset = new Set(ev.exdates || []);
    const out = [];
    for (const k of generateOccurrences(rule, seedKey, hardStop, rule.count || null)) {
        if (exset.has(k)) continue;                      // EXDATE removes the instance
        // Keep an occurrence when it OVERLAPS the window, not only when its
        // start falls inside: a multi-day occurrence (a repeating campout) can
        // begin the day before rangeStart yet still ride into view.
        const occEndKey = dayDelta > 0 ? tz.addDays(k, dayDelta) : k;
        if (occEndKey < rangeStartKey || k > rangeEndKey) continue;
        out.push(cloneOccurrence(ev, k, timePart, dayDelta, endTimePart, !!ev.dtend));
    }
    return out;
}

// Replace recurring events with their occurrences in [rangeStartKey,
// rangeEndKey]; non-recurring events pass through unchanged.
function expandRecurring(events, rangeStartKey, rangeEndKey) {
    const out = [];
    for (const ev of events) {
        if (!ev.rrule || !ev.dtstart) { out.push(ev); continue; }
        for (const o of expandOne(ev, rangeStartKey, rangeEndKey)) out.push(o);
    }
    return out;
}


// ============================================================
// DOM helpers
// ============================================================

// Escape for both element text and double-quoted attribute values: linkify
// builds href="..." out of escaped event text, so " and ' must be escaped too
// or a quote in a feed's URL/description breaks out of the attribute.
function escHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function elem(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

// A feed's URL: field is untrusted. Only return it for an href when it carries
// a benign scheme; otherwise null, so 'javascript:...' can never become a
// clickable script link in this origin. Relative URLs (no scheme) are allowed.
function safeUrl(url) {
    if (url == null) return null;
    const s = String(url).trim();
    let scheme;
    try {
        scheme = new URL(s, 'https://x.invalid/').protocol;
    } catch (e) {
        return null;
    }
    // Same base means the input was relative (no scheme of its own) — allow it.
    const isRelative = !/^[a-z][a-z0-9+.-]*:/i.test(s);
    if (isRelative) return s;
    return ['http:', 'https:', 'mailto:'].includes(scheme) ? s : null;
}

// Deterministic hue for a category, so chips are color-coded but
// stable. Color is never the only signal — the label rides along.
function categoryHue(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return h;
}

function statusClass(status) {
    if (status === 'CANCELLED') return 'is-cancelled';
    if (status === 'TENTATIVE') return 'is-tentative';
    return '';
}


// ============================================================
// List view (secondary)
//
// Events grouped by day, ascending. Each row: time / all-day,
// summary, category chips, optional description, status. Past
// days de-emphasized; today marked.
// ============================================================

// Events (not days) to show before today on first paint, and per lazy batch
// as the user scrolls. Counting events rather than days keeps the window
// useful when a feed is sparse (e.g. one event a month).
const LIST_PAST_INITIAL = 10;
const LIST_BATCH = 20;

function buildDayGroup(dayKey, dayEvents, todayKey, zone, cal) {
    const section = elem('section', 'cal-day');
    if (dayKey === todayKey) section.classList.add('is-today');
    else if (dayKey < todayKey) section.classList.add('is-past');

    const heading = elem('h3', 'cal-day-label');
    const time = elem('time', null, tz.dayLabel(dayKey, { weekday: 'long', month: 'long', day: 'numeric' }));
    time.setAttribute('datetime', dayKey);
    heading.appendChild(time);
    if (dayKey === todayKey) heading.appendChild(elem('span', 'cal-today-tag tag', 'Today'));
    section.appendChild(heading);

    for (const ev of dayEvents) section.appendChild(renderListEvent(ev, zone, cal));
    return section;
}

// Run fn once after the browser has had a chance to lay out — normally the
// next animation frame. requestAnimationFrame is paused in background tabs and
// in headless browsers, so a short timeout backstops it; whichever fires first
// wins. The list's settle (scroll-to-anchor) rides on this, so a date jump in a
// background tab still lands where it should.
function afterLayout(fn) {
    let ran = false;
    const run = () => { if (ran) return; ran = true; fn(); };
    if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(run);
    setTimeout(run, 32);
}

function renderList(events, container, cal) {
    container.classList.add('cal-list-fill');

    const zone = cal.timezone;
    const today = tz.todayKey(zone);

    // Expand recurring across a generous window; we render only a slice of
    // this in-memory list and extend it as the user scrolls (no refetch).
    const expanded = expandRecurring(events, tz.addDays(today, -366), tz.addDays(today, 366));

    const wrap = elem('div', 'cal-list');
    container.appendChild(wrap);

    if (!expanded.length) {
        wrap.appendChild(elem('p', 'cal-empty', 'No events.'));
        return;
    }

    // Sort, then group into an ordered array of [dayKey, events].
    const sorted = expanded.slice().sort((a, b) => startSortKey(a, zone) - startSortKey(b, zone));
    const groupsMap = new Map();
    for (const ev of sorted) {
        const key = eventDayRange(ev, zone).startKey;
        if (!groupsMap.has(key)) groupsMap.set(key, []);
        groupsMap.get(key).push(ev);
    }
    const days = Array.from(groupsMap.entries());   // [ [dayKey, [ev,...]], ... ]

    // Anchor on the date-picker's month if set, else today / first upcoming
    // day; if all events are past, anchor on the most recent day. The
    // is-today / is-past marking always uses the real today.
    //
    // The Today arrow points toward the day the Today button lands on — today,
    // or the next upcoming day when today itself has no events — and hides when
    // that day is on screen, regardless of any date-picker anchor. (Comparing
    // the literal date instead would leave the arrow up after a Today click,
    // since today sits above the next event it scrolled to.)
    const todayTargetIdx = days.findIndex(([k]) => k >= today);
    cal._listToday = todayTargetIdx === -1 ? days[days.length - 1][0]
                                           : days[todayTargetIdx][0];
    const anchorKey = cal._listAnchor || today;
    let anchorIdx = days.findIndex(([k]) => k >= anchorKey);
    const allPast = anchorIdx === -1;
    if (allPast) anchorIdx = days.length - 1;

    // Sentinels bracket a live content node; lazy-loading inserts day groups
    // into the content node and watches the sentinels.
    const topSentinel = elem('div', 'cal-sentinel');
    const content = elem('div', 'cal-list-content');
    const botSentinel = elem('div', 'cal-sentinel');
    wrap.appendChild(topSentinel);
    wrap.appendChild(content);
    wrap.appendChild(botSentinel);

    // Initial past: walk back from the anchor over whole days until
    // LIST_PAST_INITIAL events are covered, so a sparse feed still shows
    // real history rather than a near-empty 30-day window.
    let startIdx = anchorIdx, pastCount = 0;
    while (startIdx > 0 && pastCount < LIST_PAST_INITIAL) {
        startIdx--;
        pastCount += days[startIdx][1].length;
    }
    let endIdx = anchorIdx;   // inclusive bounds of what's currently rendered

    for (let i = startIdx; i <= endIdx; i++) {
        content.appendChild(buildDayGroup(days[i][0], days[i][1], today, zone, cal));
    }
    const anchorSection = content.lastChild;   // the anchor day's section

    // --- lazy loading, by event count -------------------------------
    function prependBatch() {
        if (startIdx <= 0) return;
        const before = container.scrollHeight;
        const frag = document.createDocumentFragment();
        let added = 0;
        while (startIdx > 0 && added < LIST_BATCH) {
            startIdx--;
            const [k, evs] = days[startIdx];
            frag.insertBefore(buildDayGroup(k, evs, today, zone, cal), frag.firstChild);
            added += evs.length;
        }
        content.insertBefore(frag, content.firstChild);
        container.scrollTop += container.scrollHeight - before;   // hold the viewport steady
        if (startIdx <= 0 && cal._listObserver) cal._listObserver.unobserve(topSentinel);
    }
    function appendBatch() {
        if (endIdx >= days.length - 1) return;
        let added = 0;
        while (endIdx + 1 < days.length && added < LIST_BATCH) {
            endIdx++;
            const [k, evs] = days[endIdx];
            content.appendChild(buildDayGroup(k, evs, today, zone, cal));
            added += evs.length;
        }
        if (endIdx >= days.length - 1 && cal._listObserver) cal._listObserver.unobserve(botSentinel);
    }

    function attachObservers() {
        if (typeof IntersectionObserver === 'undefined') {
            // No IntersectionObserver: render the rest so nothing is hidden.
            while (startIdx > 0) {
                startIdx--;
                content.insertBefore(buildDayGroup(days[startIdx][0], days[startIdx][1], today, zone, cal), content.firstChild);
            }
            while (endIdx + 1 < days.length) {
                endIdx++;
                content.appendChild(buildDayGroup(days[endIdx][0], days[endIdx][1], today, zone, cal));
            }
            return;
        }
        const obs = new IntersectionObserver((entries) => {
            for (const e of entries) {
                if (!e.isIntersecting) continue;
                if (e.target === topSentinel) prependBatch();
                else if (e.target === botSentinel) appendBatch();
            }
        }, { root: container, rootMargin: '600px 0px' });
        cal._listObserver = obs;
        if (startIdx > 0) obs.observe(topSentinel);
        if (endIdx < days.length - 1) obs.observe(botSentinel);
    }

    // Measure-fill-scroll-observe must wait for layout: the flex container has
    // no resolved height during the synchronous render pass, so offsetTop and
    // clientHeight would read 0. Defer one frame, then fill the initial future,
    // pin the anchor, and only then watch the sentinels (so they don't all fire
    // against an unscrolled list and cascade-load everything).
    function settle(tries) {
        tries = tries || 0;
        // Bail if a newer render has replaced this list (stale closure): a
        // re-render (resize, view switch, date jump) detaches our wrap, and a
        // late settle must not append to / scroll the orphaned tree.
        if (!wrap.isConnected) return;
        // Wait for layout: right after a re-render the flex body can report
        // clientHeight 0, which would skip the 2-screen fill and clamp the
        // anchor scroll. Retry a few frames until it has a height.
        if (!container.clientHeight && tries < 10) {
            afterLayout(() => settle(tries + 1));
            return;
        }
        const anchorTop = anchorSection ? anchorSection.offsetTop : 0;
        while (endIdx + 1 < days.length &&
               container.scrollHeight - anchorTop < 2 * container.clientHeight) {
            endIdx++;
            content.appendChild(buildDayGroup(days[endIdx][0], days[endIdx][1], today, zone, cal));
        }
        container.scrollTop = allPast ? container.scrollHeight
                                      : (anchorSection ? anchorSection.offsetTop : 0);
        attachObservers();
        listSyncOnScroll(cal);              // initial title + Today-direction
    }

    // The title and Today arrow track scroll position (rAF-throttled). The
    // Today button re-renders anchored at today (list view object), so no
    // scroll-to closure is needed here.
    let scrollScheduled = false;
    cal._listScroll = function () {
        if (scrollScheduled) return;
        scrollScheduled = true;
        requestAnimationFrame(function () { scrollScheduled = false; listSyncOnScroll(cal); });
    };
    container.addEventListener('scroll', cal._listScroll, { passive: true });

    afterLayout(() => settle(0));
}

function renderListEvent(ev, zone, cal) {
    const range = eventDayRange(ev, zone);
    const art = elem('article', 'cal-event' + (statusClass(ev.status) ? ' ' + statusClass(ev.status) : ''));
    if (ev.categories.length) art.style.setProperty('--cat-hue', categoryHue(ev.categories[0]));
    else art.classList.add('is-plain');

    // Time / all-day label (gutter), plus an optional multi-day span line.
    let when, spanLabel = null;
    if (ev.dtstart.allDay) {
        when = 'All day';
        if (range.endKey !== range.startKey) {
            spanLabel = tz.dayLabel(range.startKey, { month: 'short', day: 'numeric' })
                + ' – ' + tz.dayLabel(range.endKey, { month: 'short', day: 'numeric' });
        }
    } else {
        when = tz.timeLabel(range.start.hour, range.start.minute);
        if (ev.dtend) {
            const end = tz.resolve(ev.dtend, zone);
            if (end && end.dayKey === range.startKey) {
                when += ' – ' + tz.timeLabel(end.hour, end.minute);
            } else if (end) {
                spanLabel = 'Until ' + tz.dayLabel(end.dayKey, { month: 'short', day: 'numeric' })
                    + ', ' + tz.timeLabel(end.hour, end.minute);
            }
        }
    }
    art.appendChild(elem('div', 'cal-event-time', when));

    const body = elem('div', 'cal-event-body');

    const titleRow = elem('div', 'cal-event-title');
    const summary = elem('span', 'cal-event-summary', ev.summary || '(untitled)');
    const href = safeUrl(ev.url);
    if (href) {
        const link = elem('a', null, ev.summary || '(untitled)');
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener';
        titleRow.appendChild(link);
    } else {
        titleRow.appendChild(summary);
    }
    body.appendChild(titleRow);

    if (spanLabel) body.appendChild(elem('div', 'cal-event-span', spanLabel));
    if (ev.location) body.appendChild(elem('div', 'cal-event-location', ev.location));

    if (ev.categories.length) {
        const chips = elem('div', 'cal-chips');
        for (const c of ev.categories) {
            const chip = elem('span', 'cal-chip', c);
            chip.style.setProperty('--cat-hue', categoryHue(c));
            chips.appendChild(chip);
        }
        body.appendChild(chips);
    }

    if (ev.description) {
        const desc = elem('p', 'cal-event-desc');
        desc.textContent = ev.description;
        if (ev.description.length > 140) {
            desc.classList.add('is-clamped');
            desc.title = 'Click to expand';
            desc.addEventListener('click', () => desc.classList.toggle('is-clamped'));
        }
        body.appendChild(desc);
    }

    art.appendChild(body);
    return art;
}


// ============================================================
// Month grid view (default)
//
// Microsoft-Teams / Google-style month: a header with prev/next/
// Today nav, a weekday strip, then week rows. Each week row is a
// 7-column CSS grid. Single-day events are 1-column chips; multi-day
// events are TRUE spanning bars that cross day columns and break into
// one segment per week row at week boundaries.
//
// Below the narrow breakpoint the month collapses to a day-stacked
// list for the visible month (the grid can't span columns at 1-wide).
// ============================================================

// Visible lanes per week before events collapse into "+N more".
var MONTH_MAX_LANES = 3;
// Viewport width (px) below which the month falls back to a day stack.
var MONTH_NARROW_PX = 560;

function daysInMonth(year, month /* 1-based */) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// 0 = Sunday … 6 = Saturday, for an all-day day key. UTC noon avoids
// any DST edge shifting the weekday.
function weekdayOf(dayKey) {
    const [Y, Mo, D] = dayKey.split('-').map(Number);
    return new Date(Date.UTC(Y, Mo - 1, D, 12)).getUTCDay();
}

function shiftMonth(cur, delta) {
    let y = cur.year, m = cur.month + delta;
    while (m < 1) { m += 12; y--; }
    while (m > 12) { m -= 12; y++; }
    return { year: y, month: m };
}

// === Week event layout: spanning bars + greedy lane packing ===
//
// Within one week row the seven days are columns 0..6. Every event that
// intersects the week becomes a SEGMENT occupying a contiguous column
// range [c0..c1] — a single-day event has c0 === c1, a multi-day event a
// wider range, clipped to [0..6] at week boundaries. Segments stack into
// horizontal LANES (the rows beneath the date numbers) such that no two
// segments in the same lane overlap in columns, and one multi-day bar
// keeps a SINGLE lane across every day it spans in that week.
//
// Algorithm — greedy interval-graph coloring, lowest-lane-first:
//   1. Build the week's segments, clipping each event range to [0..6].
//   2. Sort so longer bars claim the top lanes and ties stay stable:
//      span length desc, then c0 asc, then start instant asc, then uid.
//   3. For each segment, scan lanes from 0 upward and place it in the
//      first lane whose columns c0..c1 are ALL free; mark them occupied.
//      occ[lane][col] is a boolean grid; this is O(segs · lanes · span),
//      trivial at month scale and identical in spirit to Google/Teams.
//   4. Lanes >= MONTH_MAX_LANES are not drawn; each day they cover adds
//      one to that day's "+N more" count.
//
// Generalized to any column count so the Day/Week all-day strips reuse it
// (1 and 7 columns); the month grid passes 7.
function packSegs(segs, ncols) {
    segs.sort((a, b) =>
        (b.c1 - b.c0) - (a.c1 - a.c0) ||
        a.c0 - b.c0 ||
        a.sortKey - b.sortKey ||
        (a.ev.uid < b.ev.uid ? -1 : 1));

    const occ = [];   // occ[lane] = boolean[ncols]
    for (const seg of segs) {
        let lane = 0;
        for (;;) {
            if (!occ[lane]) occ[lane] = new Array(ncols).fill(false);
            let free = true;
            for (let c = seg.c0; c <= seg.c1 && free; c++) if (occ[lane][c]) free = false;
            if (free) {
                for (let c = seg.c0; c <= seg.c1; c++) occ[lane][c] = true;
                seg.lane = lane;
                break;
            }
            lane++;
        }
    }
    return segs;
}

// Clip an event's [startKey..endKey] span to a run of day keys (a month week,
// or the Day/Week visible window). Returns null if it doesn't touch the run.
function clipToDays(startKey, endKey, dayKeys) {
    const ws = dayKeys[0], we = dayKeys[dayKeys.length - 1];
    if (endKey < ws || startKey > we) return null;
    const c0 = startKey <= ws ? 0 : dayKeys.indexOf(startKey);
    const c1 = endKey >= we ? dayKeys.length - 1 : dayKeys.indexOf(endKey);
    return { c0, c1, clipStart: startKey < ws, clipEnd: endKey > we };
}

function barLabel(ev, seg, zone) {
    const title = ev.summary || '(untitled)';
    if (ev.dtstart.allDay) return title;

    const multiDay = seg.c1 > seg.c0 || seg.clipStart || seg.clipEnd;
    if (!multiDay) {                       // single-day timed chip: start time only
        const r = tz.resolve(ev.dtstart, zone);
        return tz.timeLabel(r.hour, r.minute) + ' ' + title;
    }

    // Multi-day timed bar: the start time prefixes only the segment that holds
    // the real start (not a continuation), and the end time is appended only on
    // the segment that holds the real end — so a Fri→Sun campout reads
    // "5 PM San Marcos Campout" on Friday and "San Marcos Campout · ends 1 PM"
    // on Sunday.
    let label = title;
    if (!seg.clipStart) {
        const s = tz.resolve(ev.dtstart, zone);
        label = tz.timeLabel(s.hour, s.minute) + ' ' + label;
    }
    if (!seg.clipEnd && ev.dtend) {
        const e = tz.resolve(ev.dtend, zone);
        label = label + ' · ends ' + tz.timeLabel(e.hour, e.minute);
    }
    return label;
}

function makeBar(ev, seg, zone, cal, rowBase) {
    // A single-day timed event renders as a transparent dot+time chip; all-day
    // events AND multi-day events (timed or not) render as a filled bar, so a
    // campout that runs Fri–Sun actually looks like it spans. "Multi-day"
    // includes a segment that continues into an adjacent week (clipStart/End).
    const continues = seg.clipStart || seg.clipEnd;
    const multiDay = seg.c1 > seg.c0 || continues;
    const isChip = !ev.dtstart.allDay && !multiDay;

    const bar = elem('button', 'cal-bar' + (isChip ? ' is-timed' : ''));
    if (seg.clipStart) bar.classList.add('clip-start');
    if (seg.clipEnd) bar.classList.add('clip-end');
    const sc = statusClass(ev.status);
    if (sc) bar.classList.add(sc);

    if (ev.categories.length) bar.style.setProperty('--cat-hue', categoryHue(ev.categories[0]));
    else bar.classList.add('is-plain');

    bar.style.gridColumn = (seg.c0 + 1) + ' / ' + (seg.c1 + 2);
    bar.style.gridRow = String(seg.lane + (rowBase == null ? 2 : rowBase));
    bar.textContent = barLabel(ev, seg, zone);
    bar.title = bar.textContent + (ev.location ? ' · ' + ev.location : '');
    bar.addEventListener('click', () => cal._handleEventClick(ev, bar));
    return bar;
}

function renderMonth(events, container, cal) {
    closePopover(cal);
    const zone = cal.timezone;

    const cur = monthCursor(cal);

    // --- grid geometry -----------------------------------------
    const weekStart = (cal.opts.weekStart != null) ? cal.opts.weekStart : 0; // 0 = Sunday
    const firstKey = cur.year + '-' + tz.pad(cur.month) + '-01';
    const offset = (weekdayOf(firstKey) - weekStart + 7) % 7;
    const gridStart = tz.addDays(firstKey, -offset);
    const numWeeks = Math.ceil((offset + daysInMonth(cur.year, cur.month)) / 7);

    // Narrow fallback: the spanning-bar grid needs 7 columns, so below
    // the breakpoint we render the visible month as a day stack instead.
    const narrow = typeof window !== 'undefined' && window.innerWidth < MONTH_NARROW_PX;
    if (narrow) {
        renderMonthStack(events, container, cal);
        return;
    }

    // Wide grid fills the container's height (Teams-style); the weeks
    // grow to share it and the visible-lane cap scales to the cell height.
    container.classList.add('cal-month-fill');

    // Today drives the date badge, the single today-cell highlight, and an
    // accent on today's weekday header — but NOT a tint down the whole column
    // of cells (that read as noise). todayCol is only set when today is in view.
    const todayKey = tz.todayKey(zone);
    const gridEndKey = tz.addDays(gridStart, numWeeks * 7 - 1);
    const todayInView = todayKey >= gridStart && todayKey <= gridEndKey;
    const todayCol = todayInView ? ((weekdayOf(todayKey) - weekStart + 7) % 7) : -1;

    // --- weekday strip -----------------------------------------
    const strip = elem('div', 'cal-weekdays');
    for (let i = 0; i < 7; i++) {
        const wd = elem('span', 'cal-weekday eyebrow',
            tz.dayLabel(tz.addDays(gridStart, i), { weekday: 'short' }));
        if (i === todayCol) wd.classList.add('is-today');
        strip.appendChild(wd);
    }
    container.appendChild(strip);

    // Expand recurring events into the visible grid, then precompute each
    // event's day range once, in the display zone.
    const gridEvents = expandRecurring(events, gridStart, gridEndKey);
    const ranges = gridEvents.map(ev => {
        const r = eventDayRange(ev, zone);
        return { ev, startKey: r.startKey, endKey: r.endKey, sortKey: startSortKey(ev, zone) };
    });

    // Append the grid empty and MEASURE the height flex actually gave it,
    // then size the lane count to fit exactly. Measuring the real grid box
    // (rather than estimating from clientHeight) avoids the rounding
    // overshoot that produced a scrollbar. Falls back to the default for an
    // auto-height embed. The trailing 1fr row in each week absorbs slack.
    const grid = elem('div', 'cal-grid');
    container.appendChild(grid);

    const GAP = 1, DATE_ROW_PX = 28, LANE_PX = 22;   // 1.7rem / 1.4rem at 16px
    const gridH = grid.clientHeight;
    let visibleLanes = MONTH_MAX_LANES;
    if (gridH > 200) {
        const perWeek = (gridH - (numWeeks - 1) * GAP) / numWeeks;
        visibleLanes = Math.max(1, Math.min(12,
            Math.floor((perWeek - DATE_ROW_PX - GAP) / (LANE_PX + GAP))));
    }
    const rowTemplate = '1.7rem repeat(' + visibleLanes + ', 1.4rem) minmax(0, 1fr)';

    for (let w = 0; w < numWeeks; w++) {
        const weekKeys = [];
        for (let d = 0; d < 7; d++) weekKeys.push(tz.addDays(gridStart, w * 7 + d));

        const weekEl = elem('div', 'cal-week');
        weekEl.style.gridTemplateRows = rowTemplate;

        // Background cells (full week-row height) + date numbers.
        for (let c = 0; c < 7; c++) {
            const dayKey = weekKeys[c];
            const inMonth = (+dayKey.slice(5, 7) === cur.month);
            const cell = elem('div', 'cal-cell');
            if (!inMonth) cell.classList.add('is-outside');
            if (dayKey === todayKey) cell.classList.add('is-today');
            cell.style.gridColumn = String(c + 1);
            cell.style.gridRow = '1 / -1';
            weekEl.appendChild(cell);

            // Date label: the day number in a span (so today's circular badge
            // hugs it), prefixed with the month name on the 1st of any month
            // and on the first grid cell — "Jul 1" / "May 31".
            const dayNum = +dayKey.slice(8, 10);
            const date = elem('div', 'cal-date');
            if (!inMonth) date.classList.add('is-outside');
            if (dayNum === 1 || (w === 0 && c === 0)) {
                date.appendChild(document.createTextNode(tz.dayLabel(dayKey, { month: 'short' }) + ' '));
            }
            const num = elem('span', 'cal-date-num', String(dayNum));
            if (dayKey === todayKey) num.classList.add('is-today');
            date.appendChild(num);
            date.style.gridColumn = String(c + 1);
            date.style.gridRow = '1';
            weekEl.appendChild(date);
        }

        // Build, pack, and draw this week's segments.
        const segs = [];
        for (const r of ranges) {
            const clip = clipToDays(r.startKey, r.endKey, weekKeys);
            if (clip) segs.push(Object.assign({ ev: r.ev, sortKey: r.sortKey }, clip));
        }
        packSegs(segs, 7);

        const more = [0, 0, 0, 0, 0, 0, 0];
        for (const seg of segs) {
            if (seg.lane < visibleLanes) {
                weekEl.appendChild(makeBar(seg.ev, seg, zone, cal));
            } else {
                for (let c = seg.c0; c <= seg.c1; c++) more[c]++;
            }
        }
        for (let c = 0; c < 7; c++) {
            if (!more[c]) continue;
            const m = elem('button', 'cal-more', '+' + more[c] + ' more');
            m.style.gridColumn = String(c + 1);
            m.style.gridRow = String(visibleLanes + 2);
            const dayKey = weekKeys[c];
            m.addEventListener('click', (e) => { e.stopPropagation(); openDayPopover(cal, dayKey, ranges, m); });
            weekEl.appendChild(m);
        }

        grid.appendChild(weekEl);
    }
}

// Narrow-screen month: a day-grouped stack for the visible weeks.
// Narrow fallback for the month grid: the events of one month as a day-grouped
// list, top to bottom. Unlike the List view (an infinite, today-anchored feed),
// this is bounded to the displayed month — recurrence is expanded only within
// the month window and only in-month days are emitted, so it reads as a clean
// single month with no leading/trailing grid-padding days and no out-of-month
// occurrences of a recurring series. (The wide grid keeps those, as outside-day
// cells and spanning bars; this is the small-screen stand-in.)
function renderMonthStack(events, container, cal) {
    container.classList.add('cal-list-fill');
    const zone = cal.timezone;
    const cur = monthCursor(cal);
    const monthStart = cur.year + '-' + tz.pad(cur.month) + '-01';
    const monthEnd = cur.year + '-' + tz.pad(cur.month) + '-' + tz.pad(daysInMonth(cur.year, cur.month));
    const today = tz.todayKey(zone);

    const wrap = elem('div', 'cal-list');
    container.appendChild(wrap);

    const groups = new Map();
    for (const ev of expandRecurring(events, monthStart, monthEnd)) {
        const key = eventDayRange(ev, zone).startKey;
        if (key < monthStart || key > monthEnd) continue;   // keep every day in-month
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(ev);
    }

    if (!groups.size) {
        wrap.appendChild(elem('p', 'cal-empty', 'No events this month.'));
        return;
    }

    for (const key of Array.from(groups.keys()).sort()) {
        const evs = groups.get(key).sort((a, b) => startSortKey(a, zone) - startSortKey(b, zone));
        wrap.appendChild(buildDayGroup(key, evs, today, zone, cal));
    }
}


// ============================================================
// Day & Week views (time grid)
//
// One vertical hour grid per visible day: 24 hour rows, timed events placed
// absolutely by start/end, overlapping events split into side-by-side columns.
// All-day and multi-day events ride a header strip above the grid (the same
// lane-packed bars the month uses). A live line marks the current time on
// today's column. Day = 1 column, Week = 7 — the same renderer with a
// different day list. Wheel scrolls the hours natively (navModel 'scroll');
// prev/next page the day or week, on the horizontal nav axis (‹ ›).
// ============================================================

var HOUR_PX = 48;                  // pixel height of one hour
var TG_DEFAULT_HOUR = 7;           // scroll target when today's "now" isn't shown

function dayCursor(cal) {
    if (!cal._dayCursor) cal._dayCursor = tz.todayKey(cal.timezone);
    return cal._dayCursor;
}

function weekStartOf(cal) {
    return (cal.opts.weekStart != null) ? cal.opts.weekStart : 0;   // 0 = Sunday
}

// The 7 day keys of the week containing dayKey, honoring weekStart.
function weekKeysFor(dayKey, weekStart) {
    const off = (weekdayOf(dayKey) - weekStart + 7) % 7;
    const start = tz.addDays(dayKey, -off);
    const keys = [];
    for (let i = 0; i < 7; i++) keys.push(tz.addDays(start, i));
    return keys;
}

// "Jun 8 – 14, 2026" / "Jun 29 – Jul 5, 2026" / spanning years spelled out.
function weekRangeLabel(a, b) {
    if (a.slice(0, 4) !== b.slice(0, 4)) {
        const f = { month: 'short', day: 'numeric', year: 'numeric' };
        return tz.dayLabel(a, f) + ' – ' + tz.dayLabel(b, f);
    }
    const year = a.slice(0, 4);
    if (a.slice(5, 7) !== b.slice(5, 7)) {
        return tz.dayLabel(a, { month: 'short', day: 'numeric' })
            + ' – ' + tz.dayLabel(b, { month: 'short', day: 'numeric' }) + ', ' + year;
    }
    return tz.dayLabel(a, { month: 'short' }) + ' ' + (+a.slice(8, 10))
        + ' – ' + (+b.slice(8, 10)) + ', ' + year;
}

// Side-by-side column layout for one day's timed events. Each item carries
// startMin/endMin (minutes from midnight). Greedy interval coloring grouped by
// overlap cluster: an item gets { col, ncols } and draws at left = col/ncols,
// width = 1/ncols. The standard Google/Teams day-column algorithm.
function layoutDayColumns(items) {
    items.sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
    let cols = [];          // cols[c] = endMin of the last item placed in column c
    let group = [];         // current overlap cluster
    let groupEnd = -1;
    const finish = () => {
        for (const it of group) it.ncols = cols.length;
        group = []; cols = []; groupEnd = -1;
    };
    for (const it of items) {
        if (group.length && it.startMin >= groupEnd) finish();
        let placed = false;
        for (let c = 0; c < cols.length; c++) {
            if (cols[c] <= it.startMin) { cols[c] = it.endMin; it.col = c; placed = true; break; }
        }
        if (!placed) { it.col = cols.length; cols.push(it.endMin); }
        group.push(it);
        groupEnd = Math.max(groupEnd, it.endMin);
    }
    if (group.length) finish();
    return items;
}

function makeTimedEvent(it, zone, cal) {
    const ev = it.ev;
    const el = elem('button', 'cal-tg-event');
    const sc = statusClass(ev.status);
    if (sc) el.classList.add(sc);
    if (ev.categories.length) el.style.setProperty('--cat-hue', categoryHue(ev.categories[0]));
    else el.classList.add('is-plain');

    el.style.top = (it.startMin / 60 * HOUR_PX) + 'px';
    el.style.height = Math.max((it.endMin - it.startMin) / 60 * HOUR_PX, 15) + 'px';
    const n = it.ncols || 1, c = it.col || 0;
    el.style.left = 'calc(' + (c / n * 100) + '% + 1px)';
    el.style.width = 'calc(' + (100 / n) + '% - 3px)';

    const s = tz.resolve(ev.dtstart, zone);
    el.appendChild(elem('span', 'cal-tg-time', tz.timeLabel(s.hour, s.minute)));
    el.appendChild(elem('span', 'cal-tg-title', ev.summary || '(untitled)'));
    el.title = (ev.summary || '(untitled)') + ' · ' + tz.timeLabel(s.hour, s.minute)
        + (ev.location ? ' · ' + ev.location : '');
    el.addEventListener('click', () => cal._handleEventClick(ev, el));
    return el;
}

// Place (or reposition) the current-time line at today's wall clock.
function placeNowLine(cal, line) {
    const p = tz.partsInZone(new Date(), cal.timezone);
    line.style.top = ((p.hour * 60 + p.minute) / 60 * HOUR_PX) + 'px';
}

function renderTimeGrid(events, container, cal, dayKeys) {
    closePopover(cal);
    container.classList.add('cal-tg-fill');

    const zone = cal.timezone;
    const ncols = dayKeys.length;
    container.style.setProperty('--tg-ncols', ncols);
    container.style.setProperty('--tg-hour', HOUR_PX + 'px');
    const todayKey = tz.todayKey(zone);
    const rangeStart = dayKeys[0], rangeEnd = dayKeys[ncols - 1];
    const expanded = expandRecurring(events, rangeStart, rangeEnd);

    // Split: all-day / multi-day → header strip; single-day timed → grid.
    const stripSegs = [];
    const timedByCol = dayKeys.map(() => []);
    for (const ev of expanded) {
        if (!ev.dtstart) continue;
        const r = eventDayRange(ev, zone);
        if (ev.dtstart.allDay || r.startKey !== r.endKey) {
            const clip = clipToDays(r.startKey, r.endKey, dayKeys);
            if (clip) stripSegs.push(Object.assign({ ev, sortKey: startSortKey(ev, zone) }, clip));
            continue;
        }
        const idx = dayKeys.indexOf(r.startKey);
        if (idx < 0) continue;
        const s = tz.resolve(ev.dtstart, zone);
        let startMin = s.hour * 60 + s.minute;
        let endMin = startMin + 60;        // no DTEND → assume an hour
        if (ev.dtend) {
            const e = tz.resolve(ev.dtend, zone);
            endMin = (e.dayKey > r.startKey) ? 1440 : e.hour * 60 + e.minute;
        }
        if (endMin <= startMin) endMin = startMin + 30;
        timedByCol[idx].push({ ev, startMin, endMin });
    }

    // Multi-column (Week) gets the narrow horizontal-scroll treatment; a single
    // column (Day) always fills the width, so it never scrolls sideways.
    container.classList.toggle('cal-tg-multi', ncols > 1);

    // One sticky scroller holds the whole grid. The day-name header and all-day
    // strip freeze on vertical scroll, the hour gutter freezes on horizontal
    // scroll, and on a narrow Week the day columns scroll past the frozen
    // gutter. A spreadsheet with a frozen header row and first column.
    const scroll = elem('div', 'cal-tg-scroll');
    const table = elem('div', 'cal-tg-table');

    // Row 1: corner spacer + day-name header.
    table.appendChild(elem('div', 'cal-tg-corner'));
    const headCols = elem('div', 'cal-tg-headcols');
    for (let i = 0; i < ncols; i++) {
        const key = dayKeys[i];
        const h = elem('div', 'cal-tg-dayhead');
        if (key === todayKey) h.classList.add('is-today');
        else if (key < todayKey) h.classList.add('is-past');
        h.appendChild(elem('span', 'cal-tg-dayhead-wd eyebrow', tz.dayLabel(key, { weekday: 'short' })));
        const num = elem('span', 'cal-tg-dayhead-num', String(+key.slice(8, 10)));
        if (key === todayKey) num.classList.add('is-today');
        h.appendChild(num);
        headCols.appendChild(h);
    }
    table.appendChild(headCols);

    // Row 2: all-day strip (only when something rides it).
    if (stripSegs.length) {
        packSegs(stripSegs, ncols);
        const lanes = Math.max(...stripSegs.map(s => s.lane)) + 1;
        table.appendChild(elem('div', 'cal-tg-allday-label eyebrow', 'all-day'));
        const adCols = elem('div', 'cal-tg-allday-cols');
        adCols.style.gridTemplateRows = 'repeat(' + lanes + ', 1.4rem)';
        for (const seg of stripSegs) adCols.appendChild(makeBar(seg.ev, seg, zone, cal, 1));
        table.appendChild(adCols);
    }

    // Row 3: hour gutter + day columns, both 24 hours tall.
    const gutter = elem('div', 'cal-tg-gutter');
    for (let h = 1; h < 24; h++) {       // skip midnight (clipped at the top edge)
        const lab = elem('div', 'cal-tg-hour', tz.timeLabel(h, 0));
        lab.style.top = (h * HOUR_PX) + 'px';
        gutter.appendChild(lab);
    }
    table.appendChild(gutter);

    const dayCols = elem('div', 'cal-tg-daycols');
    dayCols.style.height = (24 * HOUR_PX) + 'px';
    let nowLine = null, todayCol = null;
    for (let i = 0; i < ncols; i++) {
        const col = elem('div', 'cal-tg-col');
        if (dayKeys[i] === todayKey) col.classList.add('is-today');
        else if (dayKeys[i] < todayKey) col.classList.add('is-past');
        for (const it of layoutDayColumns(timedByCol[i])) {
            col.appendChild(makeTimedEvent(it, zone, cal));
        }
        if (dayKeys[i] === todayKey) {
            todayCol = col;
            nowLine = elem('div', 'cal-now-line');
            nowLine.appendChild(elem('span', 'cal-now-dot'));
            placeNowLine(cal, nowLine);
            col.appendChild(nowLine);
        }
        dayCols.appendChild(col);
    }
    table.appendChild(dayCols);

    scroll.appendChild(table);
    container.appendChild(scroll);

    // Tick the now-line once a minute; cleared on the next _draw.
    if (nowLine) {
        cal._nowTimer = setInterval(() => placeNowLine(cal, nowLine), 60000);
    }

    // Land on the current hour (today) or the morning, a quarter down the fold.
    // The all-day strip pins below the header, so publish the header's height
    // for the strip's sticky offset. On a narrow Week, also bring today's
    // column into view horizontally.
    afterLayout(() => {
        // Bail if a newer render already replaced this grid: the 32ms backstop
        // can fire after a fast resize / view switch detached our scroller, and
        // a stale --tg-headh must not be written onto the persistent body.
        if (!scroll.isConnected) return;
        container.style.setProperty('--tg-headh', (headCols.offsetHeight || 0) + 'px');
        const p = tz.partsInZone(new Date(), zone);
        const targetMin = (todayKey >= rangeStart && todayKey <= rangeEnd)
            ? p.hour * 60 + p.minute : TG_DEFAULT_HOUR * 60;
        scroll.scrollTop = Math.max(0, targetMin / 60 * HOUR_PX - scroll.clientHeight * 0.25);
        if (todayCol && scroll.scrollWidth > scroll.clientWidth) {
            const c = todayCol.getBoundingClientRect(), s = scroll.getBoundingClientRect();
            scroll.scrollLeft += (c.left - s.left) - scroll.clientWidth * 0.3;
        }
    });
}


// ============================================================
// "+N more" day popover
//
// Lists every event on one day. Lives inside the calendar container
// (which is position:relative) and closes on outside click or redraw.
// ============================================================

function closePopover(cal) {
    if (cal._pop) {
        if (cal._popAway) document.removeEventListener('click', cal._popAway, true);
        if (cal._pop.parentNode) cal._pop.parentNode.removeChild(cal._pop);
        cal._pop = null;
        cal._popAway = null;
    }
}

// Place a popover just under the anchor rect, clamped to the container's right
// edge, and flipped above the anchor when it would run off the bottom.
function positionPopoverAt(cal, pop, ar) {
    const cr = cal.container.getBoundingClientRect();
    let left = ar.left - cr.left;
    const maxLeft = cal.container.clientWidth - pop.offsetWidth - 4;
    if (left > maxLeft) left = Math.max(4, maxLeft);
    pop.style.left = left + 'px';

    const below = ar.bottom + 4 + pop.offsetHeight <= window.innerHeight;
    const top = below ? (ar.bottom - cr.top + 4) : (ar.top - cr.top - pop.offsetHeight - 4);
    pop.style.top = Math.max(4, top) + 'px';
}

// Close on the next outside click. Deferred so the opening click doesn't
// immediately close it.
function bindPopoverAway(cal, pop) {
    cal._pop = pop;
    cal._popAway = (e) => { if (!pop.contains(e.target)) closePopover(cal); };
    setTimeout(() => { if (cal._pop === pop) document.addEventListener('click', cal._popAway, true); }, 0);
}

function popoverRow(ev, zone, cal) {
    const sc = statusClass(ev.status);
    const row = elem('button', 'cal-pop-event' + (sc ? ' ' + sc : ''));
    const dot = elem('span', 'cal-pop-dot');
    if (ev.categories.length) dot.style.setProperty('--cat-hue', categoryHue(ev.categories[0]));
    else dot.classList.add('is-plain');
    let when = 'All day';
    if (!ev.dtstart.allDay) {
        const r = tz.resolve(ev.dtstart, zone);
        when = tz.timeLabel(r.hour, r.minute);
    }
    row.appendChild(dot);
    row.appendChild(elem('span', 'cal-pop-time', when));
    row.appendChild(elem('span', 'cal-pop-title', ev.summary || '(untitled)'));
    row.addEventListener('click', () => cal._handleEventClick(ev, row));
    return row;
}

function openDayPopover(cal, dayKey, ranges, anchorEl) {
    const ar = anchorEl.getBoundingClientRect();
    closePopover(cal);
    const zone = cal.timezone;

    const dayEvents = ranges
        .filter(r => r.startKey <= dayKey && dayKey <= r.endKey)
        .sort((a, b) => a.sortKey - b.sortKey)
        .map(r => r.ev);

    const pop = elem('div', 'cal-popover panel');
    pop.appendChild(elem('div', 'cal-popover-date',
        tz.dayLabel(dayKey, { weekday: 'long', month: 'long', day: 'numeric' })));
    for (const ev of dayEvents) pop.appendChild(popoverRow(ev, zone, cal));
    cal.container.appendChild(pop);

    positionPopoverAt(cal, pop, ar);
    bindPopoverAway(cal, pop);
}


// ============================================================
// Event detail card
//
// The default click action on an event: a card with the title, full
// date/time, location, categories, description (URLs/emails live), and an
// Open link to the event URL. Same container + close behavior as the day
// popover; works in month and list views.
// ============================================================

// Full date/time phrase for the detail card.
function eventWhenText(ev, zone) {
    const range = eventDayRange(ev, zone);
    const dayFmt = { weekday: 'long', month: 'long', day: 'numeric' };

    if (ev.dtstart.allDay) {
        return range.endKey !== range.startKey
            ? tz.dayLabel(range.startKey, dayFmt) + ' – ' + tz.dayLabel(range.endKey, dayFmt)
            : 'All day · ' + tz.dayLabel(range.startKey, dayFmt);
    }

    const s = tz.resolve(ev.dtstart, zone);
    let txt = tz.dayLabel(range.startKey, dayFmt) + ' · ' + tz.timeLabel(s.hour, s.minute);
    if (ev.dtend) {
        const e = tz.resolve(ev.dtend, zone);
        txt += (e.dayKey === range.startKey)
            ? ' – ' + tz.timeLabel(e.hour, e.minute)
            : ' – ' + tz.dayLabel(e.dayKey, dayFmt) + ' · ' + tz.timeLabel(e.hour, e.minute);
    }
    return txt;
}

// Escape, then linkify URLs and emails. Newlines survive via white-space.
function linkify(text) {
    return escHtml(text)
        .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
        .replace(/(^|[\s(])([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1<a href="mailto:$2">$2</a>');
}

function openEventPopover(cal, ev, anchorEl) {
    const ar = anchorEl ? anchorEl.getBoundingClientRect() : null;
    closePopover(cal);
    const zone = cal.timezone;
    const sc = statusClass(ev.status);

    const pop = elem('div', 'cal-event-pop panel' + (sc ? ' ' + sc : ''));
    pop.appendChild(elem('h4', 'cal-pop-heading', ev.summary || '(untitled)'));

    if (ev.status === 'TENTATIVE') pop.appendChild(elem('div', 'cal-pop-status tag', 'Tentative'));
    else if (ev.status === 'CANCELLED') pop.appendChild(elem('div', 'cal-pop-status tag', 'Cancelled'));

    pop.appendChild(elem('div', 'cal-pop-when', eventWhenText(ev, zone)));
    if (ev.location) pop.appendChild(elem('div', 'cal-pop-loc', ev.location));

    if (ev.categories.length) {
        const chips = elem('div', 'cal-chips');
        for (const c of ev.categories) {
            const chip = elem('span', 'cal-chip', c);
            chip.style.setProperty('--cat-hue', categoryHue(c));
            chips.appendChild(chip);
        }
        pop.appendChild(chips);
    }

    if (ev.description) {
        const desc = elem('div', 'cal-pop-desc');
        desc.innerHTML = linkify(ev.description);
        pop.appendChild(desc);
    }

    const openHref = safeUrl(ev.url);
    if (openHref) {
        const open = elem('a', 'cal-pop-open', 'Open ↗');
        open.href = openHref;
        open.target = '_blank';
        open.rel = 'noopener';
        pop.appendChild(open);
    }

    cal.container.appendChild(pop);
    if (ar) positionPopoverAt(cal, pop, ar);
    bindPopoverAway(cal, pop);
}


// ============================================================
// Exporters
//
// CSV is for spreadsheets (RFC 4180). iCal is round-trip stable:
// parse -> export -> parse yields an equivalent event set for the
// subset we support. Both serialize the SOURCE data, not the display
// zone — the display timezone only affects rendering, never export.
// ============================================================

// Filename slug from the calendar name (X-WR-CALNAME) else "calendar".
function calSlug(meta, ext) {
    let base = (meta && meta.calname) ? meta.calname : 'calendar';
    base = base.replace(/[^\w.-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
    return (base || 'calendar') + '.' + ext;
}

// --- CSV (RFC 4180) ----------------------------------------

function csvField(v) {
    v = (v == null) ? '' : String(v);
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

// Human/spreadsheet-friendly date: all-day -> YYYY-MM-DD; timed keeps
// the wall time plus its zone hint (Z, or the IANA TZID).
function fmtDateCell(part) {
    if (!part) return '';
    if (part.allDay) return part.date;
    return part.datetime + (part.utc ? 'Z' : (part.tz ? ' ' + part.tz : ''));
}

function exportCsv(events, meta) {
    const base = ['uid', 'dtstart', 'dtend', 'summary', 'description', 'location',
        'categories', 'status', 'priority', 'url', 'organizer'];

    // One extra column per distinct X-* property across the set.
    const xset = new Set();
    for (const ev of events) for (const k in ev.extensions) xset.add(k);
    const xcols = [...xset].sort();

    const rows = [base.concat(xcols).map(csvField).join(',')];
    for (const ev of events) {
        const row = [
            ev.uid, fmtDateCell(ev.dtstart), fmtDateCell(ev.dtend),
            ev.summary, ev.description, ev.location,
            ev.categories.join(', '), ev.status,
            (ev.priority == null ? '' : ev.priority), ev.url, ev.organizer
        ];
        for (const x of xcols) row.push(ev.extensions[x] != null ? ev.extensions[x] : '');
        rows.push(row.map(csvField).join(','));
    }
    return { filename: calSlug(meta, 'csv'), mime: 'text/csv', content: rows.join('\r\n') + '\r\n' };
}

// --- iCal (RFC 5545) ---------------------------------------

// Reverse of unescapeText: \ ; , and newline become escaped sequences.
function escapeText(s) {
    return String(s)
        .replace(/\\/g, '\\\\').replace(/;/g, '\\;')
        .replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

// Serialize a DTSTART/DTEND part back to a property line.
function icalDate(name, part) {
    if (!part) return null;
    if (part.allDay) return name + ';VALUE=DATE:' + part.date.replace(/-/g, '');
    const dt = part.datetime.replace(/[-:]/g, '');   // 2026-06-09T14:00:00 -> 20260609T140000
    if (part.utc) return name + ':' + dt + 'Z';
    if (part.tz) return name + ';TZID=' + part.tz + ':' + dt;
    return name + ':' + dt;
}

function icalRRule(rule) {
    // FREQ first, then a canonical order, then any leftover keys. Order
    // doesn't affect round-trip equivalence (re-parse keys back the same).
    const order = ['freq', 'until', 'count', 'interval', 'bysecond', 'byminute',
        'byhour', 'byday', 'bymonthday', 'byyearday', 'byweekno', 'bymonth',
        'bysetpos', 'wkst'];
    const seen = {}, parts = [];
    const emit = (k) => {
        if (!(k in rule) || rule[k] == null || seen[k]) return;
        seen[k] = true;
        const v = Array.isArray(rule[k]) ? rule[k].join(',') : rule[k];
        parts.push(k.toUpperCase() + '=' + v);
    };
    for (const k of order) emit(k);
    for (const k in rule) emit(k);
    return parts.join(';');
}

function icalEvent(ev) {
    const L = ['BEGIN:VEVENT', 'UID:' + ev.uid];
    if (ev.dtstamp) L.push('DTSTAMP:' + ev.dtstamp);
    L.push(icalDate('DTSTART', ev.dtstart));
    if (ev.dtend) L.push(icalDate('DTEND', ev.dtend));
    if (ev.duration) L.push('DURATION:' + ev.duration);
    if (ev.summary != null) L.push('SUMMARY:' + escapeText(ev.summary));
    if (ev.description != null) L.push('DESCRIPTION:' + escapeText(ev.description));
    if (ev.location != null) L.push('LOCATION:' + escapeText(ev.location));
    if (ev.categories.length) L.push('CATEGORIES:' + ev.categories.map(escapeText).join(','));
    if (ev.status) L.push('STATUS:' + ev.status);
    if (ev.priority != null) L.push('PRIORITY:' + ev.priority);
    if (ev.url) L.push('URL:' + ev.url);
    if (ev.organizer) L.push('ORGANIZER:' + ev.organizer);
    for (const a of ev.attendees) L.push('ATTENDEE:' + a);
    if (ev.rrule) L.push('RRULE:' + icalRRule(ev.rrule));
    if (ev.classification) L.push('CLASS:' + ev.classification);
    for (const k in ev.extensions) L.push(k + ':' + escapeText(ev.extensions[k]));
    L.push('END:VEVENT');
    return L;
}

// Fold a logical line at 75 chars per RFC 5545, never splitting an
// escape pair (an odd run of trailing backslashes is backed over).
function foldLine(line) {
    if (line.length <= 75) return line;
    const out = [];
    let i = 0, limit = 75;
    while (line.length - i > limit) {
        let cut = i + limit;
        let bs = 0;
        while (line[cut - 1 - bs] === '\\') bs++;
        if (bs % 2 === 1) cut--;
        out.push((out.length ? ' ' : '') + line.slice(i, cut));
        i = cut;
        limit = 74;               // continuation lines carry a leading space
    }
    out.push((out.length ? ' ' : '') + line.slice(i));
    return out.join('\r\n');
}

function exportIcal(events, meta) {
    const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//axe//calendar//EN', 'CALSCALE:GREGORIAN'];
    if (meta && meta.calname) L.push('X-WR-CALNAME:' + escapeText(meta.calname));
    for (const ev of events) for (const line of icalEvent(ev)) L.push(line);
    L.push('END:VCALENDAR');
    return {
        filename: calSlug(meta, 'ics'),
        mime: 'text/calendar',
        content: L.map(foldLine).join('\r\n') + '\r\n'
    };
}

// Browser download for the export's { filename, mime, content }.
function triggerDownload(out) {
    const blob = new Blob([out.content], { type: out.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = out.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 0);
}


// ============================================================
// Toolbar / nav helpers (shared by the view objects)
// ============================================================

function monthCursor(cal) {
    if (!cal._monthCursor) {
        const t = tz.partsInZone(new Date(), cal.timezone);
        cal._monthCursor = { year: t.year, month: t.month };
    }
    return cal._monthCursor;
}

// Page the scrolling body by ~one screen (the list view's prev/next).
function pageBody(cal, dir) {
    const b = cal._body;
    if (b) b.scrollTop += dir * Math.round(b.clientHeight * 0.9);
}

// List view: keep the toolbar in sync with scroll — the title tracks the
// top-of-scroll month, and the Today arrow points toward the anchor (today /
// next upcoming) while it's off-screen.
function listSyncOnScroll(cal) {
    const b = cal._body;
    if (!b) return;
    const top = b.scrollTop;
    // The top-of-fold day: the last section at or above the scroll line. Sections
    // are in date order, so stop as soon as one starts below it.
    let topSec = null;
    for (const s of b.querySelectorAll('.cal-day')) {
        if (s.offsetTop > top + 4) break;
        topSec = s;
    }
    const keyOf = (s) => (s && s.querySelector('time')) ? s.querySelector('time').getAttribute('datetime') : null;
    const topKey = keyOf(topSec);
    if (topKey) {
        cal._listTopMonth = tz.dayLabel(topKey, { month: 'long', year: 'numeric' });
        cal._listTopYM = { year: +topKey.slice(0, 4), month: +topKey.slice(5, 7) };
    }
    // Today arrow: "Today" (no arrow) only when the target day — the next day
    // that has an event — is pinned at the very top. Once you scroll off it the
    // arrow points the way back: down when the top is earlier than the target,
    // up when it's later.
    const t = cal._listToday;
    if (t && topKey) {
        cal._listTodayDir = topKey === t ? null : (topKey < t ? 'down' : 'up');
    } else {
        cal._listTodayDir = null;
    }
    cal._syncToolbar();
}

// Build one declarative toolbar action: { label, href|copy|onClick, title }.
// Every action is a <button> for a uniform look — href navigates on click,
// copy writes to the clipboard with "Copied!" feedback, onClick runs custom.
function buildAction(desc) {
    const el = elem('button', 'cal-action ghost', desc.label);
    el.type = 'button';
    if (desc.href != null) {
        el.addEventListener('click', function () { window.location.href = desc.href; });
    } else if (desc.copy != null) {
        el.addEventListener('click', function () {
            const restore = el.textContent;
            const flash = function () {
                el.textContent = 'Copied!';
                setTimeout(function () { el.textContent = restore; }, 1500);
            };
            if (navigator.clipboard) navigator.clipboard.writeText(desc.copy).then(flash, function () {});
            else flash();
        });
    } else if (typeof desc.onClick === 'function') {
        el.addEventListener('click', function () { desc.onClick(el); });
    }
    if (desc.title) el.title = desc.title;
    return el;
}


// ============================================================
// Calendar
// ============================================================

class Calendar {
    constructor(container, opts) {
        opts = opts || {};
        if ((opts.source == null) === (opts.url == null)) {
            throw new Error('Calendar: provide exactly one of { source, url }');
        }
        this.container = container;
        this.opts = opts;
        this.view = opts.view || 'month';
        // On a narrow screen the month grid renders as a day-stack — basically a
        // list bounded to one month, without the list view's open-on-today and
        // lazy scroll. Open on the list there instead; the user can still switch
        // to Month. Initial default only (not re-applied on resize), so a manual
        // choice sticks.
        if (this.view === 'month' && typeof window !== 'undefined'
            && window.innerWidth < MONTH_NARROW_PX) {
            this.view = 'list';
        }
        this.timezone = opts.timezone || null;        // null = browser local
        this.onEventClick = opts.onEventClick || null;
        this.events = [];
        this.meta = { calname: null, prodid: null, version: null };
    }

    async render() {
        // Re-draw on resize (debounced): the month grid swaps to/from the
        // narrow day-stack and recomputes its visible-lane count from the
        // new height. Bound once.
        if (!this._resizeHandler && typeof window !== 'undefined') {
            this._resizeHandler = () => {
                if (this._resizeTimer) clearTimeout(this._resizeTimer);
                this._resizeTimer = setTimeout(() => this._draw(), 150);
            };
            window.addEventListener('resize', this._resizeHandler);
        }
        let text = this.opts.source;
        if (this.opts.url != null) {
            const res = await fetch(this.opts.url);
            if (!res.ok) throw new Error('Calendar: fetch failed (' + res.status + ')');
            text = await res.text();
        }
        const parsed = parseICal(text);
        this.events = parsed.events;
        this.meta = { calname: parsed.calname, prodid: parsed.prodid, version: parsed.version };
        this._draw();
        return this;
    }

    _draw() {
        closePopover(this);
        if (this._datePicker) this._closeDatePicker();
        if (this._listObserver) { this._listObserver.disconnect(); this._listObserver = null; }
        if (this._nowTimer) { clearInterval(this._nowTimer); this._nowTimer = null; }
        if (this._listScroll && this._body) {
            this._body.removeEventListener('scroll', this._listScroll);
            this._listScroll = null;
        }
        if (!this._body) this._buildShell();
        this._syncToolbar();
        const viewObj = Calendar.views[this.view] || Calendar.views.list;
        this._body.innerHTML = '';
        // The body element persists across draws; clear every view's layout-mode
        // class so one view's fill (e.g. the time-grid's overflow:hidden) can't
        // linger and break the next view's scrolling. Renderers add their own.
        this._body.classList.remove('cal-list-fill', 'cal-month-fill', 'cal-tg-fill', 'cal-tg-multi');
        viewObj.render(this.events, this._body, this);
    }

    // Build the persistent shell once: a toolbar above a view body. Re-draws
    // replace only the body, so the toolbar stays put.
    _buildShell() {
        this.container.classList.add('axe-cal');
        this.container.innerHTML = '';
        const body = elem('div', 'cal-body');

        if (this.opts.toolbar === false) {        // host drives nav via the API
            this.container.appendChild(body);
            this._body = body;
            this._tabs = null;
            this._wireInput();
            return;
        }

        const bar = elem('div', 'cal-topbar');    // not 'cal-bar' — that's the month event-bar

        // Today (with a direction arrow toward today) + prev/next chevrons.
        const todayBtn = elem('button', 'cal-today ghost');
        todayBtn.type = 'button';
        const arrow = elem('span', 'cal-today-arrow');
        todayBtn.appendChild(arrow);
        todayBtn.appendChild(document.createTextNode('Today'));
        todayBtn.addEventListener('click', () => this._navToday());

        const nav = elem('div', 'cal-nav');
        // Chevrons are drawn in CSS (::before borders), not the ⌃⌄ glyphs:
        // those render off-center (one high, one low). The CSS shape sits
        // dead-center and both buttons read at the same level. aria-label
        // carries the meaning.
        const prev = elem('button', 'cal-nav-btn cal-nav-up ghost');     // prev
        const next = elem('button', 'cal-nav-btn cal-nav-down ghost');   // next
        prev.type = 'button'; next.type = 'button';
        prev.setAttribute('aria-label', 'Previous');
        next.setAttribute('aria-label', 'Next');
        prev.addEventListener('click', () => this._navPrev());
        next.addEventListener('click', () => this._navNext());
        nav.appendChild(prev); nav.appendChild(next);
        this._nav = nav;

        const title = elem('button', 'cal-title');     // click opens the date picker
        title.type = 'button';
        const titleText = elem('span', 'cal-title-text');
        title.appendChild(titleText);
        title.appendChild(elem('span', 'cal-title-caret', '▾'));
        title.addEventListener('click', () => this._toggleDatePicker());

        const tabs = elem('div', 'cal-views');
        for (const name of Object.keys(Calendar.views)) {
            const tab = elem('button', 'cal-view-tab ghost', Calendar.views[name].label);
            tab.type = 'button';
            tab.dataset.view = name;
            tab.addEventListener('click', () => { this.switchView(name); this._closeMenu(); });
            tabs.appendChild(tab);
        }

        // Host actions: declarative opts.actions render here, and the slot stays
        // exposed (getToolbarSlot) so a host can inject custom controls — e.g.
        // the viewer drops in a timezone <select> + Export.
        const actions = elem('div', 'cal-actions');
        if (Array.isArray(this.opts.actions)) {
            for (const a of this.opts.actions) actions.appendChild(buildAction(a));
        }

        bar.appendChild(todayBtn);
        bar.appendChild(nav);
        bar.appendChild(title);

        // Right cluster — view tabs, host actions, theme toggle. Inline on a
        // wide bar; below the narrow breakpoint it collapses into a hamburger
        // (CSS), opened by the ☰ button. The chevrons hide on narrow too (a
        // swipe is the touch gesture for prev/next).
        const menuWrap = elem('div', 'cal-menu-wrap');
        const menuToggle = elem('button', 'cal-menu-toggle ghost', '☰');
        menuToggle.type = 'button';
        menuToggle.setAttribute('aria-label', 'Menu');
        menuToggle.setAttribute('aria-expanded', 'false');
        menuToggle.addEventListener('click', () => this._toggleMenu());

        const menu = elem('div', 'cal-menu');
        menu.appendChild(tabs);
        menu.appendChild(actions);
        if (this.opts.themeToggle !== false) {    // component-owned sun/moon
            const toggle = elem('button', 'theme-toggle', '☼');
            toggle.type = 'button';
            toggle.setAttribute('aria-label', 'Toggle theme');
            toggle.addEventListener('click', () => this._toggleTheme());
            menu.appendChild(toggle);
        }

        menuWrap.appendChild(menuToggle);
        menuWrap.appendChild(menu);
        bar.appendChild(menuWrap);

        this.container.appendChild(bar);
        this.container.appendChild(body);

        this._bar = bar;
        this._tabs = tabs;
        this._menu = menu;
        this._menuToggle = menuToggle;
        this._menuWrap = menuWrap;
        this._body = body;
        this._titleEl = titleText;
        this._titleBtn = title;
        this._todayArrow = arrow;
        this._actionsSlot = actions;

        this._wireInput();
    }

    // Wheel + keyboard + touch, bound on the (focusable) calendar. Works with or
    // without the toolbar.
    _wireInput() {
        this.container.tabIndex = 0;
        this.container.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
        this.container.addEventListener('keydown', (e) => this._onKey(e));
        // A horizontal swipe pages views that opt in (Day → adjacent day). Week
        // doesn't opt in: there a horizontal swipe scrolls its day columns.
        this.container.addEventListener('touchstart', (e) => this._onTouchStart(e), { passive: true });
        this.container.addEventListener('touchend', (e) => this._onTouchEnd(e), { passive: true });
    }

    _onTouchStart(e) {
        // Single-finger swipes only (ignore pinch), and only over the view body.
        this._swipe = (e.touches.length === 1 && this._body && this._body.contains(e.target))
            ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    }

    _onTouchEnd(e) {
        const start = this._swipe;
        this._swipe = null;
        if (!start) return;
        const v = this._activeView();
        if (!v || !v.swipeNav) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - start.x, dy = t.clientY - start.y;
        // Commit only to a clear, dominantly-horizontal swipe so a vertical
        // hour-scroll never pages. Swipe left → next, swipe right → prev.
        if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        if (dx < 0) this._navNext(); else this._navPrev();
    }

    // Flip light/dark (the component owns the sun/moon). theme.js still sets the
    // initial theme on load; this just toggles and persists the choice.
    _toggleTheme() {
        const cur = document.documentElement.getAttribute('data-theme');
        const next = cur === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        try { localStorage.setItem('theme', next); } catch (e) {}
    }

    // The toolbar's right-side actions container, for hosts that inject custom
    // controls (call after render()). Null when the toolbar is suppressed.
    getToolbarSlot() { return this._actionsSlot || null; }

    // --- Hamburger menu (narrow screens): the right cluster collapses here ---
    _toggleMenu() {
        if (!this._menu) return;
        if (this._menu.classList.contains('is-open')) { this._closeMenu(); return; }
        this._menu.classList.add('is-open');
        this._menuToggle.setAttribute('aria-expanded', 'true');
        this._menuOutside = (e) => {
            if (this._menuWrap && !this._menuWrap.contains(e.target)) this._closeMenu();
        };
        setTimeout(() => document.addEventListener('mousedown', this._menuOutside), 0);
    }

    _closeMenu() {
        if (this._menu) this._menu.classList.remove('is-open');
        if (this._menuToggle) this._menuToggle.setAttribute('aria-expanded', 'false');
        if (this._menuOutside) { document.removeEventListener('mousedown', this._menuOutside); this._menuOutside = null; }
    }

    // --- Date picker: click the title to jump to a month/year ----
    _toggleDatePicker() {
        if (this._datePicker) { this._closeDatePicker(); return; }
        const v = this._activeView();
        const ref = v.pickerRef ? v.pickerRef(this) : null;
        if (!ref) return;

        const pop = elem('div', 'cal-datepicker panel');
        const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const todayBtn = () => {
            const t = elem('button', 'cal-dp-today', 'Today');
            t.type = 'button';
            t.addEventListener('click', () => { this._closeDatePicker(); this._navToday(); });
            return t;
        };
        // Month/year picker (Month + List): a 12-month grid with year nav.
        let year = ref.year;
        const renderMonths = () => {
            pop.innerHTML = '';
            const head = elem('div', 'cal-dp-head');
            const py = elem('button', 'cal-dp-yearnav ghost', '‹');
            const yl = elem('span', 'cal-dp-label', String(year));
            const ny = elem('button', 'cal-dp-yearnav ghost', '›');
            py.type = ny.type = 'button';
            py.setAttribute('aria-label', 'Previous year');
            ny.setAttribute('aria-label', 'Next year');
            py.addEventListener('click', () => { year--; renderMonths(); });
            ny.addEventListener('click', () => { year++; renderMonths(); });
            head.appendChild(py); head.appendChild(yl); head.appendChild(ny);
            pop.appendChild(head);

            const grid = elem('div', 'cal-dp-months');
            for (let m = 1; m <= 12; m++) {
                const mb = elem('button', 'cal-dp-month', MN[m - 1]);
                mb.type = 'button';
                if (year === ref.year && m === ref.month) mb.classList.add('is-current');
                mb.addEventListener('click', () => this._pickDate(year, m));
                grid.appendChild(mb);
            }
            pop.appendChild(grid);
            pop.appendChild(todayBtn());
        };
        // Day picker (Day + Week): a month-navigable day grid.
        const weekStart = weekStartOf(this);
        const todayKey = tz.todayKey(this.timezone);
        const curKey = ref.year + '-' + tz.pad(ref.month) + '-' + tz.pad(ref.day || 1);
        let vy = ref.year, vm = ref.month;
        const renderDays = () => {
            pop.innerHTML = '';
            const head = elem('div', 'cal-dp-head');
            const py = elem('button', 'cal-dp-yearnav ghost', '‹');
            const yl = elem('span', 'cal-dp-label', MN[vm - 1] + ' ' + vy);
            const ny = elem('button', 'cal-dp-yearnav ghost', '›');
            py.type = ny.type = 'button';
            py.setAttribute('aria-label', 'Previous month');
            ny.setAttribute('aria-label', 'Next month');
            py.addEventListener('click', () => { const s = shiftMonth({ year: vy, month: vm }, -1); vy = s.year; vm = s.month; renderDays(); });
            ny.addEventListener('click', () => { const s = shiftMonth({ year: vy, month: vm }, 1); vy = s.year; vm = s.month; renderDays(); });
            head.appendChild(py); head.appendChild(yl); head.appendChild(ny);
            pop.appendChild(head);

            const grid = elem('div', 'cal-dp-days');
            for (let i = 0; i < 7; i++) {
                grid.appendChild(elem('span', 'cal-dp-dow',
                    tz.dayLabel(tz.addDays('2026-03-01', (i + weekStart) % 7), { weekday: 'narrow' })));
            }
            const firstKey = vy + '-' + tz.pad(vm) + '-01';
            const lead = (weekdayOf(firstKey) - weekStart + 7) % 7;
            const gridStart = tz.addDays(firstKey, -lead);
            for (let i = 0; i < 42; i++) {
                const key = tz.addDays(gridStart, i);
                const db = elem('button', 'cal-dp-day', String(+key.slice(8, 10)));
                db.type = 'button';
                if (+key.slice(5, 7) !== vm) db.classList.add('is-outside');
                if (key === todayKey) db.classList.add('is-today');
                if (key === curKey) db.classList.add('is-current');
                db.addEventListener('click', () => this._pickDate(+key.slice(0, 4), +key.slice(5, 7), +key.slice(8, 10)));
                grid.appendChild(db);
            }
            pop.appendChild(grid);
            pop.appendChild(todayBtn());
        };
        if (v.pickerKind === 'day') renderDays(); else renderMonths();

        this._datePicker = pop;
        this.container.appendChild(pop);
        const tr = this._titleBtn.getBoundingClientRect();
        const cr = this.container.getBoundingClientRect();
        pop.style.left = (tr.left - cr.left) + 'px';
        pop.style.top = (tr.bottom - cr.top + 4) + 'px';

        this._dpOutside = (e) => {
            if (this._datePicker && !this._datePicker.contains(e.target) && !this._titleBtn.contains(e.target)) {
                this._closeDatePicker();
            }
        };
        setTimeout(() => document.addEventListener('mousedown', this._dpOutside), 0);
    }

    _pickDate(year, month, day) {
        this._closeDatePicker();
        const v = this._activeView();
        if (v.goTo) v.goTo(this, year, month, day);
        this._syncToolbar();
    }

    _closeDatePicker() {
        if (this._datePicker) { this._datePicker.remove(); this._datePicker = null; }
        if (this._dpOutside) { document.removeEventListener('mousedown', this._dpOutside); this._dpOutside = null; }
    }

    _activeView() { return Calendar.views[this.view] || Calendar.views.list; }
    _navToday() { const v = this._activeView(); if (v.today) v.today(this); this._syncToolbar(); }
    _navPrev()  { const v = this._activeView(); if (v.prev)  v.prev(this);  this._syncToolbar(); }
    _navNext()  { const v = this._activeView(); if (v.next)  v.next(this);  this._syncToolbar(); }

    // Wheel pages a paged view (month): one gesture = one step, then locked
    // until the wheel goes quiet (~150ms) so a trackpad swipe doesn't fly
    // through months. Scroll views (list) keep native wheel scrolling.
    _onWheel(e) {
        const v = this._activeView();
        if (!v || v.navModel !== 'paged') return;
        e.preventDefault();
        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= 16;          // lines → ~px
        else if (e.deltaMode === 2) dy *= 400;    // pages → ~px
        this._wheelAcc = (this._wheelAcc || 0) + dy;
        if (this._wheelQuiet) clearTimeout(this._wheelQuiet);
        this._wheelQuiet = setTimeout(() => { this._wheelLocked = false; this._wheelAcc = 0; }, 150);
        if (this._wheelLocked || Math.abs(this._wheelAcc) < 20) return;
        this._wheelLocked = true;
        const dir = this._wheelAcc > 0 ? 1 : -1;   // down = next, up = prev
        this._wheelAcc = 0;
        if (dir > 0) this._navNext(); else this._navPrev();
    }

    // Keyboard: PageUp/PageDown page the period; Home jumps to today. All views.
    _onKey(e) {
        const tag = e.target && e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (e.key === 'PageUp')        { e.preventDefault(); this._navPrev(); }
        else if (e.key === 'PageDown') { e.preventDefault(); this._navNext(); }
        else if (e.key === 'Home')     { e.preventDefault(); this._navToday(); }
    }

    // Sync the toolbar to the current view: active tab, title, Today arrow.
    _syncToolbar() {
        if (!this._tabs) return;
        for (const tab of this._tabs.children) {
            tab.classList.toggle('is-active', tab.dataset.view === this.view);
        }
        const v = this._activeView();
        if (this._titleEl) this._titleEl.textContent = v.title ? v.title(this) : '';
        // Nav axis: Month/List page up/down (⌃⌄); Day/Week page left/right (‹›).
        // The CSS re-rotates the same two chevrons.
        if (this._nav) this._nav.classList.toggle('is-horizontal', v.navAxis === 'horizontal');
        if (this._todayArrow) {
            const dir = v.todayDir ? v.todayDir(this) : null;
            // Always a glyph in a fixed-width slot, so the button never resizes:
            // arrows point toward today when it's off-screen, ● marks "you're there".
            const glyph = { up: '↑', down: '↓', left: '←', right: '→' }[dir] || '●';
            this._todayArrow.textContent = glyph;
        }
    }

    switchView(name) {
        if (!Calendar.views[name]) throw new Error('Calendar: unknown view "' + name + '"');
        this.view = name;
        this._wheelAcc = 0;
        this._wheelLocked = false;
        if (this._wheelQuiet) { clearTimeout(this._wheelQuiet); this._wheelQuiet = null; }
        this._draw();
        return this;
    }

    setTimezone(zone) {
        this.timezone = zone || null;
        this._draw();
        return this;
    }

    // Non-mutating: returns a new Calendar over the filtered events.
    filter(pred) {
        const c = Object.create(Calendar.prototype);
        c.container = this.container;
        c.opts = this.opts;
        c.view = this.view;
        c.timezone = this.timezone;
        c.onEventClick = this.onEventClick;
        c.events = this.events.filter(pred);
        c.meta = this.meta;
        return c;
    }

    getEvents() { return this.events; }

    // The subscribe URLs for this calendar, or null when it can't be
    // subscribed to. Subscription needs a real http(s) URL: a calendar loaded
    // from `url`, or from `source` with a `sourceUrl` hint (the viewer fetches
    // the text itself but passes where it came from). Inline source with no
    // hint, a local file://, or a relative URL on a file:// page all return
    // null. Returns { url, webcal } when it can.
    getSubscribeUrl() {
        const ref = this.opts.url != null ? this.opts.url : this.opts.sourceUrl;
        if (ref == null) return null;
        let abs;
        try {
            abs = new URL(ref, typeof document !== 'undefined' ? document.baseURI : undefined);
        } catch (e) {
            return null;
        }
        if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;
        return { url: abs.href, webcal: abs.href.replace(/^https?:/, 'webcal:') };
    }

    // Build the export artifact and, in a browser, download it. Returns
    // { filename, mime, content } so embed/test callers can use the text.
    export(format) {
        const fn = Calendar.exporters[format];
        if (!fn) throw new Error('Calendar: unknown exporter "' + format + '"');
        const out = fn(this.events, this.meta, this);
        if (typeof document !== 'undefined') triggerDownload(out);
        return out;
    }

    // Default click action is the event detail card. A consumer can override
    // with onEventClick (e.g. to navigate straight to the URL).
    _handleEventClick(event, anchorEl) {
        if (this.onEventClick) this.onEventClick(event);
        else openEventPopover(this, event, anchorEl);
    }

    // Tear the calendar down: stop the now-line ticker, disconnect the list
    // observer, and drop every listener (resize, scroll, and the document-level
    // outside-click handlers behind popovers / the menu / the date picker), then
    // empty the container. For a host that mounts and unmounts the calendar
    // (an SPA route), call this before discarding it so nothing keeps ticking
    // or holds the instance alive. Static page-lifetime embeds never need it.
    destroy() {
        closePopover(this);
        this._closeDatePicker();
        this._closeMenu();
        if (this._nowTimer) { clearInterval(this._nowTimer); this._nowTimer = null; }
        if (this._listObserver) { this._listObserver.disconnect(); this._listObserver = null; }
        if (this._wheelQuiet) { clearTimeout(this._wheelQuiet); this._wheelQuiet = null; }
        if (this._resizeTimer) { clearTimeout(this._resizeTimer); this._resizeTimer = null; }
        if (this._resizeHandler && typeof window !== 'undefined') {
            window.removeEventListener('resize', this._resizeHandler);
            this._resizeHandler = null;
        }
        if (this._listScroll && this._body) {
            this._body.removeEventListener('scroll', this._listScroll);
            this._listScroll = null;
        }
        this.container.innerHTML = '';
        this.container.classList.remove('axe-cal');
        this._body = null;
    }
}

// View and exporter registries. Plain maps so adding one later is
// trivial; no self-registration ceremony, no separate files.
// Each view is an object: a label for its tab, the render function, and a
// nav model (how it moves through time — drives the wheel/keyboard in later
// slices). Registry order is tab order.
Calendar.views = {
    day: {
        label: 'Day', render(events, c, cal) { renderTimeGrid(events, c, cal, [dayCursor(cal)]); },
        navModel: 'scroll', navAxis: 'horizontal', pickerKind: 'day', swipeNav: true,
        title(cal) {
            // A narrow nav bar can't fit the long weekday + month without
            // wrapping, so drop the weekday and abbreviate the month there.
            const narrow = typeof window !== 'undefined' && window.innerWidth < MONTH_NARROW_PX;
            return tz.dayLabel(dayCursor(cal), narrow
                ? { month: 'short', day: 'numeric', year: 'numeric' }
                : { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
        },
        today(cal) { cal._dayCursor = tz.todayKey(cal.timezone); cal._draw(); },
        prev(cal) { cal._dayCursor = tz.addDays(dayCursor(cal), -1); cal._draw(); },
        next(cal) { cal._dayCursor = tz.addDays(dayCursor(cal), 1); cal._draw(); },
        todayDir(cal) {
            const t = tz.todayKey(cal.timezone), d = dayCursor(cal);
            return d > t ? 'left' : (d < t ? 'right' : null);
        },
        goTo(cal, year, month, day) {
            cal._dayCursor = year + '-' + tz.pad(month) + '-' + tz.pad(day || 1); cal._draw();
        },
        pickerRef(cal) {
            const d = dayCursor(cal);
            return { year: +d.slice(0, 4), month: +d.slice(5, 7), day: +d.slice(8, 10) };
        },
    },
    week: {
        label: 'Week', render(events, c, cal) { renderTimeGrid(events, c, cal, weekKeysFor(dayCursor(cal), weekStartOf(cal))); },
        navModel: 'scroll', navAxis: 'horizontal', pickerKind: 'day',
        title(cal) {
            const ks = weekKeysFor(dayCursor(cal), weekStartOf(cal));
            return weekRangeLabel(ks[0], ks[6]);
        },
        today(cal) { cal._dayCursor = tz.todayKey(cal.timezone); cal._draw(); },
        prev(cal) { cal._dayCursor = tz.addDays(dayCursor(cal), -7); cal._draw(); },
        next(cal) { cal._dayCursor = tz.addDays(dayCursor(cal), 7); cal._draw(); },
        todayDir(cal) {
            const ks = weekKeysFor(dayCursor(cal), weekStartOf(cal));
            const t = tz.todayKey(cal.timezone);
            if (t < ks[0]) return 'left';
            if (t > ks[6]) return 'right';
            return null;
        },
        goTo(cal, year, month, day) {
            cal._dayCursor = year + '-' + tz.pad(month) + '-' + tz.pad(day || 1); cal._draw();
        },
        pickerRef(cal) {
            const d = dayCursor(cal);
            return { year: +d.slice(0, 4), month: +d.slice(5, 7), day: +d.slice(8, 10) };
        },
    },
    month: {
        label: 'Month', render: renderMonth, navModel: 'paged',
        title(cal) {
            const c = monthCursor(cal);
            return tz.dayLabel(c.year + '-' + tz.pad(c.month) + '-01', { month: 'long', year: 'numeric' });
        },
        today(cal) {
            const t = tz.partsInZone(new Date(), cal.timezone);
            cal._monthCursor = { year: t.year, month: t.month };
            cal._draw();
        },
        prev(cal) { cal._monthCursor = shiftMonth(monthCursor(cal), -1); cal._draw(); },
        next(cal) { cal._monthCursor = shiftMonth(monthCursor(cal), 1); cal._draw(); },
        todayDir(cal) {
            const t = tz.partsInZone(new Date(), cal.timezone);
            const c = monthCursor(cal);
            const cv = c.year * 12 + c.month, tv = t.year * 12 + t.month;
            return cv > tv ? 'up' : (cv < tv ? 'down' : null);
        },
        goTo(cal, year, month) { cal._monthCursor = { year: year, month: month }; cal._draw(); },
        pickerRef(cal) { return monthCursor(cal); },
    },
    list: {
        label: 'List', render: renderList, navModel: 'scroll',
        title(cal) { return cal._listTopMonth || ''; },
        today(cal) { cal._listAnchor = null; cal._draw(); },     // re-render anchored at today
        prev(cal) { pageBody(cal, -1); },
        next(cal) { pageBody(cal, 1); },
        todayDir(cal) { return cal._listTodayDir || null; },
        goTo(cal, year, month) { cal._listAnchor = year + '-' + tz.pad(month) + '-01'; cal._draw(); },
        pickerRef(cal) {
            if (cal._listTopYM) return cal._listTopYM;
            const t = tz.partsInZone(new Date(), cal.timezone);
            return { year: t.year, month: t.month };
        },
    },
};
Calendar.exporters = { csv: exportCsv, ical: exportIcal };

// Version. Keep in sync with the axe.css / calendar.css headers and
// the --axe-version property; read at runtime via Calendar.version.
Calendar.version = '1.8.0';

// Shared internals exposed for the month view (slice 2),
// exporters (slice 3), and unit tests.
Calendar.parse = parseICal;
Calendar.tz = tz;
Calendar._util = {
    escHtml, elem, eventDayRange, startSortKey, categoryHue, statusClass,
    unescapeText, parseDate, parseRRule, expandRecurring
};

if (typeof global !== 'undefined' && global) global.Calendar = Calendar;
if (typeof module !== 'undefined' && module.exports) module.exports = Calendar;

})(typeof window !== 'undefined' ? window : this);
