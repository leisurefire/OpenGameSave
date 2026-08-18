#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const yaml = require('js-yaml');

const { getExpectedAppAssetNames, normalizeAppVersion } = require('../src/main/appUpdatePolicy');

function parseArguments(argv) {
    const argumentsMap = {};
    for (let index = 0; index < argv.length; index += 2) {
        const name = argv[index];
        const value = argv[index + 1];
        if (!name?.startsWith('--') || value === undefined) throw new Error(`Invalid argument: ${name || ''}`);
        argumentsMap[name.slice(2)] = value;
    }
    return argumentsMap;
}

function hashFile(filePath, algorithm, encoding) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash(algorithm);
        const input = fs.createReadStream(filePath);
        input.on('error', reject);
        input.on('data', chunk => hash.update(chunk));
        input.on('end', () => resolve(hash.digest(encoding)));
    });
}

function readYaml(filePath) {
    const parsed = yaml.load(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${filePath} must contain a YAML object`);
    }
    return parsed;
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) throw new Error(`${message}: expected ${expected}, received ${actual}`);
}

function validatePackagedUpdateConfig(distPath, expectedPublisherName) {
    const configPath = path.join(distPath, 'win-unpacked', 'resources', 'app-update.yml');
    if (!fs.existsSync(configPath)) throw new Error(`Missing packaged updater configuration: ${configPath}`);
    const config = readYaml(configPath);
    const publisherNames = Array.isArray(config.publisherName) ? config.publisherName : [config.publisherName];
    if (!publisherNames.includes(expectedPublisherName)) {
        throw new Error(`app-update.yml does not require publisher ${expectedPublisherName}`);
    }
}

async function validateLocalArtifacts({ distPath, version, publisherName }) {
    if (!publisherName) throw new Error('Expected publisher name is required');
    const normalizedVersion = normalizeAppVersion(version);
    if (!normalizedVersion || normalizedVersion !== version) throw new Error(`Invalid canonical release version: ${version}`);
    const expected = getExpectedAppAssetNames(version);
    const packageVersion = require(path.join(process.cwd(), 'package.json')).version;
    assertEqual(packageVersion, version, 'package.json version mismatch');

    const metadataPath = path.join(distPath, expected.metadata);
    const installerPath = path.join(distPath, expected.installer);
    const blockmapPath = path.join(distPath, expected.blockmap);
    for (const requiredPath of [metadataPath, installerPath, blockmapPath]) {
        if (!fs.existsSync(requiredPath)) throw new Error(`Missing release artifact: ${requiredPath}`);
    }

    const installers = fs.readdirSync(distPath).filter(name => /^OpenGameSave-Setup-.*\.exe$/i.test(name));
    if (installers.length !== 1 || installers[0] !== expected.installer) {
        throw new Error(`Expected only ${expected.installer}, found: ${installers.join(', ') || '(none)'}`);
    }

    const metadata = readYaml(metadataPath);
    assertEqual(metadata.version, version, 'Update metadata version mismatch');
    assertEqual(metadata.path, expected.installer, 'Update metadata path mismatch');
    if (!Array.isArray(metadata.files) || metadata.files.length !== 1) {
        throw new Error('Update metadata must contain exactly one files[] entry');
    }
    assertEqual(metadata.files[0].url, expected.installer, 'Update metadata files[0].url mismatch');

    const installerStats = fs.statSync(installerPath);
    assertEqual(metadata.files[0].size, installerStats.size, 'Update metadata files[0].size mismatch');
    const sha512 = await hashFile(installerPath, 'sha512', 'base64');
    assertEqual(metadata.files[0].sha512, sha512, 'Update metadata files[0].sha512 mismatch');
    assertEqual(metadata.sha512, sha512, 'Update metadata top-level sha512 mismatch');
    validatePackagedUpdateConfig(distPath, publisherName);

    const artifacts = await Promise.all([expected.installer, expected.blockmap, expected.metadata].map(async name => {
        const filePath = path.join(distPath, name);
        return {
            name,
            path: filePath,
            size: fs.statSync(filePath).size,
            digest: `sha256:${await hashFile(filePath, 'sha256', 'hex')}`
        };
    }));
    return { version, channel: expected.channel, artifacts };
}

function validateRemoteAssets(localReport, remoteJsonPath) {
    const remoteRelease = JSON.parse(fs.readFileSync(remoteJsonPath, 'utf8'));
    const remoteAssets = Array.isArray(remoteRelease.assets) ? remoteRelease.assets : [];
    const expectedNames = localReport.artifacts.map(artifact => artifact.name).sort();
    const remoteNames = remoteAssets.map(asset => String(asset.name || '')).sort();
    assertEqual(JSON.stringify(remoteNames), JSON.stringify(expectedNames), 'Remote release asset names mismatch');

    for (const localArtifact of localReport.artifacts) {
        const remoteAsset = remoteAssets.find(asset => asset.name === localArtifact.name);
        assertEqual(remoteAsset?.size, localArtifact.size, `Remote size mismatch for ${localArtifact.name}`);
        assertEqual(remoteAsset?.digest, localArtifact.digest, `Remote digest mismatch for ${localArtifact.name}`);
    }
}

async function run() {
    const args = parseArguments(process.argv.slice(2));
    const distPath = path.resolve(args.dist || 'dist');
    const report = await validateLocalArtifacts({
        distPath,
        version: args.version,
        publisherName: args.publisher
    });
    if (args['remote-json']) validateRemoteAssets(report, path.resolve(args['remote-json']));
    if (args.report) fs.writeFileSync(path.resolve(args.report), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (require.main === module) {
    run().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { validateLocalArtifacts, validateRemoteAssets };
