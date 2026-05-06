#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const lib = path.join(__dirname, '..', 'lib');
fs.mkdirSync(lib, { recursive: true });

fs.writeFileSync(
  path.join(lib, 'main.js'),
  "module.exports = require('./main/index').default || require('./main/index');\n"
);

fs.writeFileSync(
  path.join(lib, 'renderer.js'),
  "module.exports = require('./renderer/index').default || require('./renderer/index');\n"
);

console.log('Entry points created: lib/main.js, lib/renderer.js');
