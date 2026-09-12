function normalizeRegistryKeyPath(registryPath) {
    const normalized = String(registryPath || '').trim().replace(/\//g, '\\').replace(/\\+$/, '');
    if (normalized.length > 16384 || normalized.includes('\0') || /[\r\n]/.test(normalized)) {
        throw new Error('Invalid registry key path');
    }
    const segments = normalized.split('\\');
    if (segments.length < 3 || segments.some(segment => !segment || segment === '.' || segment === '..')) {
        throw new Error('Registry path is too broad');
    }
    const hive = segments[0].toUpperCase();
    const subkey = segments.slice(1).join('\\').toLowerCase();
    const forbiddenUserPrefixes = [
        'environment', 'volatile environment', 'system', 'control panel', 'console',
        'network', 'printers', 'sessioninformation', 'software\\classes', 'software\\policies',
        'software\\microsoft\\windows', 'software\\microsoft\\windows nt',
        'software\\microsoft\\internet explorer', 'software\\microsoft\\office',
        'software\\microsoft\\onedrive', 'software\\microsoft\\powershell'
    ];

    if (hive === 'HKEY_CURRENT_USER') {
        if (subkey === 'software\\microsoft'
            || forbiddenUserPrefixes.some(prefix => subkey === prefix || subkey.startsWith(`${prefix}\\`))) {
            throw new Error('Registry path targets a protected user key');
        }
    } else if (hive === 'HKEY_LOCAL_MACHINE') {
        if (!subkey.startsWith('software\\')
            || subkey === 'software\\microsoft'
            || ['software\\classes', 'software\\policies', 'software\\microsoft\\windows', 'software\\microsoft\\windows nt']
                .some(prefix => subkey === prefix || subkey.startsWith(`${prefix}\\`))) {
            throw new Error('Registry path targets a protected machine key');
        }
    } else if (hive === 'HKEY_CLASSES_ROOT') {
        if (!subkey.startsWith('virtualstore\\machine\\software\\')) {
            throw new Error('Registry path targets a protected classes key');
        }
    } else {
        throw new Error('Unsupported registry hive');
    }
    return `${hive}\\${segments.slice(1).join('\\')}`;
}

module.exports = { normalizeRegistryKeyPath };
