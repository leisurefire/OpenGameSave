import { ACTION_ICONS } from './icons.js';

export function setDropDownAction() {
    document.addEventListener('click', async (event) => {
        const button = event.target.closest('.dropdown-menu-button');

        if (button) {
            event.stopPropagation();
            if (button === window.activeMenuTrigger) {
                // Clicking the same button again should hide the menu
                window.api.send('hide-popup-menu');
                button.setAttribute('aria-expanded', 'false');
                window.activeMenuTrigger = null;
                return;
            }

            const row = button.closest('tr');
            const wikiPageId = row.getAttribute('data-wiki-id');
            const tabName = button.closest('#backup, #restore, #custom')?.id || 'backup';

            const settings = await window.api.invoke('get-settings');
            const isFavorite = (settings.pinnedGames || []).includes(wikiPageId.toString());
            const isBlocked = (settings.blockedGames || []).includes(wikiPageId.toString());
            const wikiUrl = !wikiPageId.includes('-') ? `https://www.pcgamingwiki.com/wiki/index.php?curid=${wikiPageId}` : 'none';

            const menuItems = [
                {
                    label: await window.i18n.translate(isFavorite ? 'main.remove_favorite' : 'main.add_favorite'),
                    icon: isFavorite ? 'heart-crack' : 'heart',
                    action: isFavorite ? 'unfavorite' : 'add-favorite',
                    data: wikiPageId
                },
                {
                    label: await window.i18n.translate(isBlocked ? 'main.unblock_game' : 'main.block_game'),
                    icon: isBlocked ? 'eye' : 'ban',
                    action: isBlocked ? 'unblock-game' : 'block-game',
                    data: wikiPageId
                },
                {
                    label: await window.i18n.translate('main.auto_backup'),
                    icon: 'timer-reset',
                    action: 'auto-backup',
                    data: wikiPageId,
                    visible: tabName !== 'restore'
                },
                {
                    label: await window.i18n.translate('main.manage_backups'),
                    icon: 'list-checks',
                    action: 'manage-backups',
                    data: wikiPageId
                },
                {
                    label: await window.i18n.translate('main.browse_local_save'),
                    icon: ACTION_ICONS.manageLocalData,
                    action: 'manage-local-data',
                    data: wikiPageId
                },
                {
                    label: await window.i18n.translate('main.view_wiki'),
                    icon: 'globe',
                    action: 'open-wiki',
                    data: wikiUrl
                }
            ].filter(item => item.visible !== false);

            const rect = button.getBoundingClientRect();
            const menuGap = 4;
            const estimatedMenuHeight = menuItems.length * 34 + 10;
            const availableAbove = rect.top;
            const availableBelow = window.innerHeight - rect.bottom;
            // Open upward only when the measured row count will not fit below
            // and the upper side genuinely has more room. The previous fixed
            // 260px threshold made menus jump upward much too early.
            const shouldOpenUp = availableBelow < estimatedMenuHeight + menuGap
                && availableAbove > availableBelow;
            window.activeMenuTrigger?.setAttribute('aria-expanded', 'false');
            button.setAttribute('aria-expanded', 'true');
            window.activeMenuTrigger = button;
            window.api.send('show-popup-menu', {
                items: menuItems,
                x: rect.right + 4,
                y: shouldOpenUp ? rect.top - menuGap : rect.bottom + menuGap,
                direction: shouldOpenUp ? 'up' : 'down'
            });
        }
    });

    // Close on scroll in either table
    ['#backup .table-container', '#restore .table-container'].forEach(selector => {
        const el = document.querySelector(selector);
        if (el) el.addEventListener('scroll', () => {
            window.api.send('hide-popup-menu');
            window.activeMenuTrigger?.setAttribute('aria-expanded', 'false');
            window.activeMenuTrigger = null;
        });
    });
}
