#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const Database = require('better-sqlite3');

const GUIDE_CATALOG_METADATA_KEY = 'game_guide_catalog';
const databasePath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'database', 'database.db'));
const catalogPath = path.join(__dirname, '..', 'src', 'data', 'gameGuides.json');

if (!fs.existsSync(databasePath)) throw new Error(`Database does not exist: ${databasePath}`);
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const serializedCatalog = JSON.stringify(catalog);
if (Buffer.byteLength(serializedCatalog, 'utf8') > 4096) {
    throw new Error('Guide catalog exceeds the database metadata limit');
}

const database = new Database(databasePath);
try {
    database.prepare(`
        INSERT INTO metadata (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(GUIDE_CATALOG_METADATA_KEY, serializedCatalog);
} finally {
    database.close();
}

process.stdout.write(`Synchronized guide catalog into ${databasePath}\n`);
