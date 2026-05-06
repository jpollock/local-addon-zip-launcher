'use strict';

const path = require('path');
const os = require('os');
const StreamZip = require('node-stream-zip');

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

function validateFilePath(filePath) {
	if (typeof filePath !== 'string') return false;
	if (!path.isAbsolute(filePath)) return false;
	if (!filePath.toLowerCase().endsWith('.zip')) return false;
	if (filePath.includes('..')) return false;
	return true;
}

// ---------------------------------------------------------------------------
// Zip reading
// ---------------------------------------------------------------------------

function openZip(filePath) {
	return new Promise((resolve, reject) => {
		const zip = new StreamZip({ file: filePath, storeEntries: true });
		zip.on('ready', () => resolve(zip));
		zip.on('error', reject);
	});
}

function readEntryText(zip, entryName, maxBytes = 8192) {
	return new Promise((resolve, reject) => {
		zip.stream(entryName, (err, stream) => {
			if (err) return reject(err);
			const chunks = [];
			let total = 0;
			let settled = false;

			const done = () => {
				if (settled) return;
				settled = true;
				resolve(Buffer.concat(chunks).toString('utf8', 0, maxBytes));
			};

			stream.on('data', (chunk) => {
				chunks.push(chunk);
				total += chunk.length;
				if (total >= maxBytes) { done(); stream.destroy(); }
			});
			stream.on('end', done);
			stream.on('close', done);
			stream.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
		});
	});
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

function parseHeader(text, key) {
	// key is always a hardcoded string — no regex injection risk
	const match = text.match(new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*(.+)$`, 'm'));
	return match ? match[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Zip detection
// ---------------------------------------------------------------------------

async function analyzeZip(filePath) {
	const zip = await openZip(filePath);
	try {
		const names = Object.keys(zip.entries());

		// Reject traversal entries, limit to one folder deep.
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
			if (name) return { type: 'theme', name };
		}

		// Plugin: PHP file with "Plugin Name:" header
		const phpFiles = shallow.filter((n) => n.endsWith('.php'));
		for (const phpFile of phpFiles) {
			const text = await readEntryText(zip, phpFile);
			const name = parseHeader(text, 'Plugin Name');
			if (name) return { type: 'plugin', name };
		}

		return null;
	} finally {
		zip.close();
	}
}

// ---------------------------------------------------------------------------
// Slug helpers
// ---------------------------------------------------------------------------

function slugify(name) {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

function getUniqueSlug(base, existingNames) {
	if (!existingNames.has(base)) return base;
	for (let i = 2; i <= 99; i++) {
		const candidate = `${base}-${i}`;
		if (!existingNames.has(candidate)) return candidate;
	}
	throw new Error(`Could not find a unique name for "${base}" after 99 attempts.`);
}

module.exports = { validateFilePath, openZip, readEntryText, parseHeader, analyzeZip, slugify, getUniqueSlug };
