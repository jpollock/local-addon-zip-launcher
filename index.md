---
layout: default
title: Home
---

# Zip Launcher for Local

![Status](https://img.shields.io/badge/status-beta-orange) ![License](https://img.shields.io/badge/license-MIT-blue) ![Local](https://img.shields.io/badge/Local-v6.0%2B-green)

Drop any WordPress theme or plugin `.zip` anywhere in Local — a site appears with it installed and activated. No wizard. No clicks.

## What it does

- **Detects automatically** — reads `Theme Name:` and `Plugin Name:` headers from zip contents (including WordPress.org PHPDoc format)
- **Creates sites instantly** — site name derived from the detected theme/plugin name
- **Handles collisions** — if the theme/plugin already exists on a site, asks to update or create new
- **Imports demo content** — bundled WXR files are automatically imported after activation

## Quick Install

1. Download `local-addon-zip-launcher-0.3.0.tgz` from the [Releases page](https://github.com/jpollock/local-addon-zip-launcher/releases)
2. Open **Local** → **Add-ons** → **Install from disk** → select the `.tgz`
3. Toggle **ON** → **Relaunch**

Full installation instructions → [User Guide](docs/USER_GUIDE/)

## Documentation

| | |
|---|---|
| [User Guide](docs/USER_GUIDE/) | How it works, supported zip formats, known limitations |
| [Developer Guide](docs/DEVELOPER_GUIDE/) | Setup, architecture, contributing |
| [Troubleshooting](docs/TROUBLESHOOTING/) | Common issues and fixes |

## Source

[github.com/jpollock/local-addon-zip-launcher](https://github.com/jpollock/local-addon-zip-launcher)
