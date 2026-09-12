import { renderIcon } from './js/icons.js';
import './menu.css';
import { startRenderer } from './tauriBridge.js';

let activeRequestId = null;
let menuGeneration = 0;
let acceptingActions = false;

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
    items[normalizedIndex].scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function handleMenuKeyDown(event) {
    if (!acceptingActions) return;
    const menu = event.currentTarget;
    const items = getEnabledMenuItems(menu);
    const activeIndex = items.indexOf(document.activeElement);

    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        acceptingActions = false;
        window.api.send('resize-and-show-menu', { dismiss: true, requestId: activeRequestId });
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

async function measureAndShowMenu(menu, requestId, generation = menuGeneration) {
    // Hidden WebViews may not produce animation frames. Reading layout after
    // constructing the menu lets the host size and show it immediately.
    if (requestId !== activeRequestId) return;
    // The previous display may have been constrained by a shorter monitor or
    // menu. Measure this payload at its natural CSS height before asking Rust.
    menu.style.maxHeight = '';
    const style = window.getComputedStyle(document.body);
    const inset = {
        top: parseFloat(style.paddingTop) || 0,
        right: parseFloat(style.paddingRight) || 0,
        bottom: parseFloat(style.paddingBottom) || 0,
        left: parseFloat(style.paddingLeft) || 0
    };
    const horizontalPadding = inset.left + inset.right;
    const verticalPadding = inset.top + inset.bottom;
    const width = Math.ceil(Math.max(menu.offsetWidth, menu.scrollWidth + 2) + horizontalPadding);
    const height = Math.ceil(menu.offsetHeight + verticalPadding + 2);
    await window.api.send('resize-and-show-menu', { width, height, inset, requestId });
    // A reused hidden WebView may receive another payload while the host
    // applies the previous size. Only the current display can take focus.
    if (generation === menuGeneration && requestId === activeRequestId && acceptingActions) {
        // Rust clamps the native window to the monitor's work area. Constrain
        // the scroll container to the resulting viewport so its last item is
        // reachable even when the requested natural height did not fit.
        menu.style.maxHeight = `${Math.max(1, window.innerHeight - verticalPadding - 2)}px`;
        focusMenuItem(menu, 0);
        // Replay after the native window is shown, including when it is reused.
        if (typeof menu.animate === 'function' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            menu.getAnimations().forEach(animation => animation.cancel());
            const motion = window.getComputedStyle(menu);
            menu.animate([
                { opacity: 0, transform: 'scale(0.98)' },
                { opacity: 1, transform: 'scale(1)' }
            ], {
                duration: parseFloat(motion.getPropertyValue('--motion-normal')) || 180,
                easing: motion.getPropertyValue('--motion-ease').trim() || 'ease-out'
            });
        }
    }
}

startRenderer(async () => {
    window.api.receive('set-menu-items', async (payload) => {
        const { items, direction, locale, requestId } = getMenuPayload(payload);
        const menu = document.getElementById('menu');
        const wrapper = document.getElementById('menu-content-wrapper');

        if (!menu || !wrapper || !Array.isArray(items)) {
            return;
        }
        activeRequestId = requestId;
        const generation = ++menuGeneration;
        acceptingActions = true;

        if (typeof locale === 'string' && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)) {
            document.documentElement.lang = locale;
        }

        wrapper.replaceChildren();
        menu.scrollTop = 0;
        menu.setAttribute('role', 'menu');
        menu.dataset.direction = direction === 'up' ? 'up' : 'down';
        menu.dataset.requestId = String(requestId ?? '');

        items.forEach((item, index) => {
            const menuItem = document.createElement('button');
            menuItem.type = 'button';
            menuItem.className = 'menu-item';
            menuItem.setAttribute('role', 'menuitem');
            menuItem.disabled = item?.disabled === true;
            menuItem.tabIndex = index === 0 ? 0 : -1;

            appendIcon(menuItem, item?.icon);

            const label = document.createElement('span');
            label.textContent = String(item?.label || '');
            menuItem.appendChild(label);

            menuItem.addEventListener('pointerenter', () => {
                if (menuItem.disabled || !acceptingActions || generation !== menuGeneration) return;
                focusMenuItem(menu, getEnabledMenuItems(menu).indexOf(menuItem));
            });
            menuItem.addEventListener('click', () => {
                if (menuItem.disabled || !acceptingActions || generation !== menuGeneration) return;
                acceptingActions = false;
                Promise.resolve(window.api.send('menu-item-click', item?.action, item?.data, requestId)).catch(() => {
                    if (generation === menuGeneration) acceptingActions = true;
                });
            });

            wrapper.appendChild(menuItem);
        });

        menu.onkeydown = handleMenuKeyDown;
        await measureAndShowMenu(menu, requestId, generation);
    });
});
