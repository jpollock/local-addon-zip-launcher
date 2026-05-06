---
layout: default
title: User Guide
---

# User Guide

## How It Works

When you drop a `.zip` file anywhere on the Local window:

1. **Detection** — Zip Launcher inspects the zip contents for a `style.css` with a `Theme Name:` header (theme) or a `.php` file with a `Plugin Name:` header (plugin). Both simple and WordPress.org PHPDoc header formats are supported.

2. **Collision check** — If the detected theme or plugin is already installed on an existing Local site, a dialog appears asking whether to update that site or create a new one.

3. **Site creation** — A new WordPress site is created, named after the detected theme or plugin (e.g. `pm-bulletin.local`). Local's normal site creation flow runs — you'll see the progress bar.

4. **Installation** — After WordPress is set up, the theme or plugin is installed and activated via WP-CLI.

5. **Demo content** — If the zip contains a WXR (WordPress eXporter XML) file, `wordpress-importer` is installed and the content is imported automatically.

6. **Navigation** — Local opens the site info panel when everything is done.

Non-theme/plugin zips (site backups, etc.) are passed through to Local's existing import flow unchanged.

---

## Supported Zip Structures

Zip Launcher handles three zip shapes automatically.

### Single theme or plugin

The most common format. A single folder at the root of the zip:

```
my-theme.zip
└── my-theme/
    ├── style.css        ← must contain "Theme Name: My Theme"
    └── ...

my-plugin.zip
└── my-plugin/
    ├── my-plugin.php   ← must contain "Plugin Name: My Plugin"
    └── ...
```

Files at the root with no folder also work:
```
my-theme.zip
├── style.css            ← "Theme Name: My Theme"
└── ...
```

### Bundle (theme + plugin together)

A zip that contains both a plugin and a companion theme. They can live directly at the root or inside a common wrapper directory — the addon strips any shared prefix automatically:

```
my-product.zip
├── my-plugin/
│   └── my-plugin.php   ← "Plugin Name: My Plugin"
└── my-theme/
    └── style.css       ← "Theme Name: My Theme"

my-product.zip           ← wrapper directory is stripped automatically
└── wp/
    ├── my-plugin/
    │   └── my-plugin.php
    └── my-theme/
        └── style.css
```

Both components are installed on a single new site. Plugins are always activated before themes.

### Demo content

A WXR export file (WordPress eXporter XML) anywhere in the zip at up to three directory levels deep:

```
my-theme.zip
└── my-theme/
    ├── style.css
    └── demo/
        └── demo-content.xml   ← imported automatically after activation
```

### Header formats

Both simple and PHPDoc formats are detected:

```css
/* Simple */
Theme Name: My Theme

/* PHPDoc (WordPress.org style) */
 * Theme Name: My Theme
```

---

## Collision Dialog

If you drop a zip whose theme/plugin folder already exists on a Local site, you'll see:

> **"PM Bulletin" is already installed on pm-bulletin.**
> Update it there, or create a new site?

- **Update existing** — If the site is stopped, it starts automatically. The theme or plugin files are updated in place and re-activated. For bundles, all components are updated. Demo content is imported if found.
- **Create new site** — Proceeds as normal, creating `pm-bulletin-2` (or the next available suffix).
- **Cancel** — Nothing happens.

---

## Known Limitations

- **`.zip` only** — `.tar.gz` archives are not supported
- **One zip at a time** — if you drop multiple zips simultaneously, only the first is processed
- **Manual install** — not yet available on the Local addon marketplace; install from GitHub Releases
- **Admin password** — a random password is generated for each new site; you never need to type it because Local auto-logs you into WordPress admin
- **Demo content requires internet** — `wordpress-importer` is downloaded from WordPress.org on first use
- **Headers must be present** — the zip must contain a `style.css` with `Theme Name:` or a `.php` file with `Plugin Name:`; zips without these headers pass through to Local's existing import flow

---

## Installing the Addon

### Method 1: Pre-built Release (Recommended)

The easiest way — no terminal required.

1. Go to the [Releases page](https://github.com/jpollock/local-addon-zip-launcher/releases)
2. Download `local-addon-zip-launcher-X.Y.Z.tgz` from the latest release
3. Open **Local**
4. Click **Add-ons** in the sidebar
5. Click **Install from disk**
6. Select the downloaded `.tgz` file
7. Toggle the addon **ON**
8. Click **Relaunch** when prompted

### Method 2: Build from Source

For developers and contributors.

```bash
git clone https://github.com/jpollock/local-addon-zip-launcher.git
cd local-addon-zip-launcher
npm install
npm run build
npm run install-addon
```

Then restart Local. The addon loads automatically — no enable toggle required.
