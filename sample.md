# Sample Document

This file is the Markdown demo for the Axe viewer. Open it with `?url=sample.md` to see prose, headings, lists, tables, and code rendered on the brand's variable contract. The same file rendered with `?view=slides` becomes a deck — see `sample-slides.md` for one written deliberately as slides.

## What the viewer renders

The viewer reads a single text file and renders it as live HTML, sanitized with DOMPurify. It never writes: no upload, no delete, no edit. Markdown, CSV, TSV, and iCalendar each have a renderer; anything else the browser is asked to handle directly.

## Formatting it supports

Markdown rendered here carries the usual range: **bold**, *italic*, `inline code`, and [links](https://github.com/excelano/axe). Lists work too:

- Each item sits on the brand's body type and spacing
- Nested lists indent predictably
- Ordered and unordered both render

## A table

| Element | Variable | Role |
|---------|----------|------|
| Body text | `--color-text` | Primary ink |
| Links | `--color-accent` | Brand accent |
| Rules | `--color-border` | Quiet dividers |

## A code block

```bash
# serve a site locally, then open the viewer
php -S localhost:8000
open "http://localhost:8000/axe/view/?url=sample.md"
```

## A callout

> Everything above is driven by the same brand contract as the rest of Axe, so a document rendered in the viewer matches the site it sits beside — no separate document stylesheet to maintain.
