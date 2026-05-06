# Zip Launcher for Local

![Status](https://img.shields.io/badge/status-beta-orange)
![License](https://img.shields.io/badge/license-MIT-blue)
![Local](https://img.shields.io/badge/Local-v6.0%2B-green)
![Tests](https://github.com/jpollock/local-addon-zip-launcher/actions/workflows/ci.yml/badge.svg)

Drop any WordPress theme or plugin `.zip` anywhere in Local — a site appears with it installed and activated. No wizard. No clicks.

---

## Features

- **Drop anywhere** — works on any screen in Local, not just a dedicated import panel
- **Auto-detect** — identifies themes (`Theme Name:`) and plugins (`Plugin Name:`) from zip contents; supports both simple and PHPDoc header formats (WordPress.org style)
- **Collision detection** — if the theme/plugin is already on an existing site, offers to update it or create a new site
- **Demo content** — automatically imports bundled WXR files after activation
- **Progress bar** — uses Local's native progress indicator during long operations

---

## Installation

1. Go to the [Releases page](https://github.com/jpollock/local-addon-zip-launcher/releases)
2. Download `local-addon-zip-launcher-0.3.0.tgz` from the latest release
3. Extract it: `tar -xzf local-addon-zip-launcher-0.3.0.tgz`
4. Move the extracted folder to your Local addons directory:
   - **macOS:** `~/Library/Application Support/Local/addons/`
   - **Windows:** `%APPDATA%\Local\addons\`
   - **Linux:** `~/.config/Local/addons/`
5. Restart Local

---

## Quick Start

**Drop a theme zip** → Local creates a new site with the theme installed and activated

**Drop a plugin zip** → Local creates a new site with the plugin installed and activated

**Drop a zip with demo content** → Same as above, plus the bundled WXR file is imported automatically

**Drop a zip you've used before** → A dialog asks if you want to update the existing site or create a new one

---

## Requirements

- Local v6.0.0 or higher
- macOS, Windows, or Linux

---

## Documentation

- [User Guide](docs/USER_GUIDE.md) — How it works, supported formats, known limitations
- [Developer Guide](docs/DEVELOPER_GUIDE.md) — Setup, architecture, how to contribute
- [Troubleshooting](docs/TROUBLESHOOTING.md) — Common issues and fixes
- [Changelog](CHANGELOG.md) — Version history

---

## Known Limitations

- `.zip` files only — `.tar.gz` not supported
- One zip at a time — if you drop multiple zips, the first one wins
- Manual install — not yet on the Local addon marketplace
- Demo content import requires internet access (installs `wordpress-importer` from WordPress.org)

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, code style, and how to add new detection types.

## License

MIT — see [LICENSE](LICENSE) for details.
