/* ============================================================
   AXE TOML v1.8.0
   A TOML v1.0.0 parser for axe.

   The axe viewer renders .toml with this engine the same way it
   renders .ics with calendar.js. It also exposes TOML.parse for
   use in any page.

   No dependencies, no build step, no modules. One classic script.
   The parser produces data only; the viewer owns the markup.

   Written to the specification rather than to any one document:
   every rule here comes from TOML v1.0.0, and the parser is
   validated against the official toml-lang/toml-test suite.

   Two output shapes, because the viewer and a caller want
   different things:

     TOML.parse(text)        Plain JavaScript values. Tables become
                             objects, arrays become arrays, dates
                             become TOML.Date. Integers outside the
                             safe range stay BigInt rather than
                             silently losing digits.

     TOML.parse(text, {typed: true})
                             A typed tree: every value is a node
                             carrying its TOML type, its parsed
                             value, and the literal it was written
                             as. The viewer renders from this,
                             because "1500.00" and "1500" are the
                             same number and different documents.

   Invalid input throws TOML.SyntaxError with line and column.

   Author: David M. Anderson
   Built with AI assistance (Claude, Anthropic)
   ============================================================ */

(function (global) {
'use strict';

// ============================================================
// Errors
// ============================================================

class TomlSyntaxError extends Error {
    constructor(message, line, column) {
        super(message + ' (line ' + line + ', column ' + column + ')');
        this.name = 'TomlSyntaxError';
        this.line = line;
        this.column = column;
    }
}

// ============================================================
// Date and time
//
// TOML has four temporal types and they are not interchangeable:
// an offset date-time is an instant, while the three local types
// are deliberately not. Collapsing them all into a JS Date would
// invent a timezone the document never stated, so the local kinds
// keep their literal and expose toDate() as null.
// ============================================================

class TomlDate {
    constructor(type, raw, date) {
        this.type = type;      // datetime | datetime-local | date-local | time-local
        this.raw = raw;        // exactly as written in the document
        this._date = date;     // a JS Date only for offset date-times
    }
    toDate() { return this._date ? new Date(this._date.getTime()) : null; }
    toString() { return this.raw; }
    toJSON() { return this.raw; }
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(y) {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
    return m === 2 && isLeapYear(y) ? 29 : DAYS_IN_MONTH[m - 1];
}

// ============================================================
// Scanner
// ============================================================

// Sticky patterns, matched at the cursor. Order matters where they
// overlap: the date/time forms are tried longest-first so that
// "1979-05-27 07:32:00" reads as one date-time and "1979-05-27"
// followed by a comma reads as a local date.
const RE_OFFSET_DATETIME = /(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:([Zz])|([+-])(\d{2}):(\d{2}))/y;
const RE_LOCAL_DATETIME  = /(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?/y;
const RE_LOCAL_DATE      = /(\d{4})-(\d{2})-(\d{2})/y;
const RE_LOCAL_TIME      = /(\d{2}):(\d{2}):(\d{2})(\.\d+)?/y;

// Numbers. Prefixed forms take no sign; the decimal forms do.
const RE_HEX   = /0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*/y;
const RE_OCT   = /0o[0-7](?:_?[0-7])*/y;
const RE_BIN   = /0b[01](?:_?[01])*/y;
const RE_SPECIAL_FLOAT = /[+-]?(?:inf|nan)/y;
// A float needs a fraction, an exponent, or both — otherwise it is an integer.
const RE_FLOAT = /[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\.[0-9](?:_?[0-9])*(?:[eE][+-]?[0-9](?:_?[0-9])*)?|[eE][+-]?[0-9](?:_?[0-9])*)/y;
const RE_INT   = /[+-]?(?:0|[1-9](?:_?[0-9])*)/y;
const RE_BARE_KEY = /[A-Za-z0-9_-]+/y;

const INT_MIN = -9223372036854775808n;
const INT_MAX = 9223372036854775807n;

function isBareKeyChar(c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
           (c >= '0' && c <= '9') || c === '_' || c === '-';
}

// Control characters are forbidden in strings and comments. Tab is
// the one exception, and newline is handled by the caller that
// knows whether a newline is legal where it stands.
function isControl(code) {
    return (code >= 0x00 && code <= 0x08) || (code >= 0x0A && code <= 0x1F) || code === 0x7F;
}

class Parser {
    constructor(src) {
        src = String(src);
        // A leading BOM is not part of the document.
        if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);
        // CRLF is a newline; a lone CR is a control character and is
        // rejected wherever the scan later runs into it.
        this.s = src.replace(/\r\n/g, '\n');
        this.i = 0;
        this.n = this.s.length;
        this.root = newTable({ explicit: false });
    }

    // --- position and errors ---

    err(message, at) {
        const idx = at === undefined ? this.i : at;
        let line = 1, col = 1;
        for (let k = 0; k < idx && k < this.n; k++) {
            if (this.s[k] === '\n') { line++; col = 1; } else col++;
        }
        throw new TomlSyntaxError(message, line, col);
    }

    eof() { return this.i >= this.n; }
    peek(k) { return this.s[this.i + (k || 0)]; }
    match(str) { return this.s.startsWith(str, this.i); }

    // --- trivia ---

    skipInlineWs() {
        while (this.i < this.n && (this.s[this.i] === ' ' || this.s[this.i] === '\t')) this.i++;
    }

    skipComment() {
        if (this.peek() !== '#') return false;
        this.i++;
        while (this.i < this.n && this.s[this.i] !== '\n') {
            const code = this.s.charCodeAt(this.i);
            if (isControl(code) && code !== 0x09) this.err('control character in comment');
            this.i++;
        }
        return true;
    }

    // Whitespace, comments and newlines: legal between statements and
    // inside array literals.
    skipTrivia() {
        for (;;) {
            this.skipInlineWs();
            if (this.skipComment()) continue;
            if (this.peek() === '\n') { this.i++; continue; }
            return;
        }
    }

    // A statement runs to the end of its line. Anything else left on
    // the line is a syntax error rather than something to ignore.
    endOfStatement() {
        this.skipInlineWs();
        this.skipComment();
        if (this.eof()) return;
        if (this.s[this.i] === '\n') { this.i++; return; }
        this.err('unexpected "' + this.s[this.i] + '" after value');
    }

    // --- document ---

    parseDocument() {
        let current = this.root;
        for (;;) {
            this.skipTrivia();
            if (this.eof()) break;
            if (this.peek() === '[') {
                current = this.parseHeader();
            } else {
                this.parseKeyValue(current, false);
                this.endOfStatement();
            }
        }
        return this.root;
    }

    // [table] and [[array of tables]]
    parseHeader() {
        const start = this.i;
        this.i++;                                  // consume [
        const isArray = this.peek() === '[';
        if (isArray) this.i++;
        this.skipInlineWs();
        const keys = this.parseKey();
        this.skipInlineWs();
        if (isArray) {
            if (!this.match(']]')) this.err('expected "]]" to close the table array header', start);
            this.i += 2;
        } else {
            if (this.peek() !== ']') this.err('expected "]" to close the table header', start);
            this.i++;
        }
        const table = this.resolveHeader(keys, isArray, start);
        this.endOfStatement();
        return table;
    }

    // --- keys ---

    // A key is one or more parts joined by dots. Returns the parts
    // with quoting resolved, so ["a", "b"] for both a.b and "a".b.
    parseKey() {
        const parts = [];
        for (;;) {
            this.skipInlineWs();
            const c = this.peek();
            // A quoted key may be a basic or literal string but never a
            // multi-line one: a key has to fit on the line it is written on.
            if (c === '"' || c === "'") {
                if (this.match('"""') || this.match("'''")) this.err('a multi-line string cannot be used as a key');
                parts.push(c === '"' ? this.parseBasicString() : this.parseLiteralString());
            } else if (c !== undefined && isBareKeyChar(c)) {
                RE_BARE_KEY.lastIndex = this.i;
                const m = RE_BARE_KEY.exec(this.s);
                parts.push(m[0]);
                this.i = RE_BARE_KEY.lastIndex;
            } else {
                this.err('expected a key');
            }
            this.skipInlineWs();
            if (this.peek() === '.') { this.i++; continue; }
            return parts;
        }
    }

    parseKeyValue(table, inline) {
        const keys = this.parseKey();
        this.skipInlineWs();
        if (this.peek() !== '=') this.err('expected "=" after key');
        this.i++;
        this.skipInlineWs();
        if (this.eof() || this.peek() === '\n') this.err('expected a value after "="');
        const value = this.parseValue();
        this.assign(table, keys, value, inline);
    }

    // --- structure ---

    // Walk a dotted key and store the value at the end of it. The
    // intermediate tables a dotted key creates are closed to later
    // [header] definitions, which is what `dotted` records.
    assign(table, keys, value, inline) {
        let cur = table;
        for (let k = 0; k < keys.length - 1; k++) {
            const key = keys[k];
            let next = cur.value.get(key);
            if (next === undefined) {
                next = newTable({ dotted: true });
                cur.value.set(key, next);
            } else if (next.type !== 'table') {
                this.err('cannot redefine "' + key + '" as a table');
            } else if (next.inline) {
                this.err('cannot add keys to inline table "' + key + '"');
            } else if (next.explicit) {
                this.err('"' + key + '" is already defined as a table');
            }
            cur = next;
        }
        const last = keys[keys.length - 1];
        if (cur.value.has(last)) this.err('duplicate key "' + last + '"');
        cur.value.set(last, value);
    }

    // Resolve a [header] or [[header]] to the table that subsequent
    // key/value pairs belong to.
    resolveHeader(keys, isArray, start) {
        let cur = this.root;
        for (let k = 0; k < keys.length - 1; k++) {
            const key = keys[k];
            let next = cur.value.get(key);
            if (next === undefined) {
                next = newTable({ implicit: true });
                cur.value.set(key, next);
            } else if (next.type === 'array') {
                // Descending through an array of tables means "the one
                // most recently opened", which is how [[a]] then [a.b]
                // attaches b to the last a.
                if (!next.aot) this.err('"' + key + '" is a static array, not a table', start);
                next = next.value[next.value.length - 1];
            } else if (next.type !== 'table') {
                this.err('"' + key + '" is not a table', start);
            } else if (next.inline) {
                this.err('cannot add keys to inline table "' + key + '"', start);
            }
            // A table built by a dotted key may be passed through — the
            // spec allows [fruit.apple.texture] after apple.color = "red",
            // and only forbids naming the dotted table itself as a header.
            // That case is the final key, checked below.
            cur = next;
        }

        const last = keys[keys.length - 1];
        let node = cur.value.get(last);

        if (isArray) {
            if (node === undefined) {
                node = { type: 'array', value: [], aot: true, static: false };
                cur.value.set(last, node);
            } else if (node.type !== 'array') {
                this.err('"' + last + '" is already defined and is not a table array', start);
            } else if (!node.aot) {
                this.err('cannot append to static array "' + last + '"', start);
            }
            const entry = newTable({ explicit: true });
            node.value.push(entry);
            return entry;
        }

        if (node === undefined) {
            node = newTable({ explicit: true });
            cur.value.set(last, node);
            return node;
        }
        if (node.type !== 'table') this.err('duplicate key "' + last + '"', start);
        if (node.explicit) this.err('table "' + last + '" is already defined', start);
        if (node.inline) this.err('cannot reopen inline table "' + last + '"', start);
        if (node.dotted) this.err('"' + last + '" was defined by a dotted key and cannot be reopened', start);
        // It existed only as an intermediate; this header defines it.
        node.explicit = true;
        node.implicit = false;
        return node;
    }

    // --- values ---

    parseValue() {
        const c = this.peek();
        if (c === '"') return str(this.parseBasicString());
        if (c === "'") return str(this.parseLiteralString());
        if (c === '[') return this.parseArray();
        if (c === '{') return this.parseInlineTable();
        if (c === 't' || c === 'f') return this.parseBoolean();
        return this.parseNumberOrDate();
    }

    // After a scalar, the only things that may follow are whitespace,
    // a separator, a closing bracket, a comment, or the end of a line.
    // Without this check "1979-05-27T07:32" would read as a local date
    // with trailing garbage instead of an error.
    expectValueEnd(what) {
        if (this.eof()) return;
        const c = this.s[this.i];
        if (c === ' ' || c === '\t' || c === '\n' || c === ',' ||
            c === ']' || c === '}' || c === '#') return;
        this.err('unexpected "' + c + '" after ' + what);
    }

    parseBoolean() {
        if (this.match('true')) { this.i += 4; this.expectValueEnd('boolean'); return { type: 'boolean', value: true, raw: 'true' }; }
        if (this.match('false')) { this.i += 5; this.expectValueEnd('boolean'); return { type: 'boolean', value: false, raw: 'false' }; }
        this.err('expected a value');
    }

    parseNumberOrDate() {
        const start = this.i;

        // Dates before numbers: a date starts with digits too.
        let m = this.tryDate();
        if (m) { this.expectValueEnd(m.type); return m; }

        // Prefixed integers.
        for (const [re, radix, label] of [[RE_HEX, 16, 'hexadecimal'], [RE_OCT, 8, 'octal'], [RE_BIN, 2, 'binary']]) {
            re.lastIndex = start;
            const hit = re.exec(this.s);
            if (hit && hit.index === start) {
                this.i = re.lastIndex;
                this.expectValueEnd(label + ' integer');
                const digits = hit[0].slice(2).replace(/_/g, '');
                const value = BigInt((radix === 16 ? '0x' : radix === 8 ? '0o' : '0b') + digits);
                if (value < INT_MIN || value > INT_MAX) this.err('integer out of 64-bit range', start);
                return { type: 'integer', value: value, raw: hit[0] };
            }
        }

        RE_SPECIAL_FLOAT.lastIndex = start;
        let hit = RE_SPECIAL_FLOAT.exec(this.s);
        if (hit && hit.index === start) {
            this.i = RE_SPECIAL_FLOAT.lastIndex;
            this.expectValueEnd('float');
            const raw = hit[0];
            const value = raw.indexOf('nan') >= 0 ? NaN : (raw[0] === '-' ? -Infinity : Infinity);
            return { type: 'float', value: value, raw: raw };
        }

        RE_FLOAT.lastIndex = start;
        hit = RE_FLOAT.exec(this.s);
        if (hit && hit.index === start) {
            this.i = RE_FLOAT.lastIndex;
            this.expectValueEnd('float');
            return { type: 'float', value: parseFloat(hit[0].replace(/_/g, '')), raw: hit[0] };
        }

        RE_INT.lastIndex = start;
        hit = RE_INT.exec(this.s);
        if (hit && hit.index === start) {
            this.i = RE_INT.lastIndex;
            this.expectValueEnd('integer');
            const value = BigInt(hit[0].replace(/_/g, ''));
            if (value < INT_MIN || value > INT_MAX) this.err('integer out of 64-bit range', start);
            return { type: 'integer', value: value, raw: hit[0] };
        }

        this.err('expected a value');
    }

    // Try the four temporal forms, longest first. Returns null when
    // the cursor isn't on a date at all, so the caller can fall
    // through to numbers.
    tryDate() {
        const start = this.i;

        RE_OFFSET_DATETIME.lastIndex = start;
        let m = RE_OFFSET_DATETIME.exec(this.s);
        if (m && m.index === start) {
            const y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], s = +m[6];
            this.checkDate(y, mo, d, start);
            this.checkTime(h, mi, s, start);
            let offsetMinutes = 0;
            if (!m[8]) {
                const oh = +m[10], om = +m[11];
                if (oh > 23 || om > 59) this.err('offset out of range', start);
                offsetMinutes = (oh * 60 + om) * (m[9] === '-' ? -1 : 1);
            }
            const frac = m[7] ? m[7] : '';
            const ms = frac ? Math.round(parseFloat('0' + frac) * 1000) : 0;
            const utc = Date.UTC(y, mo - 1, d, h, mi, Math.min(s, 59), ms) - offsetMinutes * 60000;
            const date = new Date(utc);
            if (y >= 0 && y <= 99) date.setUTCFullYear(y);
            this.i = RE_OFFSET_DATETIME.lastIndex;
            return { type: 'datetime', value: m[0], raw: m[0], date: date };
        }

        RE_LOCAL_DATETIME.lastIndex = start;
        m = RE_LOCAL_DATETIME.exec(this.s);
        if (m && m.index === start) {
            this.checkDate(+m[1], +m[2], +m[3], start);
            this.checkTime(+m[4], +m[5], +m[6], start);
            this.i = RE_LOCAL_DATETIME.lastIndex;
            return { type: 'datetime-local', value: m[0], raw: m[0], date: null };
        }

        RE_LOCAL_DATE.lastIndex = start;
        m = RE_LOCAL_DATE.exec(this.s);
        if (m && m.index === start) {
            this.checkDate(+m[1], +m[2], +m[3], start);
            this.i = RE_LOCAL_DATE.lastIndex;
            return { type: 'date-local', value: m[0], raw: m[0], date: null };
        }

        RE_LOCAL_TIME.lastIndex = start;
        m = RE_LOCAL_TIME.exec(this.s);
        if (m && m.index === start) {
            this.checkTime(+m[1], +m[2], +m[3], start);
            this.i = RE_LOCAL_TIME.lastIndex;
            return { type: 'time-local', value: m[0], raw: m[0], date: null };
        }

        return null;
    }

    checkDate(y, mo, d, at) {
        if (mo < 1 || mo > 12) this.err('month out of range', at);
        if (d < 1 || d > daysInMonth(y, mo)) this.err('day out of range for that month', at);
    }

    checkTime(h, mi, s, at) {
        if (h > 23) this.err('hour out of range', at);
        if (mi > 59) this.err('minute out of range', at);
        // 60 is a leap second, which RFC 3339 permits.
        if (s > 60) this.err('second out of range', at);
    }

    parseArray() {
        this.i++;                                   // consume [
        const items = [];
        for (;;) {
            this.skipTrivia();
            if (this.eof()) this.err('unterminated array');
            if (this.peek() === ']') { this.i++; break; }
            items.push(this.parseValue());
            this.skipTrivia();
            if (this.peek() === ',') { this.i++; continue; }
            if (this.peek() === ']') { this.i++; break; }
            this.err('expected "," or "]" in array');
        }
        return { type: 'array', value: items, aot: false, static: true };
    }

    // Inline tables are a single-line form: no newlines inside, no
    // trailing comma, and closed to extension once written.
    parseInlineTable() {
        this.i++;                                   // consume {
        const table = newTable({ inline: true, explicit: true });
        this.skipInlineWs();
        if (this.peek() === '}') { this.i++; return table; }
        for (;;) {
            this.skipInlineWs();
            if (this.peek() === '}') this.err('trailing comma is not allowed in an inline table');
            if (this.eof() || this.peek() === '\n') this.err('unterminated inline table');
            this.parseKeyValue(table, true);
            this.skipInlineWs();
            if (this.peek() === ',') { this.i++; continue; }
            if (this.peek() === '}') { this.i++; break; }
            if (this.eof() || this.peek() === '\n') this.err('unterminated inline table');
            this.err('expected "," or "}" in inline table');
        }
        return table;
    }

    // --- strings ---

    parseBasicString() {
        if (this.match('"""')) return this.parseMultiline('"""', true);
        this.i++;                                   // consume "
        let out = '';
        for (;;) {
            if (this.eof()) this.err('unterminated string');
            const c = this.s[this.i];
            if (c === '"') { this.i++; return out; }
            if (c === '\n') this.err('unterminated string');
            if (c === '\\') { out += this.readEscape(); continue; }
            const code = this.s.charCodeAt(this.i);
            if (isControl(code) && code !== 0x09) this.err('control character in string');
            out += c;
            this.i++;
        }
    }

    parseLiteralString() {
        if (this.match("'''")) return this.parseMultiline("'''", false);
        this.i++;                                   // consume '
        let out = '';
        for (;;) {
            if (this.eof()) this.err('unterminated string');
            const c = this.s[this.i];
            if (c === "'") { this.i++; return out; }
            if (c === '\n') this.err('unterminated string');
            const code = this.s.charCodeAt(this.i);
            if (isControl(code) && code !== 0x09) this.err('control character in string');
            out += c;
            this.i++;
        }
    }

    // Both multi-line forms share their delimiter handling: a newline
    // straight after the opening delimiter is dropped, and one or two
    // quote characters may sit against the closing delimiter (so
    // """he said "hi"""" ends with a quote, not a syntax error).
    parseMultiline(delim, escapes) {
        const quote = delim[0];
        this.i += 3;
        if (this.peek() === '\n') this.i++;
        let out = '';
        for (;;) {
            if (this.eof()) this.err('unterminated string');
            const c = this.s[this.i];
            if (c === quote) {
                let q = 0;
                while (this.s[this.i + q] === quote) q++;
                if (q >= 3) {
                    if (q > 5) this.err('too many quote characters before the closing delimiter');
                    out += quote.repeat(q - 3);
                    this.i += q;
                    return out;
                }
                out += quote.repeat(q);
                this.i += q;
                continue;
            }
            if (escapes && c === '\\') {
                // A backslash at end of line swallows the newline and
                // all whitespace up to the next real character.
                let k = this.i + 1;
                while (k < this.n && (this.s[k] === ' ' || this.s[k] === '\t')) k++;
                if (k < this.n && this.s[k] === '\n') {
                    this.i = k + 1;
                    while (this.i < this.n && ' \t\n'.indexOf(this.s[this.i]) >= 0) this.i++;
                    continue;
                }
                out += this.readEscape();
                continue;
            }
            const code = this.s.charCodeAt(this.i);
            if (code !== 0x0A && isControl(code) && code !== 0x09) this.err('control character in string');
            out += c;
            this.i++;
        }
    }

    readEscape() {
        const start = this.i;
        this.i++;                                   // consume backslash
        const c = this.s[this.i];
        if (c === undefined) this.err('unterminated escape', start);
        this.i++;
        switch (c) {
            case 'b': return '\b';
            case 't': return '\t';
            case 'n': return '\n';
            case 'f': return '\f';
            case 'r': return '\r';
            case '"': return '"';
            case '\\': return '\\';
            case 'u': return this.readCodepoint(4, start);
            case 'U': return this.readCodepoint(8, start);
            default: this.err('unknown escape "\\' + c + '"', start);
        }
    }

    readCodepoint(len, start) {
        const hex = this.s.substr(this.i, len);
        if (hex.length < len || !/^[0-9A-Fa-f]+$/.test(hex)) this.err('malformed unicode escape', start);
        this.i += len;
        const code = parseInt(hex, 16);
        // Surrogate halves are not scalar values, so they cannot be
        // written as an escape even though they are valid UTF-16.
        if (code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) {
            this.err('escape is not a unicode scalar value', start);
        }
        return String.fromCodePoint(code);
    }
}

// ============================================================
// Nodes
// ============================================================

function newTable(flags) {
    const t = {
        type: 'table',
        value: new Map(),
        explicit: false,   // written as [header] or as an inline table
        implicit: false,   // created as an intermediate of a longer header
        dotted: false,     // created by a dotted key; closed to [header]
        inline: false      // written as { ... }; closed to everything
    };
    if (flags) Object.assign(t, flags);
    return t;
}

function str(value) {
    return { type: 'string', value: value, raw: value };
}

// ============================================================
// Typed tree -> plain values
// ============================================================

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = -MAX_SAFE;

function strip(node) {
    switch (node.type) {
        case 'table': {
            const out = {};
            node.value.forEach((v, k) => { out[k] = strip(v); });
            return out;
        }
        case 'array':
            return node.value.map(strip);
        case 'integer':
            // Beyond 2^53 a Number would quietly lose digits, so those
            // stay BigInt rather than come back wrong.
            return (node.value >= MIN_SAFE && node.value <= MAX_SAFE) ? Number(node.value) : node.value;
        case 'string':
        case 'float':
        case 'boolean':
            return node.value;
        default:
            return new TomlDate(node.type, node.raw, node.date);
    }
}

// ============================================================
// Public surface
// ============================================================

function parse(text, options) {
    const root = new Parser(text).parseDocument();
    return (options && options.typed) ? root : strip(root);
}

const TOML = {
    parse: parse,
    Date: TomlDate,
    SyntaxError: TomlSyntaxError,
    // Version. Keep in sync with the axe.css / calendar.js headers and
    // the --axe-version property; read at runtime via TOML.version.
    version: '1.8.0'
};

if (typeof global !== 'undefined' && global) global.TOML = TOML;
if (typeof module !== 'undefined' && module.exports) module.exports = TOML;

})(typeof window !== 'undefined' ? window : this);
