const MAX_XGP_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_XGP_ENTRIES = 1000;
const XGP_WIKI_IDS_METADATA_KEY = 'xgp_save_tools_wiki_ids';
const PACKAGE_PATTERN = /^[A-Za-z0-9._-]{1,255}$/;
const PGS_GAME_ID_PATTERN = /^[A-Fa-f0-9]{1,32}$/;

function stripJsonComments(value) {
    const input = String(value ?? '');
    if (Buffer.byteLength(input, 'utf8') > MAX_XGP_SOURCE_BYTES) {
        throw new Error('XgpSaveTools registry is too large');
    }

    let output = '';
    let inString = false;
    let escaped = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let index = 0; index < input.length; index += 1) {
        const current = input[index];
        const next = input[index + 1];

        if (inLineComment) {
            if (current === '\n' || current === '\r') {
                inLineComment = false;
                output += current;
            } else {
                output += ' ';
            }
            continue;
        }

        if (inBlockComment) {
            if (current === '*' && next === '/') {
                output += '  ';
                index += 1;
                inBlockComment = false;
            } else {
                output += current === '\n' || current === '\r' ? current : ' ';
            }
            continue;
        }

        if (inString) {
            output += current;
            if (escaped) {
                escaped = false;
            } else if (current === '\\') {
                escaped = true;
            } else if (current === '"') {
                inString = false;
            }
            continue;
        }

        if (current === '"') {
            inString = true;
            output += current;
        } else if (current === '/' && next === '/') {
            output += '  ';
            index += 1;
            inLineComment = true;
        } else if (current === '/' && next === '*') {
            output += '  ';
            index += 1;
            inBlockComment = true;
        } else {
            output += current;
        }
    }

    if (inString || inBlockComment) {
        throw new Error('XgpSaveTools registry contains unterminated JSON content');
    }
    return output;
}

function normalizeTitleKey(value) {
    return String(value ?? '')
        .replace(/[™®©]/g, '')
        .normalize('NFKC')
        .toLocaleLowerCase('en-US')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function normalizeXgpEntry(rawEntry) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
        throw new Error('XgpSaveTools registry contains an invalid game entry');
    }

    const name = typeof rawEntry.name === 'string' ? rawEntry.name.trim() : '';
    const packageName = typeof rawEntry.package === 'string' ? rawEntry.package.trim() : '';
    if (!name || name.length > 512 || !PACKAGE_PATTERN.test(packageName)) {
        throw new Error('XgpSaveTools registry contains an invalid game name or package');
    }

    const source = rawEntry.source === undefined ? 'wgs' : String(rawEntry.source).toLowerCase();
    let gameId = null;
    let savePath;
    if (source === 'wgs') {
        savePath = `{{p|localappdata}}/Packages/${packageName}/SystemAppData/wgs`;
    } else if (source === 'pgs') {
        const rawGameId = rawEntry.source_args?.game_id ?? rawEntry.gameId;
        gameId = typeof rawGameId === 'string'
            ? rawGameId.trim().toUpperCase()
            : '';
        if (!PGS_GAME_ID_PATTERN.test(gameId)) {
            throw new Error('XgpSaveTools registry contains an invalid PGS game id');
        }
        savePath = `{{p|systemdrive}}/XboxGames/GameSave/pgs/u_{{p|xbox_uid}}_${gameId}`;
    } else {
        throw new Error(`Unsupported XgpSaveTools source: ${source}`);
    }

    return {
        name,
        titleKey: normalizeTitleKey(name),
        package: packageName,
        source,
        gameId,
        savePath
    };
}

function normalizeXgpEntries(rawEntries) {
    if (!Array.isArray(rawEntries) || rawEntries.length > MAX_XGP_ENTRIES) {
        throw new Error('XgpSaveTools registry contains an invalid games list');
    }

    const entries = [];
    const seen = new Set();
    for (const rawEntry of rawEntries) {
        const entry = normalizeXgpEntry(rawEntry);
        const identity = `${entry.titleKey}\0${entry.package.toLowerCase()}\0${entry.source}\0${entry.gameId || ''}`;
        if (!seen.has(identity)) {
            seen.add(identity);
            entries.push(entry);
        }
    }
    return entries;
}

function parseXgpGamesJson(rawJson) {
    let parsed;
    try {
        parsed = JSON.parse(stripJsonComments(rawJson));
    } catch (error) {
        throw new Error(`Unable to parse XgpSaveTools registry: ${error.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('XgpSaveTools registry root is invalid');
    }
    return normalizeXgpEntries(parsed.games);
}

module.exports = {
    MAX_XGP_SOURCE_BYTES,
    XGP_WIKI_IDS_METADATA_KEY,
    normalizeTitleKey,
    normalizeXgpEntries,
    parseXgpGamesJson,
    stripJsonComments
};
