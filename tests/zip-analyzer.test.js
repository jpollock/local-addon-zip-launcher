'use strict';

const path = require('path');
const os = require('os');
const { validateFilePath, parseHeader, slugify, getUniqueSlug } = require('../lib/zip-analyzer');

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
