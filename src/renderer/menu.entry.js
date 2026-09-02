import { renderIcon } from './js/icons.js';
import './menu.css';

function getMenuPayload(payload) {
    return {
        items: Array.isArray(payload) ? payload : payload?.items,
        direction: Array.isArray(payload) ? 'down' : payload?.direction || 'down',
        locale: Array.isArray(payload) ? 'en-US' : payload?.locale,
        requestId: Array.isArray(payload) ? null : payload?.requestId
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

function getEnabledMenuItems(menu) {
    return [...menu.querySelectorAll('.menu-item:not(:disabled)')];
}

function focusMenuItem(menu, index) {
    const items = getEnabledMenuItems(menu);
    if (items.length === 0) return;
    const normalizedIndex = (index + items.length) % items.length;
    items.forEach((item, itemIndex) => {
        item.tabIndex = itemIndex === normalizedIndex ? 0 : -1;
    });
    items[normalizedIndex].focus({ preventScroll: true });
}

function handleMenuKeyDown(event) {
    const menu = event.currentTarget;
    const items = getEnabledMenuItems(menu);
    const activeIndex = items.indexOf(document.activeElement);

    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        window.api.send('resize-and-show-menu', { dismiss: true });
        return;
    }

    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || items.length === 0) return;
    event.preventDefault();
    const baseIndex = activeIndex >= 0 ? activeIndex : (event.key === 'ArrowUp' ? 0 : -1);
    const nextIndex = event.key === 'Home' ? 0
        : event.key === 'End' ? items.length - 1
            : baseIndex + (event.key === 'ArrowDown' ? 1 : -1);
    focusMenuItem(menu, nextIndex);
}

function measureAndShowMenu(menu, requestId) {
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
        window.api.send('resize-and-show-menu', { width, height, inset, requestId });
        focusMenuItem(menu, 0);
    });
}

window.api.receive('set-menu-items', (payload) => {
    const { items, direction, locale, requestId } = getMenuPayload(payload);
    const menu = document.getElementById('menu');
    const wrapper = document.getElementById('menu-content-wrapper');

    if (!menu || !wrapper || !Array.isArray(items)) {
        return;
    }

    if (typeof locale === 'string' && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)) {
        document.documentElement.lang = locale;
    }

    wrapper.replaceChildren();
    menu.setAttribute('role', 'menu');
    menu.dataset.direction = direction === 'up' ? 'up' : 'down';
    menu.style.animation = 'none';
    menu.offsetHeight;
    menu.style.animation = '';

    items.forEach((item, index) => {
        const menuItem = document.createElement('button');
        menuItem.type = 'button';
        menuItem.className = 'menu-item';
        menuItem.setAttribute('role', 'menuitem');
        menuItem.tabIndex = index === 0 ? 0 : -1;

        appendIcon(menuItem, item?.icon);

        const label = document.createElement('span');
        label.textContent = String(item?.label || '');
        menuItem.appendChild(label);

        menuItem.addEventListener('pointerenter', () => {
            focusMenuItem(menu, getEnabledMenuItems(menu).indexOf(menuItem));
        });
        menuItem.addEventListener('click', () => {
            window.api.send('menu-item-click', item?.action, item?.data);
        });

        wrapper.appendChild(menuItem);
    });

    menu.onkeydown = handleMenuKeyDown;
    measureAndShowMenu(menu, requestId);
});
