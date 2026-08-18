const displayCollators = new Map();

function getDisplayCollator(language) {
    const locale = language === 'zh_CN' ? 'zh-CN' : 'en-US';
    if (!displayCollators.has(locale)) {
        displayCollators.set(locale, new Intl.Collator(locale, {
            numeric: true,
            sensitivity: 'base'
        }));
    }
    return displayCollators.get(locale);
}

function withTitleToSort(game, settings) {
    const titleToSort = settings.language === 'zh_CN' ? game.zh_CN || game.title : game.title;
    return { ...game, titleToSort: titleToSort || '' };
}

export function sortGamesForDisplay(games, settings) {
    const collator = getDisplayCollator(settings.language);
    return [...games].sort((left, right) => (
        collator.compare(left.titleToSort || '', right.titleToSort || '')
    ));
}

export function getSortedFavoriteGroups(games, settings) {
    const favoriteWikiIds = settings.pinnedGames || [];
    const gamesWithTitleToSort = games.map(game => withTitleToSort(game, settings));
    const isFavorite = game => favoriteWikiIds.includes(game.wiki_page_id.toString());

    return {
        favoriteGames: sortGamesForDisplay(gamesWithTitleToSort.filter(isFavorite), settings),
        otherGames: sortGamesForDisplay(gamesWithTitleToSort.filter(game => !isFavorite(game)), settings)
    };
}
