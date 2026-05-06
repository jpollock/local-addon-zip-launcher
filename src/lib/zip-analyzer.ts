'use strict';

import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const StreamZip = require('node-stream-zip');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ZipComponent {
  type: 'theme' | 'plugin';
  name: string;
  folder: string; // WordPress folder name (post-strip), used as WP-CLI slug
}

export interface ZipBundle {
  components: ZipComponent[]; // plugins first, then themes
  demoContentEntries: string[]; // raw (pre-strip) zip entry names
  prefix: string;              // common wrapper stripped during detection (e.g. 'wp/')
}

// node-stream-zip v1.x doesn't ship complete TypeScript types; use any for instances.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StreamZipInstance = any;

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

export function validateFilePath(filePath: unknown): filePath is string {
  if (typeof filePath !== 'string') return false;
  if (!path.isAbsolute(filePath)) return false;
  if (!filePath.toLowerCase().endsWith('.zip')) return false;
  if (filePath.split(path.sep).includes('..')) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Zip reading
// ---------------------------------------------------------------------------

export function openZip(filePath: string): Promise<StreamZipInstance> {
  return new Promise((resolve, reject) => {
    const zip = new StreamZip({ file: filePath, storeEntries: true });
    zip.on('ready', () => resolve(zip));
    zip.on('error', reject);
  });
}

export function readEntryText(zip: StreamZipInstance, entryName: string, maxBytes = 8192): Promise<string> {
  return new Promise((resolve, reject) => {
    zip.stream(entryName, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;

      const done = () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks).toString('utf8', 0, maxBytes));
      };

      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        total += chunk.length;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (total >= maxBytes) { done(); (stream as any).destroy(); }
      });
      stream.on('end', done);
      stream.on('close', done);
      stream.on('error', (e: Error) => { if (!settled) { settled = true; reject(e); } });
    });
  });
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

export function parseHeader(text: string, key: string): string | null {
  // key is always a hardcoded string — no regex injection risk.
  // (?:\*[ \t]*)? handles PHPDoc-style " * Plugin Name:" used by WordPress.org plugins.
  const match = text.match(new RegExp(`^[ \\t]*(?:\\*[ \\t]*)?${key}[ \\t]*:[ \\t]*(.+)$`, 'm'));
  return match ? match[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Folder and content detection helpers
// ---------------------------------------------------------------------------

export function extractFolder(names: string[]): string {
  for (const n of names) {
    const parts = n.split('/').filter(Boolean);
    if (parts.length >= 1) return parts[0];
  }
  return '';
}

export function isWxr(text: string): boolean {
  return text.includes('<rss') && text.includes('xmlns:excerpt');
}

export function findWxrCandidates(names: string[]): string[] {
  return names.filter((n) =>
    !n.includes('..') &&
    !path.isAbsolute(n) &&
    n.toLowerCase().endsWith('.xml') &&
    n.split('/').filter(Boolean).length <= 3,
  );
}

/**
 * Finds the longest common directory prefix across all zip entry names and returns
 * both the stripped names and the prefix. Normalizes wrapper directories like `wp/`
 * before theme/plugin detection.
 */
export function stripCommonPrefix(names: string[]): { stripped: string[]; prefix: string } {
  if (names.length === 0) return { stripped: [], prefix: '' };

  const segments = names.map((n) => n.split('/').filter(Boolean));

  let prefixDepth = 0;
  while (true) {
    const firstSeg = segments[0]?.[prefixDepth];
    if (!firstSeg) break;
    if (!segments.every((segs) => segs[prefixDepth] === firstSeg)) break;
    // Only treat this segment as a directory prefix if at least one entry has
    // content beyond it (i.e. it's actually a wrapper directory, not a bare file).
    if (!segments.some((segs) => segs.length > prefixDepth + 1)) break;
    prefixDepth++;
  }

  if (prefixDepth === 0) return { stripped: names, prefix: '' };

  const prefix = segments[0].slice(0, prefixDepth).join('/') + '/';
  const stripped = names.map((n) => (n.startsWith(prefix) ? n.slice(prefix.length) : n));
  return { stripped, prefix };
}

// ---------------------------------------------------------------------------
// Demo content detection
// ---------------------------------------------------------------------------

async function detectDemoContent(zip: StreamZipInstance, names: string[]): Promise<string[]> {
  const candidates = findWxrCandidates(names);
  const wxrEntries: string[] = [];
  for (const candidate of candidates) {
    try {
      const text = await readEntryText(zip, candidate, 2048);
      if (isWxr(text)) wxrEntries.push(candidate);
    } catch (_) {
      // Unreadable entry — skip silently
    }
  }
  return wxrEntries;
}

// ---------------------------------------------------------------------------
// Zip detection
// ---------------------------------------------------------------------------

export async function analyzeZip(filePath: string): Promise<ZipBundle | null> {
  const zip = await openZip(filePath);
  try {
    const rawNames = Object.keys(zip.entries());

    // Strip common wrapper prefix (e.g. 'wp/') before detection.
    const { stripped, prefix } = stripCommonPrefix(rawNames);

    // Post-strip: reject traversal and limit detection to depth ≤ 2.
    const shallow = stripped.filter((n) =>
      n.length > 0 &&
      !n.includes('..') &&
      !path.isAbsolute(n) &&
      n.split('/').filter(Boolean).length <= 2,
    );

    const components: ZipComponent[] = [];
    const detectedFolders = new Set<string>();

    // --- Plugin detection (plugins first per install order) ---
    const phpFiles = shallow.filter((n) => n.endsWith('.php'));
    for (const phpFile of phpFiles) {
      const rawEntry = prefix + phpFile;
      const text = await readEntryText(zip, rawEntry);
      const name = parseHeader(text, 'Plugin Name');
      if (name) {
        const folder = phpFile.split('/')[0];
        if (!detectedFolders.has(folder)) {
          detectedFolders.add(folder);
          components.push({ type: 'plugin', name, folder });
        }
      }
    }

    // --- Theme detection ---
    const styleCssFiles = shallow.filter((n) => {
      const parts = n.split('/').filter(Boolean);
      return parts[parts.length - 1] === 'style.css';
    });
    for (const styleCss of styleCssFiles) {
      const rawEntry = prefix + styleCss;
      const text = await readEntryText(zip, rawEntry);
      const name = parseHeader(text, 'Theme Name');
      if (name) {
        const folder = styleCss.split('/')[0];
        if (!detectedFolders.has(folder)) {
          detectedFolders.add(folder);
          components.push({ type: 'theme', name, folder });
        }
      }
    }

    if (components.length === 0) return null;

    // Demo content: scan raw (pre-strip) names — depth ≤ 3 reaches into wrappers.
    const demoContentEntries = await detectDemoContent(zip, rawNames);

    return { components, demoContentEntries, prefix };
  } finally {
    zip.close();
  }
}

// ---------------------------------------------------------------------------
// Slug helpers
// ---------------------------------------------------------------------------

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function getUniqueSlug(base: string, existingNames: Set<string>): string {
  if (!existingNames.has(base)) return base;
  for (let i = 2; i <= 99; i++) {
    const candidate = `${base}-${i}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  throw new Error(`Could not find a unique name for "${base}" after 99 attempts.`);
}

