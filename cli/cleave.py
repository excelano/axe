#!/usr/bin/env python3
"""cleave - Bake an Axe-rendered document into one self-contained HTML file.

Usage:
  cleave <input.{csv,tsv,md,markdown,ics,ical}> [output.html]
         [--slides | --view doc|slides] [--brand brand.css] [--name LABEL]

Produces a single portable .html with the document and only the assets that
format needs inlined, so the recipient can open it straight from disk
(file://) with no server and no internet -- the Axe viewer renders it in
place. This is the ship-it counterpart to the live viewer, which needs an
HTTP server because it fetch()es the document (browsers block fetch() of
local files).

cleave inlines the Axe viewer, so it needs the Axe assets at run time. See
axe_root() for where it looks for them.
"""
import argparse
import os
import sys
from pathlib import Path

PACKAGED_ROOT = Path("/usr/share/cleave")

# Every Axe file cleave reads, relative to the Axe root. This is the list the
# Debian packaging installs into /usr/share/cleave — packaging/build-deb.sh
# reads it from here rather than keeping its own copy, so a newly inlined asset
# cannot ship in the tool and go missing from the package. Teach cleave to
# inline something new, and add it here in the same edit.
ASSETS = (
    "view/index.html",
    "axe.css",
    "default.css",
    "calendar.css",
    "calendar.js",
    "theme.js",
    "dependencies/marked.min.js",
    "dependencies/purify.min.js",
)


def axe_root():
    """Locate the Axe assets cleave inlines.

    Three candidates, each proved by the same probe rather than assumed, so a
    candidate that exists but is not an Axe tree falls through instead of
    half-working:

      1. $AXE_ROOT, when set. An explicit override always wins.
      2. cleave's own grandparent -- cli/ -> repo root. This is a checkout,
         and it is checked BEFORE the packaged copy on purpose: running
         cleave from a working tree should bake that tree's viewer, not
         whatever version happens to be installed system-wide.
      3. /usr/share/cleave, the assets the Debian package ships as its own
         private data. Reached when cleave is /usr/bin/cleave, whose
         grandparent is /usr and holds no viewer.
    """
    env = os.environ.get("AXE_ROOT")
    if env:
        return Path(env).expanduser()
    for candidate in (Path(__file__).resolve().parent.parent, PACKAGED_ROOT):
        if (candidate / "view" / "index.html").is_file():
            return candidate
    return PACKAGED_ROOT   # nothing found; the template check below reports it


AXE_ROOT = axe_root()
TEMPLATE = AXE_ROOT / "view" / "index.html"

# Exact asset references in the template, with their 4-space indentation.
I = "    "
LINK_DEFAULT = I + '<link rel="stylesheet" href="../default.css">'
LINK_BRAND = I + '<link rel="stylesheet" href="../../brand.css"><!-- site brand (sibling of axe/); overrides default, 404s harmlessly when absent -->'
LINK_AXE = I + '<link rel="stylesheet" href="../axe.css">'
LINK_CALCSS = I + '<link rel="stylesheet" href="../calendar.css">'
SRC_MARKED = I + '<script src="../dependencies/marked.min.js"></script>'
SRC_PURIFY = I + '<script src="../dependencies/purify.min.js"></script>'
SRC_CALJS = I + '<script src="../calendar.js"></script>'
SRC_THEME = I + '<script src="../theme.js"></script>'

# Which assets each format actually uses (mirrors the viewer's renderers).
NEEDS = {
    "csv":      {"marked": False, "purify": False, "calendar": False},
    "tsv":      {"marked": False, "purify": False, "calendar": False},
    "md":       {"marked": True,  "purify": True,  "calendar": False},
    "markdown": {"marked": True,  "purify": True,  "calendar": False},
    "ics":      {"marked": False, "purify": False, "calendar": True},
    "ical":     {"marked": False, "purify": False, "calendar": True},
}


def read(path):
    return path.read_text(encoding="utf-8")


def style_block(css):
    return I + "<style>\n" + css + "\n" + I + "</style>"


def script_block(js, label):
    if "</script" in js.lower():
        sys.exit(f"Error: {label} contains a literal </script and can't be inlined safely.")
    return I + "<script>\n" + js + "\n" + I + "</script>"


def rcdata_escape(text):
    # Inside a <textarea> (RCDATA) only & and < are significant.
    return text.replace("&", "&amp;").replace("<", "&lt;")


def attr_escape(text):
    return (text.replace("&", "&amp;").replace('"', "&quot;")
                .replace("<", "&lt;").replace(">", "&gt;"))


def main():
    ap = argparse.ArgumentParser(prog="cleave",
                                 description="Bake an Axe document into a self-contained HTML file.")
    ap.add_argument("input", help="input .csv/.tsv/.md/.markdown/.ics/.ical")
    ap.add_argument("output", nargs="?", help="output .html (default: input name with .html)")
    ap.add_argument("--view", choices=["auto", "doc", "slides"], default="auto",
                    help="Markdown render mode (default: auto -- frontmatter/default decides)")
    ap.add_argument("--slides", action="store_true", help="shorthand for --view slides")
    ap.add_argument("--brand", help="a brand.css to inline (overrides the default palette)")
    ap.add_argument("--name", help="filename label shown in the viewer (default: input basename)")
    args = ap.parse_args()

    src = Path(args.input)
    if not src.is_file():
        sys.exit(f"Error: file not found: {src}")
    ext = src.suffix.lstrip(".").lower()
    if ext not in NEEDS:
        sys.exit(f"Error: unsupported type '.{ext}'. Use csv, tsv, md, markdown, ics, or ical.")
    if not TEMPLATE.is_file():
        sys.exit(f"Error: viewer template not found at {TEMPLATE}\n"
                 f"cleave needs the Axe assets to inline. Install the cleave "
                 f"package, run it from an Axe checkout, or set AXE_ROOT to one.")

    view = "slides" if args.slides else args.view
    if view != "auto" and ext not in ("md", "markdown"):
        print(f"Note: --view/--slides only applies to Markdown; ignoring for .{ext}.", file=sys.stderr)
        view = "auto"

    needs = NEEDS[ext]
    html = read(TEMPLATE)

    # 1. Inject the document right after <body>, before any script runs, on the
    #    pristine template (so we never match inlined library code by accident).
    name = args.name or src.name
    view_attr = f' data-view="{view}"' if view in ("doc", "slides") else ""
    embed = (f'<textarea id="axe-embed" hidden data-ext="{ext}" '
             f'data-name="{attr_escape(name)}"{view_attr}>\n'
             f'{rcdata_escape(read(src))}</textarea>')
    if "<body>\n" not in html:
        sys.exit("Error: couldn't find <body> in the template (template drift).")
    html = html.replace("<body>\n", "<body>\n" + embed + "\n", 1)

    # 2. Inline the assets this format uses; drop the rest (including the
    #    harmless brand.css 404 link when no --brand is given).
    repl = {
        LINK_DEFAULT: style_block(read(AXE_ROOT / "default.css")),
        LINK_AXE:     style_block(read(AXE_ROOT / "axe.css")),
        LINK_BRAND:   style_block(read(Path(args.brand))) if args.brand else "",
        LINK_CALCSS:  style_block(read(AXE_ROOT / "calendar.css")) if needs["calendar"] else "",
        SRC_MARKED:   script_block(read(AXE_ROOT / "dependencies" / "marked.min.js"), "marked.min.js") if needs["marked"] else "",
        SRC_PURIFY:   script_block(read(AXE_ROOT / "dependencies" / "purify.min.js"), "purify.min.js") if needs["purify"] else "",
        SRC_CALJS:    script_block(read(AXE_ROOT / "calendar.js"), "calendar.js") if needs["calendar"] else "",
        SRC_THEME:    script_block(read(AXE_ROOT / "theme.js"), "theme.js"),
    }
    for tag, replacement in repl.items():
        if tag not in html:
            sys.exit(f"Error: template drift -- expected to find:\n  {tag}")
        target = tag + "\n"
        html = html.replace(target, (replacement + "\n") if replacement else "", 1)

    out = Path(args.output) if args.output else src.with_suffix(".html")
    out.write_text(html, encoding="utf-8")
    kb = len(html.encode("utf-8")) / 1024
    print(f"Wrote: {out}  ({kb:.0f} KB, self-contained)")


if __name__ == "__main__":
    main()
