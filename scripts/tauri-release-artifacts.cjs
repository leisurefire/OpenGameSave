const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function buildManifest({ version, tag, installer, signature, repository = 'leisurefire/OpenGameSave' }) {
    if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) || tag !== `v${version}`) throw new Error('Release version and tag differ');
    if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid release repository');
    const name = path.basename(installer);
    if (!name.endsWith('.exe') || !name.includes(version) || name !== installer) throw new Error('Invalid installer name');
    if (!signature || !/^[A-Za-z0-9+/=\r\n]+$/.test(signature)) throw new Error('Missing or malformed updater signature');
    return {
        version, notes: `OpenGameSave ${version}`, pub_date: new Date().toISOString(),
        platforms: { 'windows-x86_64': { signature: signature.trim(), url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(name)}` } }
    };
}

function verifyAuthenticode(installer, expectedThumbprint) {
    if (process.platform !== 'win32' || !/^[A-F0-9]{40}$/i.test(expectedThumbprint || '')) throw new Error('Windows signing identity is required');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$s = Get-AuthenticodeSignature -LiteralPath $env:OGS_RELEASE_INSTALLER; @{ Status = [string]$s.Status; Thumbprint = $s.SignerCertificate.Thumbprint } | ConvertTo-Json -Compress'
    ], { encoding: 'utf8', windowsHide: true, env: { ...process.env, OGS_RELEASE_INSTALLER: installer } });
    if (result.status !== 0) throw new Error('Authenticode validation failed');
    const signature = JSON.parse(result.stdout.trim().replace(/^\uFEFF/, ''));
    if (signature.Status !== 'Valid' || signature.Thumbprint?.toUpperCase() !== expectedThumbprint.toUpperCase()) throw new Error('Installer signature identity mismatch');
}

function prepare() {
    const root = path.resolve(__dirname, '..');
    const version = require('../package.json').version;
    const bundle = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
    const installers = fs.readdirSync(bundle).filter(name => name.endsWith('.exe') && name.includes(`_${version}_`));
    if (installers.length !== 1) throw new Error('Expected exactly one installer for the release version');
    const installer = path.join(bundle, installers[0]);
    verifyAuthenticode(installer, process.env.OGS_CERTIFICATE_THUMBPRINT);
    const signature = fs.readFileSync(`${installer}.sig`, 'utf8');
    const manifest = buildManifest({ version, tag: `v${version}`, installer: installers[0], signature });
    const output = path.resolve(root, 'dist', 'release');
    // This directory contains only generated release artifacts. A previous
    // version must not be included by the workflow's dist/release/* upload.
    if (path.relative(root, output) !== path.join('dist', 'release')) throw new Error('Invalid release output directory');
    fs.rmSync(output, { recursive: true, force: true });
    fs.mkdirSync(output, { recursive: true });
    fs.copyFileSync(installer, path.join(output, installers[0]));
    fs.copyFileSync(`${installer}.sig`, path.join(output, `${installers[0]}.sig`));
    fs.writeFileSync(path.join(output, 'latest.json'), JSON.stringify(manifest, null, 2));
    const artifacts = [installers[0], `${installers[0]}.sig`, 'latest.json'].map(name => {
        const bytes = fs.readFileSync(path.join(output, name));
        return { name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    });
    fs.writeFileSync(path.join(output, 'checksums.json'), JSON.stringify(artifacts, null, 2));
}

module.exports = { buildManifest, verifyAuthenticode };
if (require.main === module) prepare();
