# Axe

Axe renders documents on-brand. A semantic CSS base styles plain HTML, and a matching set of components renders the standardized text formats the browser won't — CSV, Markdown, and iCalendar. One variable contract drives all of it, so point Axe at any of them and it comes out looking like your site.

It doesn't sit in a familiar category, and it isn't trying to. It isn't a utility framework (Tailwind), a component library (Bootstrap), or a design system. It's a small framework plus a curated set of components, held together by one idea: every piece takes a document and renders it on-brand through the same variable contract. The CSS base does that for semantic HTML; the components do it for the document formats HTML leaves on the floor.

## What Axe Is

The web runs on a document metaphor. A server sends a document and the requestor renders it; a browser, at its core, is a document viewer. But it's a selective one. It renders HTML, images, and PDF natively, and for nearly everything else it gives up and downloads the file. The axe viewer picks up a defined slice of what the browser abandons: standardized, text-based formats that carry visual structure worth rendering and have no native browser renderer. CSV, Markdown, iCalendar. It's the renderer the browser never shipped — point it at one of those files with `?url=`, and it renders it on-brand. (Browsing the directories that hold those files is a separate tool, [browse](https://github.com/anderix/browse), which hands each file back to this viewer to render.)

That boundary is a door policy, not an accident. A format earns a place in the viewer when it is text, standardized, structurally renderable, and unrendered by browsers. JSON is already handled by browsers, so it stays out. YAML and TOML are configuration rather than documents, so they stay out. The set is curated on purpose — which is why this is the axe viewer, not a universal one.

The components carry no look of their own, and that is deliberate. A standalone widget ships its own complete styling and imposes it on every host; an axe component ships almost none and wears the host's identity through the variable contract instead. That dependence is the reason the components live inside Axe rather than as separate libraries. They are built on the CSS base as a substrate, not decorated by it as a convenience — pull the base out from under the calendar and its toolbar buttons drop to bare browser defaults. The coupling isn't a packaging detail to engineer away; it is what the components are for. They are the proof that the contract is worth depending on.

The viewer reads, it never writes. It fetches a representation and renders it: no upload, no delete, no write surface. That is the document metaphor held to its word — a browser doesn't write to the server to render a page, and neither does the viewer.

## Quick Start

1. Copy the `axe/` folder into your project.
2. Create a `brand.css` defining your colors, fonts, and shape (or use the brand builder to generate one).
3. Import both in your project CSS or HTML:

```html
<link rel="stylesheet" href="brand.css">
<link rel="stylesheet" href="axe/axe.css">
```

4. Write semantic HTML. No classes required for standard elements.

## Running Locally

A page styled with Axe opens straight from disk — the CSS and the vendored scripts load over `file://` with no server needed. The viewers in `view/` are different: they `fetch()` the file you point them at, and browsers block `fetch()` of local files (every `file://` document is treated as its own opaque origin), so a viewer pointed at a local document over `file://` will report "Could not load." The fix is to serve the files over HTTP — any static server works, and no PHP or other backend is involved. The recommended option is Python's built-in server, since it's present wherever Python is:

```bash
cd path/to/axe          # or your project root
python3 -m http.server 8000
# then open http://localhost:8000/view/?url=sample.csv
```

Any other static server does the job too — for example `php -S localhost:8000` if you already have PHP on hand.

## Shipping Documents (cleave)

When you want to hand someone a rendered document they can just open — no server, no internet — bake it with `tools/cleave.py`. It inlines the document and only the assets that format needs into one self-contained `.html` that the viewer renders in place (over `file://`), sidestepping the fetch restriction above.

```bash
tools/cleave.py report.md            # -> report.html (a document)
tools/cleave.py deck.md --slides     # -> deck.html (a slide deck)
tools/cleave.py data.csv             # -> data.html (an interactive table)
tools/cleave.py team.ics             # -> team.html (a calendar)
tools/cleave.py report.md --brand mybrand.css   # inline a brand palette
```

For Markdown the render mode follows the same rules as the live viewer: `--slides` (or a `mode: slides` frontmatter key) makes a deck, otherwise it's a document. The output is portable and offline — email it, drop it on a share, open it from a USB stick. cleave finds the Axe assets relative to its own location, so symlinking it onto your PATH works: `ln -s "$PWD/tools/cleave.py" ~/bin/cleave`. One caveat: the default output name swaps the extension for `.html`, so `report.md` and `report.csv` would both target `report.html` — pass an explicit output name to disambiguate.

## Structure

```
axe.css               Framework core. Projects import brand.css + axe.css.
default.css           Default brand baseline (a complete set of contract vars).
                      Sites override it with their own brand.css.
theme.js              Theme detection and toggle. Include in <head>.
calendar.js           iCalendar (.ics) engine: parser, day/week/month/list views, CSV/iCal export.
calendar.css          Calendar styles. Uses the variable contract only.
sample.csv            Demo CSV (also the CSV-view demo and fixture).
sample.md             Demo Markdown document (also the document-view demo and fixture).
sample.ics            Demo calendar feed (also the viewer demo and round-trip fixture).
sample-slides.md      Demo slide deck (also the slides-view demo and fixture).
kitchen-sink.html     Reference page showing all styled HTML elements.
README.md             This file.
dependencies/
  marked.min.js       Markdown parser for the viewer (MIT licensed).
  purify.min.js       DOMPurify — sanitizes rendered Markdown (Apache-2.0 / MPL-2.0).
tools/
  brand-builder.html  Generates brand.css from color, font, shape, and shadow inputs.
  cleave.py           Bakes a CSV/Markdown/iCalendar file into one self-contained
                      HTML file that renders from disk (file://) with no server.
view/
  index.html          Axe viewer: renders one CSV, Markdown, or iCalendar file. ?url=path/to/file
                      Markdown renders as a document or, with ?view=slides (or mode: slides
                      frontmatter), as a native slide deck.
```

## How Projects Use Axe

Each project provides its own `brand.css` defining the visual identity. `axe.css` is universal and shared. Project-specific component classes go in the project's own stylesheet.

```css
@import url('brand.css');
@import url('axe/axe.css');

/* Project-specific styles below */
```

## Layout

Axe provides two layout containers:

`<main>` is a full-width container (max 1100px, no surface background). Use it for app-like pages.

`<article>` is a constrained document panel (max 860px, surface background, shadow). Use it for prose and documents.

`<section>` groups content with border separators.

`.grid` is the only class the CSS base adds. It creates a responsive card grid. Children can be `<article>` or `<a>` elements. (The document components carry their own classes, namespaced under `.axe-cal` and the viewer chrome.)

## Calendar (iCalendar)

The axe viewer renders `.ics` / `.ical` feeds the same way it renders CSV and Markdown. Point it at a feed and it opens with a component-owned toolbar above a scrolling view body: Day, Week, Month, and List tabs, a Today button with a direction arrow, prev/next navigation, a clickable title that opens a date picker, a timezone selector, and CSV / iCal export. On a narrow screen the right cluster collapses into a hamburger and List becomes the default view.

```
view/index.html?url=path/to/feed.ics
view/index.html?url=path/to/feed.ics&view=week
```

Append `&view=` to open on a specific view — `day`, `week`, `month`, or `list`. It's the same `?view=` parameter Markdown uses for `doc`/`slides`, its valid values keyed to the file type. Omit it (or pass anything unrecognized) and the calendar opens on Month, exactly as before — on a narrow screen the existing responsive override still makes List the default.

`calendar.js` is the engine behind it: a single classic script with no dependencies and no build step, the same relationship `marked.min.js` has with Markdown. It parses RFC 5545 iCalendar, recurrence included, and renders four views — a Day and Week time grid with overlap-aware event columns and a live current-time line, a Month grid with true multi-day spanning bars, and a lazy-loading List — then exports back to CSV (RFC 4180) or iCalendar (round-trip stable). It also embeds in any page on its own.

```html
<link rel="stylesheet" href="calendar.css">
<script src="calendar.js"></script>
<div id="cal"></div>
<script>
  const cal = new Calendar(document.getElementById('cal'), {
    url: 'feed.ics',             // or source: '<raw iCal text>'
    view: 'month',               // 'day' | 'week' | 'month' (default) | 'list'
    timezone: 'America/Chicago'  // optional; defaults to the browser zone
  });
  cal.render();
</script>
```

After it loads, `cal.switchView('list')`, `cal.setTimezone('UTC')`, `cal.filter(e => …)`, and `cal.export('csv' | 'ical')` drive it.

The parser is standards-only: it reads compliant iCalendar and carries no vendor-specific branches. A feed that encodes data in a non-standard way (Scoutbook, for instance, writes all-day events as timed midnight-to-23:45) should be normalized by whatever serves it, never patched for inside the engine.

### Category colors

Event chips and bars are tinted by a per-event hue, computed deterministically from the category name in `calendar.js`. Color is always a redundant cue — the label rides along — so the calendar stays readable when it's ignored. The shared saturation and lightness, plus the fallback hue for uncategorized events, come from three brand tokens so a site can tune them (including per theme); they default to a mid blue and `404` harmlessly back to in-component fallbacks when undefined.

| Variable             | Default | Purpose                                       |
|----------------------|---------|-----------------------------------------------|
| --cal-cat-hue        | 210     | Fallback hue for events with no category      |
| --cal-cat-saturation | 55%     | Saturation of all categorical chips and bars  |
| --cal-cat-lightness  | 50%     | Lightness of all categorical chips and bars   |

### Remote feeds and CORS

External `?url=` fetches are denied by default for security (see [SECURITY.md](SECURITY.md)); enable specific hosts via `EXTERNAL_ALLOWLIST` in `view/index.html`. Even once allowlisted, the viewer fetches in the browser, so a remote feed only loads if that origin sends `Access-Control-Allow-Origin` — most calendar feeds don't. A locked-down remote feed needs a same-origin proxy that re-serves it, and that proxy is also the right place to normalize any non-standard encoding before the calendar sees it. Local and same-origin files load directly and are unaffected by the allowlist.

## Dark Mode

Brand files generated by the brand builder include light mode, dark mode, and system preference support out of the box. Include `theme.js` in your `<head>` to detect system preference and restore saved choices. Add a `<button class="theme-toggle" aria-label="Toggle theme"></button>` anywhere in your page to let users switch themes. Both the button styles and the script behavior are part of the framework.

Leave that button empty and the framework draws the icon for you — a sun in light mode, a moon in dark — tracking the resolved theme so it agrees with the painted page even before `theme.js` runs. The button must be genuinely empty (`:empty` matches no child nodes, not even whitespace, so write the tags adjacent), and it still needs an `aria-label` since the glyph is decorative. To use different icons, redefine `--theme-toggle-icon-light` and `--theme-toggle-icon-dark` in your brand or site CSS; their values are CSS `content` strings (for example `"\2600"` for ☀). Put your own markup inside the button instead and the default glyph steps aside.

## Variable Contract

Variables are split into two groups: a **required contract** that `axe.css` depends on, and an **extended palette** that the brand builder generates for convenience but that `axe.css` never references.

### Required contract

`axe.css` may only reference variables in this list. Any `brand.css` must define them. Adding a new variable to `axe.css` requires adding it here and to the brand builder output.

| Variable                | Purpose                              |
|-------------------------|--------------------------------------|
| --color-bg              | Page background                      |
| --color-surface         | Card, main, elevated surface         |
| --color-text            | Primary body text                    |
| --color-text-muted      | Secondary / caption text             |
| --color-border          | Borders and dividers                 |
| --color-accent          | Links, buttons, primary emphasis     |
| --color-accent-hover    | Hover state for accent               |
| --color-highlight       | Marks, highlights, secondary accent  |
| --color-highlight-hover | Hover state for highlight            |
| --color-nav-bg          | Navigation background                |
| --color-nav-text        | Navigation link color                |
| --color-danger          | Errors, destructive actions, now-line |
| --color-success         | Confirmation, positive status        |
| --color-warning         | Caution, pending status              |
| --font-body             | Body typeface                        |
| --font-heading          | Heading typeface                     |
| --font-mono             | Code and monospace                   |
| --line-height           | Base line height                     |
| --radius                | Border radius (all corners)          |
| --shadow                | Subtle elevation shadow              |
| --shadow-md             | Medium elevation shadow              |

### Extended palette

The brand builder generates these from the two color inputs (primary and accent). `axe.css` never references them, but they're documented here so projects can use them consistently across brand guides, component styles, and overrides. They're theme-independent (unchanged between light and dark mode) since they describe the raw brand palette rather than UI roles.

| Variable                | Purpose                                           |
|-------------------------|---------------------------------------------------|
| --primary               | Primary brand color (raw input)                   |
| --primary-tint-1/2/3    | Progressively lighter mixes toward white          |
| --primary-shade-1/2/3   | Progressively darker mixes toward black           |
| --secondary             | Accent brand color (raw input)                    |
| --secondary-tint-1/2/3  | Progressively lighter mixes toward white          |
| --secondary-shade-1/2/3 | Progressively darker mixes toward black           |

Tints and shades are generated by RGB mixing toward white or black at stops of 30%, 60%, and 85%. RGB mixing desaturates tints naturally, producing UI-functional neutrals rather than saturated color ramps.

## Design Rules

**Build what you need, not what you might need.** A pattern enters the framework when a real project requires it. No speculative additions.

**Semantic first.** Style HTML elements directly before reaching for classes. If a `<button>` can look right without a class, it should.

**`brand.css` is always project-specific. `axe.css` is universal.** `axe.css` must work with any valid `brand.css`. Never hard-code colors, fonts, or radii in `axe.css`.

**Mobile first.** Base styles target small screens. Use `min-width` media queries to expand.

**JavaScript only where rendering needs it.** The CSS base is styling alone; `theme.js` adds theme detection and the toggle. The components that render documents — the calendar engine behind the viewer — carry their own JavaScript, with no build step and a small set of vendored dependencies (a Markdown parser and a sanitizer). A component earns its script by rendering a format CSS can't.

**When in doubt, put it in the project first.** Promote to the framework when a second project needs it.

## Security

The viewer renders document content as live HTML in your site's origin, so treat every document you point it at as code. Markdown is sanitized with DOMPurify and calendar event URLs are scheme-checked before they become links, but those are mitigations, not a license to render untrusted input freely. External `?url=` fetches are denied by default. Before you deploy the viewer, read [SECURITY.md](SECURITY.md) — it covers the threat model, the `EXTERNAL_ALLOWLIST` knob, and the operator responsibilities the framework cannot enforce for you. (The directory-browsing tool [browse](https://github.com/anderix/browse) carries its own server-side lister and its own `SECURITY.md`.)

## Versioning

Axe carries a single version number so you can tell which build a site is running — it's vendored into several projects, and copies drift. The number is stamped in the file headers (`axe.css`, `calendar.css`, `calendar.js`), exposed as the `--axe-version` custom property, and as `Calendar.version`. To audit a deployment, `curl https://site/axe/axe.css | head`, or read `getComputedStyle(document.documentElement).getPropertyValue('--axe-version')` (or `Calendar.version`) in the console. Bump all of those together on release.

This is a deploy-tracking stamp, not a strict semver contract; git remains the source of truth for what changed. What changed in each release, including breaking changes to variable names, lives on the [releases page](https://github.com/excelano/axe/releases).

The working copy is stamped with a plain release version — no `-dev` suffix. Most consumers (`anderix.com`, `excelano.com`, `troop99.org`, `xinglet.com`) ride the `axe -> ~/axe` symlink, so they deploy whatever the working copy holds the next time `updatesite` runs; there is no separate vendor step to lag behind. Stamp the version you're shipping the moment you make the change (via `./set-version.sh`), and that's what those sites report on their next deploy. The only true hard copies are projects like [interpreter-strip](https://github.com/anderix/interpreter-strip) that vendor a subset of files by hand; re-vendor those in the same pass when a change affects them.

---

Built with the assistance of Claude (Anthropic).
