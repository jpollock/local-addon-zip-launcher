'use strict';

const path = require('path');
const os = require('os');
const { validateFilePath, parseHeader, extractFolder, isWxr, findWxrCandidates, slugify, getUniqueSlug } = require('../lib/zip-analyzer');

// ---------------------------------------------------------------------------
// validateFilePath
// ---------------------------------------------------------------------------

describe('validateFilePath', () => {
	test('accepts an absolute .zip path', () => {
		expect(validateFilePath(path.join(os.homedir(), 'Downloads', 'theme.zip'))).toBe(true);
	});

	test('rejects a relative path', () => {
		expect(validateFilePath('Downloads/theme.zip')).toBe(false);
	});

	test('rejects a non-.zip extension', () => {
		expect(validateFilePath('/Users/test/theme.tar.gz')).toBe(false);
	});

	test('rejects a path containing ..', () => {
		expect(validateFilePath('/Users/test/../../etc/passwd.zip')).toBe(false);
	});

	test('rejects non-string values', () => {
		expect(validateFilePath(null)).toBe(false);
		expect(validateFilePath(42)).toBe(false);
		expect(validateFilePath(undefined)).toBe(false);
	});

	test('is case-insensitive for the .zip extension', () => {
		expect(validateFilePath('/Users/test/THEME.ZIP')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// parseHeader
// ---------------------------------------------------------------------------

describe('parseHeader', () => {
	test('parses a standard WordPress theme header', () => {
		const css = `/*\nTheme Name: Astra\nAuthor: Brainstorm Force\n*/`;
		expect(parseHeader(css, 'Theme Name')).toBe('Astra');
	});

	test('parses a plugin header', () => {
		const php = `<?php\n/*\nPlugin Name: Yoast SEO\nVersion: 20.0\n*/`;
		expect(parseHeader(php, 'Plugin Name')).toBe('Yoast SEO');
	});

	test('handles leading whitespace before the key', () => {
		const css = ` \tTheme Name: My Theme`;
		expect(parseHeader(css, 'Theme Name')).toBe('My Theme');
	});

	test('handles extra spaces around the colon', () => {
		const css = `Theme Name : Spacey Theme`;
		expect(parseHeader(css, 'Theme Name')).toBe('Spacey Theme');
	});

	test('returns null when the key is absent', () => {
		const css = `/* nothing useful here */`;
		expect(parseHeader(css, 'Theme Name')).toBeNull();
	});

	test('trims trailing whitespace from the value', () => {
		const css = `Theme Name: Clean   `;
		expect(parseHeader(css, 'Theme Name')).toBe('Clean');
	});
});

// ---------------------------------------------------------------------------
// extractFolder
// ---------------------------------------------------------------------------

describe('extractFolder', () => {
	test('returns the root folder from a single-root zip', () => {
		expect(extractFolder(['pm-bulletin/style.css', 'pm-bulletin/functions.php'])).toBe('pm-bulletin');
	});

	test('works for depth-1 root files (flat zip)', () => {
		expect(extractFolder(['style.css', 'functions.php'])).toBe('style.css');
	});

	test('returns first component of a deeply nested entry', () => {
		expect(extractFolder(['my-theme/demo/content.xml'])).toBe('my-theme');
	});

	test('returns empty string for an empty names array', () => {
		expect(extractFolder([])).toBe('');
	});
});

// ---------------------------------------------------------------------------
// isWxr
// ---------------------------------------------------------------------------

describe('isWxr', () => {
	test('returns true for text containing both WXR markers', () => {
		const wxr = '<?xml version="1.0"?>\n<rss version="2.0" xmlns:excerpt="http://wordpress.org/export/">';
		expect(isWxr(wxr)).toBe(true);
	});

	test('returns false when rss marker is absent', () => {
		const notWxr = '<?xml version="1.0"?>\n<feed xmlns:excerpt="http://wordpress.org/export/">';
		expect(isWxr(notWxr)).toBe(false);
	});

	test('returns false when xmlns:excerpt marker is absent', () => {
		const notWxr = '<?xml version="1.0"?>\n<rss version="2.0">';
		expect(isWxr(notWxr)).toBe(false);
	});

	test('returns false for empty string', () => {
		expect(isWxr('')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// findWxrCandidates
// ---------------------------------------------------------------------------

describe('findWxrCandidates', () => {
	test('includes xml files at depth 1', () => {
		expect(findWxrCandidates(['demo.xml'])).toEqual(['demo.xml']);
	});

	test('includes xml files at depth 3', () => {
		expect(findWxrCandidates(['theme/demo/content.xml'])).toEqual(['theme/demo/content.xml']);
	});

	test('excludes xml files deeper than depth 3', () => {
		expect(findWxrCandidates(['a/b/c/d.xml'])).toEqual([]);
	});

	test('excludes non-xml files', () => {
		expect(findWxrCandidates(['theme/demo/content.json'])).toEqual([]);
	});

	test('excludes entries with path traversal', () => {
		expect(findWxrCandidates(['../evil.xml'])).toEqual([]);
	});

	test('excludes absolute paths', () => {
		expect(findWxrCandidates(['/etc/passwd.xml'])).toEqual([]);
	});

	test('is case-insensitive for the .xml extension', () => {
		expect(findWxrCandidates(['theme/demo/CONTENT.XML'])).toEqual(['theme/demo/CONTENT.XML']);
	});
});

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe('slugify', () => {
	test('lowercases the input', () => {
		expect(slugify('Astra')).toBe('astra');
	});

	test('replaces spaces with hyphens', () => {
		expect(slugify('My Theme')).toBe('my-theme');
	});

	test('collapses multiple separators', () => {
		expect(slugify('hello   world')).toBe('hello-world');
	});

	test('removes leading and trailing hyphens', () => {
		expect(slugify('  Astra  ')).toBe('astra');
	});

	test('strips non-alphanumeric characters', () => {
		expect(slugify('Plugin: v2.0!')).toBe('plugin-v2-0');
	});

	test('handles an already-slugified string', () => {
		expect(slugify('my-plugin')).toBe('my-plugin');
	});
});

// ---------------------------------------------------------------------------
// getUniqueSlug
// ---------------------------------------------------------------------------

describe('getUniqueSlug', () => {
	test('returns the base slug when it is not taken', () => {
		expect(getUniqueSlug('astra', new Set())).toBe('astra');
	});

	test('appends -2 when the base is taken', () => {
		expect(getUniqueSlug('astra', new Set(['astra']))).toBe('astra-2');
	});

	test('increments the suffix until a free slot is found', () => {
		expect(getUniqueSlug('astra', new Set(['astra', 'astra-2', 'astra-3']))).toBe('astra-4');
	});

	test('throws after 99 attempts', () => {
		const taken = new Set(['astra']);
		for (let i = 2; i <= 99; i++) taken.add(`astra-${i}`);
		expect(() => getUniqueSlug('astra', taken)).toThrow('99 attempts');
	});
});
