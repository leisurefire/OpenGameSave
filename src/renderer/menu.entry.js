import '../../node_modules/@fortawesome/fontawesome-free/css/all.min.css';
import './menu.css';

function getMenuPayload(payload) {
    return {
        items: Array.isArray(payload) ? payload : payload?.items,
        direction: Array.isArray(payload) ? 'down' : payload?.direction || 'down'
    };
}

function appendIcon(parent, iconClasses) {
    if (!iconClasses) {
        return;
    }

    const safeClasses = String(iconClasses)
        .split(/\s+/)
        .filter(className => /^(fa|fa-[a-z0-9-]+|fa[a-z0-9-]+)$/i.test(className));

    if (safeClasses.length === 0) {
        return;
    }

    const icon = document.createElement('i');
    icon.classList.add(...safeClasses);
    parent.appendChild(icon);
}

function measureAndShowMenu(menu) {
    requestAnimationFrame(() => {
        const style = window.getComputedStyle(document.body);
        const horizontalPadding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        const verticalPadding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
        const width = Math.ceil(menu.scrollWidth + horizontalPadding + 2);
        const height = Math.ceil(menu.offsetHeight + verticalPadding + 2);
        window.api.send('resize-and-show-menu', { width, height });
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
