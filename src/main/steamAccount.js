const STEAM_ACCOUNT_ID_MASK = 0xFFFFFFFFn;

function getSteamAccountId(steamId64) {
    try {
        const normalizedId = String(steamId64 || '').trim();
        if (!/^\d+$/.test(normalizedId)) return null;
        return (BigInt(normalizedId) & STEAM_ACCOUNT_ID_MASK).toString();
    } catch (_) {
        return null;
    }
}

module.exports = { getSteamAccountId };
