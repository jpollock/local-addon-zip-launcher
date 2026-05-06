'use strict';

import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const StreamZip = require('node-stream-zip');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ZipAnalysisResult {
  type: 'theme' | 'plugin';
  name: string;
  folder: string;
  demoContentEntries: string[];
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

export async function analyzeZip(filePath: string): Promise<ZipAnalysisResult | null> {
  const zip = await openZip(filePath);
  try {
    const names = Object.keys(zip.entries());
    const folder = extractFolder(names);

    // Reject traversal entries, limit theme/plugin detection to depth ≤ 2.
    const shallow = names.filter((n) =>
      !n.includes('..') &&
      !path.isAbsolute(n) &&
      n.split('/').filter(Boolean).length <= 2,
    );

    // Theme: style.css with "Theme Name:" header
    const styleCss = shallow.find((n) => {
      const parts = n.split('/').filter(Boolean);
      return parts[parts.length - 1] === 'style.css';
    });
    if (styleCss) {
      const text = await readEntryText(zip, styleCss);
      const name = parseHeader(text, 'Theme Name');
      if (name) {
        const demoContentEntries = await detectDemoContent(zip, names);
        return { type: 'theme', name, folder, demoContentEntries };
      }
    }

    // Plugin: PHP file with "Plugin Name:" header
    const phpFiles = shallow.filter((n) => n.endsWith('.php'));
    for (const phpFile of phpFiles) {
      const text = await readEntryText(zip, phpFile);
      const name = parseHeader(text, 'Plugin Name');
      if (name) {
        const demoContentEntries = await detectDemoContent(zip, names);
        return { type: 'plugin', name, folder, demoContentEntries };
      }
    }

    return null;
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
