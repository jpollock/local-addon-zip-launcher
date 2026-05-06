#!/usr/bin/env node
'use strict';

/**
 * Release validation — checks everything is ready before cutting a release.
 * Run: npm run validate-release
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const errors = [];
const warnings = [];

function check(condition, message, isWarning = false) {
  if (!condition) {
    if (isWarning) warnings.push(message);
    else errors.push(message);
  }
}

function fileExists(filePath) {
  return fs.existsSync(path.join(ROOT, filePath));
}

function runCommand(cmd) {
  try {
    execSync(cmd, { cwd: ROOT, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

console.log('Zip Launcher — Release Validation');
console.log('==================================\n');

// package.json fields
console.log('Checking package.json...');
const pkg = require(path.join(ROOT, 'package.json'));
check(pkg.name, 'package.json: missing "name"');
check(pkg.version, 'package.json: missing "version"');
check(pkg.productName, 'package.json: missing "productName"');
check(pkg.license, 'package.json: missing "license"');
check(pkg.main, 'package.json: missing "main"');
check(pkg.renderer, 'package.json: missing "renderer"');
check(pkg.localAddon, 'package.json: missing "localAddon"');
check(pkg.localAddon?.minimumLocalVersion, 'package.json: missing "localAddon.minimumLocalVersion"');
check(pkg.repository, 'package.json: missing "repository"', true);
console.log(`  version: ${pkg.version}`);
console.log(`  productName: ${pkg.productName}`);

// Documentation
console.log('\nChecking documentation...');
['README.md', 'CHANGELOG.md', 'LICENSE', 'docs/USER_GUIDE.md', 'docs/DEVELOPER_GUIDE.md', 'docs/TROUBLESHOOTING.md'].forEach((f) => {
  check(fileExists(f), `Missing: ${f}`);
  console.log(`  ${f}: ${fileExists(f) ? 'OK' : 'MISSING'}`);
});
check(fileExists('CONTRIBUTING.md'), 'Missing: CONTRIBUTING.md', true);

// Build output
console.log('\nChecking build output...');
['lib/main.js', 'lib/renderer.js'].forEach((f) => {
  check(fileExists(f), `Build output missing: ${f}`);
  console.log(`  ${f}: ${fileExists(f) ? 'OK' : 'MISSING'}`);
});

// Config files
console.log('\nChecking config files...');
['.eslintrc.json', '.prettierrc', 'tsconfig.json', 'jest.config.js'].forEach((f) => {
  check(fileExists(f), `Config missing: ${f}`);
  console.log(`  ${f}: ${fileExists(f) ? 'OK' : 'MISSING'}`);
});

// CI/CD
console.log('\nChecking CI/CD...');
['.github/workflows/ci.yml', '.github/workflows/release.yml', '.github/workflows/docs.yml'].forEach((f) => {
  check(fileExists(f), `Workflow missing: ${f}`);
  console.log(`  ${f}: ${fileExists(f) ? 'OK' : 'MISSING'}`);
});

// Quality checks
console.log('\nRunning quality checks...');

process.stdout.write('  lint: ');
console.log(runCommand('npm run lint') ? 'PASSED' : (errors.push('Lint failed'), 'FAILED'));

process.stdout.write('  type-check: ');
console.log(runCommand('npm run type-check') ? 'PASSED' : (errors.push('Type check failed'), 'FAILED'));

process.stdout.write('  build: ');
console.log(runCommand('npm run build') ? 'PASSED' : (errors.push('Build failed'), 'FAILED'));

// Report
console.log('\n--- Result ---\n');

if (warnings.length) {
  console.log('Warnings:');
  warnings.forEach((w) => console.log(`  ⚠  ${w}`));
  console.log('');
}

if (errors.length) {
  console.log('Errors:');
  errors.forEach((e) => console.log(`  ✗  ${e}`));
  console.log('\n✗ Release validation FAILED');
  process.exit(1);
} else {
  console.log('✓ Release validation PASSED');
  process.exit(0);
}
