---
layout: default
title: Troubleshooting
---

# Troubleshooting

## "Not a theme or plugin zip"

**Symptom:** The zip passes through to Local's import flow and shows an error.

**Cause:** Zip Launcher couldn't find a `Theme Name:` or `Plugin Name:` header.

**What to check:**
- Unzip the file and look for `style.css` (themes) or a main `.php` file (plugins)
- The header must be within two directory levels of the zip root — `my-theme/style.css` ✓ but `my-theme/sub/style.css` ✗
- The file must contain a line matching `Theme Name: Something` or `Plugin Name: Something`
- WordPress.org PHPDoc format is supported: ` * Plugin Name: Something`

**Quick test:** Run `unzip -p your-file.zip "theme-folder/style.css" | grep "Theme Name"`. If nothing appears, the header is missing or the file is at the wrong depth.

---

## Collision dialog appeared but nothing happens after clicking "Update existing"

**Symptom:** Dialog closes, progress bar briefly appears, then nothing.

**Cause:** WP-CLI couldn't run on the site.

**Try:**
1. Check Local's system log (`Help → System Log`) for `[zip-launcher]` error lines
2. Make sure the site can start — even though Zip Launcher tries to start stopped sites automatically, start failures are shown as a toast
3. Try starting the site manually in Local, then drop the zip again

---

## Demo content didn't import

**Symptom:** New site created, theme/plugin activated, but no demo posts/pages.

**Cause:** `wordpress-importer` failed to install (network issue) or `wp import` failed.

**What happens on failure:** The XML file is saved to your system's temp directory and a toast shows its path. You can import manually:
1. In WordPress admin, go to **Tools → Import → WordPress**
2. If "WordPress" isn't listed, install the WordPress Importer plugin first
3. Upload the `.xml` file from the path shown in the toast

---

## Drop overlay stuck on "Drop to import site!"

**Symptom:** After dropping a zip, the gray overlay stays visible.

**Fix:** Restart Local.

---

## The addon doesn't appear in Local

**Check:**
1. The folder is named exactly `local-addon-zip-launcher` (not `package` or with a version suffix)
2. The folder contains `package.json` with `"productName": "Zip Launcher"`
3. Check Local's system log for addon loading errors
4. Restart Local after moving the folder

---

## Filing a Bug Report

Please [open an issue](https://github.com/jpollock/local-addon-zip-launcher/issues) with:
- Your Local version (`Help → About Local`)
- macOS / Windows / Linux
- Description of the zip (or its `unzip -l` output)
- Relevant lines from `Help → System Log`
