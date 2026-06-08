const fs = require('fs');
const path = require('path');

const bindingRoot = path.resolve(__dirname, '..', 'node_modules', 'sqlite3', 'lib', 'binding');
const binaryName = 'node_sqlite3.node';

function walk(dir) {
    if (!fs.existsSync(dir)) return [];

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...walk(fullPath));
        } else {
            files.push(fullPath);
        }
    }

    return files;
}

const files = walk(bindingRoot);
const existingBinary = files.find((file) => path.basename(file) === binaryName);

if (existingBinary) {
    console.log(`sqlite3 native binary found: ${existingBinary}`);
    process.exit(0);
}

const deleteCandidates = files
    .filter((file) => path.basename(file).startsWith(`${binaryName}.DELETE`))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

if (deleteCandidates.length > 0) {
    const source = deleteCandidates[0];
    const target = path.join(path.dirname(source), binaryName);
    fs.copyFileSync(source, target);
    console.log(`Restored sqlite3 native binary from ${path.basename(source)} to ${target}`);
    process.exit(0);
}

console.error(`Missing sqlite3 native binary. Expected ${binaryName} under ${bindingRoot}`);
console.error('Run `npm install` or `npm rebuild sqlite3` with network access, then build again.');
process.exit(1);
