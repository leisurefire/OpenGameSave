#!/usr/bin/env node

const crypto = require('crypto');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');

const { parseDn } = require('builder-util-runtime');
const yaml = require('js-yaml');

const { getExpectedAppAssetNames, normalizeAppVersion } = require('../src/main/appUpdatePolicy');

const execFilePromise = util.promisify(execFile);

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

function publisherMatchesSubject(publisherName, certificateSubject) {
    const expected = parseDn(String(publisherName || ''));
    const actual = parseDn(String(certificateSubject || ''));
    if (expected.size > 0) {
        return [...expected].every(([key, value]) => actual.get(key) === value);
    }
    return Boolean(publisherName) && actual.get('CN') === publisherName;
}

async function verifyAuthenticodeSignature(installerPath, publisherName) {
    if (process.platform !== 'win32') {
        throw new Error('Authenticode verification requires a Windows release runner');
    }
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
        throw new Error('SystemRoot is unavailable for Authenticode verification');
    }
    const powershellPath = path.win32.join(
        systemRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
    );
    const command = [
        "$ErrorActionPreference = 'Stop'",
        '$signature = Get-AuthenticodeSignature -LiteralPath $env:OGS_AUTHENTICODE_PATH',
        "$subject = if ($null -eq $signature.SignerCertificate) { '' } else { $signature.SignerCertificate.Subject }",
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        '@{ Status = [string]$signature.Status; Subject = [string]$subject } | ConvertTo-Json -Compress'
    ].join('; ');
    const { stdout } = await execFilePromise(powershellPath, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-InputFormat', 'None',
        '-Command', command
    ], {
        env: { ...process.env, OGS_AUTHENTICODE_PATH: installerPath },
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 1024 * 1024
    });
    let signature;
    try {
        signature = JSON.parse(String(stdout || '').replace(/^\uFEFF/, '').trim());
    } catch (_) {
        throw new Error('Authenticode verification returned invalid output');
    }
    if (signature?.Status !== 'Valid') {
        throw new Error(`Installer Authenticode status is not Valid: ${signature?.Status || 'Unknown'}`);
    }
    if (!publisherMatchesSubject(publisherName, signature.Subject)) {
        throw new Error(`Installer certificate subject does not match the expected publisher: ${signature.Subject || '(none)'}`);
    }
    return { status: signature.Status, subject: signature.Subject };
}

function validatePackagedUpdateConfig(distPath, publisherName = null) {
    const configPath = path.join(distPath, 'win-unpacked', 'resources', 'app-update.yml');
    if (!fs.existsSync(configPath)) throw new Error(`Missing packaged updater configuration: ${configPath}`);
    const config = readYaml(configPath);
    if (publisherName) {
        const configuredPublishers = Array.isArray(config.publisherName)
            ? config.publisherName
            : [config.publisherName];
        if (!configuredPublishers.includes(publisherName)) {
            throw new Error('Packaged updater publisherName does not match the expected publisher');
        }
    }
    return config;
}

async function validateLocalArtifacts({
    distPath,
    version,
    publisherName,
    signatureVerifier = verifyAuthenticodeSignature
}) {
    if (typeof publisherName !== 'string' || !publisherName.trim() || /[\r\n]/.test(publisherName)) {
        throw new Error('A valid expected Windows publisher is required');
    }
    const expectedPublisher = publisherName.trim();
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
    validatePackagedUpdateConfig(distPath, expectedPublisher);
    const signature = await signatureVerifier(installerPath, expectedPublisher);

    const artifacts = await Promise.all([expected.installer, expected.blockmap, expected.metadata].map(async name => {
        const filePath = path.join(distPath, name);
        return {
            name,
            path: filePath,
            size: fs.statSync(filePath).size,
            digest: `sha256:${await hashFile(filePath, 'sha256', 'hex')}`
        };
    }));
    return { version, channel: expected.channel, signature, artifacts };
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
    if (!args.publisher) throw new Error('--publisher is required for release validation');
    const distPath = path.resolve(args.dist || 'dist');
    const report = await validateLocalArtifacts({
        distPath,
        version: args.version,
        publisherName: args.publisher || null
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

module.exports = {
    publisherMatchesSubject,
    validateLocalArtifacts,
    validateRemoteAssets,
    verifyAuthenticodeSignature
};
