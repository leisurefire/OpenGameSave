import { renderIcon } from './js/icons.js';
import './menu.css';

function getMenuPayload(payload) {
    return {
        items: Array.isArray(payload) ? payload : payload?.items,
        direction: Array.isArray(payload) ? 'down' : payload?.direction || 'down'
    };
}

function appendIcon(parent, iconName) {
    if (!iconName || !/^[a-z0-9-]+$/.test(String(iconName))) {
        return;
    }

    const icon = document.createElement('span');
    icon.className = 'menu-item-icon';
    renderIcon(icon, String(iconName));
    if (!icon.firstElementChild) return;
    parent.appendChild(icon);
}

function measureAndShowMenu(menu) {
    requestAnimationFrame(() => {
        const style = window.getComputedStyle(document.body);
        const inset = {
            top: parseFloat(style.paddingTop) || 0,
            right: parseFloat(style.paddingRight) || 0,
            bottom: parseFloat(style.paddingBottom) || 0,
            left: parseFloat(style.paddingLeft) || 0
        };
        const horizontalPadding = inset.left + inset.right;
        const verticalPadding = inset.top + inset.bottom;
        const width = Math.ceil(menu.scrollWidth + horizontalPadding + 2);
        const height = Math.ceil(menu.offsetHeight + verticalPadding + 2);
        window.api.send('resize-and-show-menu', { width, height, inset });
    });
}

window.api.receive('set-menu-items', (payload) => {
    const { items, direction } = getMenuPayload(payload);
    const menu = document.getElementById('menu');
    const wrapper = document.getElementById('menu-content-wrapper');

    if (!menu || !wrapper || !Array.isArray(items)) {
        return;
    }

    wrapper.replaceChildren();
    menu.dataset.direction = direction === 'up' ? 'up' : 'down';
    menu.style.animation = 'none';
    menu.offsetHeight;
    menu.style.animation = '';

    items.forEach(item => {
        const menuItem = document.createElement('div');
        menuItem.className = 'menu-item';

        appendIcon(menuItem, item?.icon);

        const label = document.createElement('span');
        label.textContent = String(item?.label || '');
        menuItem.appendChild(label);

        menuItem.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            window.api.send('menu-item-click', item?.action, item?.data);
        });

        wrapper.appendChild(menuItem);
    });

    measureAndShowMenu(menu);
});
