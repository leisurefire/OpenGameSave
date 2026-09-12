const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Invalid package version');
const cargoPath = path.join(root, 'src-tauri', 'Cargo.toml');
const cargo = fs.readFileSync(cargoPath, 'utf8');
fs.writeFileSync(cargoPath, cargo.replace(/^(version\s*=\s*)"[^"]+"/m, `$1"${version}"`));
if (process.argv.includes('--release')) {
    const publicKey = process.env.OGS_UPDATER_PUBLIC_KEY?.trim();
    const thumbprint = process.env.OGS_CERTIFICATE_THUMBPRINT?.trim();
    if (!publicKey || !process.env.TAURI_SIGNING_PRIVATE_KEY || !/^[A-F0-9]{40}$/i.test(thumbprint || '')) {
        throw new Error('A public updater key, private signing key and Windows certificate thumbprint are required');
    }
    const config = {
        bundle: {
            createUpdaterArtifacts: true,
            windows: { certificateThumbprint: thumbprint, digestAlgorithm: 'sha256', timestampUrl: 'http://timestamp.digicert.com' }
        },
        plugins: { updater: { pubkey: publicKey } }
    };
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist', 'tauri-release.json'), JSON.stringify(config, null, 2));
}
