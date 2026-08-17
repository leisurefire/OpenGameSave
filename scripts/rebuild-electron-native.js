const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const electronPackagePath = path.join(projectRoot, 'node_modules', 'electron', 'package.json');
const electronAbiPath = path.join(projectRoot, 'node_modules', 'electron', 'abi_version');
const nativeModulePath = path.join(
    projectRoot,
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node'
);

function readNativeModuleAbi(modulePath) {
    const binaryText = fs.readFileSync(modulePath).toString('latin1');
    const match = binaryText.match(/node_register_module_v(\d+)/);
    return match?.[1] || null;
}

async function main() {
    const { rebuild } = await import('@electron/rebuild');
    const electronVersion = JSON.parse(fs.readFileSync(electronPackagePath, 'utf8')).version;
    const expectedAbi = fs.readFileSync(electronAbiPath, 'utf8').trim();
    const currentAbi = fs.existsSync(nativeModulePath) ? readNativeModuleAbi(nativeModulePath) : null;

    if (currentAbi === expectedAbi) {
        console.log(`better-sqlite3 already matches Electron ABI ${expectedAbi}.`);
        return;
    }

    console.log(
        `Rebuilding better-sqlite3 for Electron ${electronVersion}: ` +
        `${currentAbi || 'missing'} -> ABI ${expectedAbi}...`
    );
    await rebuild({
        buildPath: projectRoot,
        electronVersion,
        onlyModules: ['better-sqlite3'],
        force: true,
        buildFromSource: true,
    });

    const actualAbi = readNativeModuleAbi(nativeModulePath);
    if (actualAbi !== expectedAbi) {
        throw new Error(`better-sqlite3 ABI verification failed: expected ${expectedAbi}, got ${actualAbi || 'unknown'}`);
    }

    console.log(`Verified better-sqlite3 ABI ${actualAbi}.`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
