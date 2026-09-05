const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createComponentHarness() {
    let focusedElement = null;
    const observed = new Set();
    const documentListeners = new Set();
    class Element extends EventTarget {
        constructor(tagName = '') {
            super();
            this.tagName = tagName;
            this.attributes = new Map();
            this.children = [];
            this.dataset = {};
            this.textContent = '';
            this.hidden = false;
            this.style = { setProperty() {} };
            this.classList = {
                toggle: (name, enabled) => {
                    const classes = new Set((this.className || '').split(' ').filter(Boolean));
                    if (enabled) classes.add(name);
                    else classes.delete(name);
                    this.className = [...classes].join(' ');
                }
            };
        }

        getAttribute(name) { return this.attributes.get(name) ?? null; }
        hasAttribute(name) { return this.attributes.has(name); }
        setAttribute(name, value) {
            const previous = this.getAttribute(name);
            this.attributes.set(name, String(value));
            if (this.constructor.observedAttributes?.includes(name)) {
                this.attributeChangedCallback(name, previous, String(value));
            }
        }
        removeAttribute(name) {
            const previous = this.getAttribute(name);
            this.attributes.delete(name);
            if (previous !== null && this.constructor.observedAttributes?.includes(name)) {
                this.attributeChangedCallback(name, previous, null);
            }
        }
        toggleAttribute(name, enabled) {
            if (enabled) this.setAttribute(name, '');
            else this.removeAttribute(name);
        }
        append(...children) { children.forEach(child => this.appendChild(child)); }
        appendChild(child) {
            child.parentElement = this;
            this.children.push(child);
            return child;
        }
        replaceChildren(...children) {
            this.children.forEach(child => { child.parentElement = null; });
            this.children = [];
            this.append(...children);
        }
        contains(target) {
            return target === this || this.children.some(child => child.contains(target));
        }
        closest(selector) {
            if (this.tagName === selector) return this;
            return this.parentElement?.closest(selector) || null;
        }
        querySelectorAll(selector) {
            const matches = element => {
                if (selector === 'option') return element.tagName === 'option';
                const [className, index] = selector.slice(1).split('[data-index="');
                return (element.className || '').split(' ').includes(className)
                    && (index === undefined || element.dataset.index === index.slice(0, -2));
            };
            return this.children.flatMap(child => [
                ...(matches(child) ? [child] : []),
                ...child.querySelectorAll(selector)
            ]);
        }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        focus() { focusedElement = this; }
        click() {
            if (!this.disabled) this.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
        }
        scrollIntoView() { this.scrolledIntoView = true; }
        getBoundingClientRect() { return { top: 300, bottom: 334 }; }
        attachShadow() {
            this.shadowRoot = new Element();
            return this.shadowRoot;
        }
        set innerHTML(source) {
            this.replaceChildren();
            const stack = [this];
            for (const match of source.matchAll(/<(\/)?(button|span|div)\b([^>]*)>/g)) {
                if (match[1]) {
                    stack.pop();
                    continue;
                }
                const element = new Element(match[2]);
                for (const attribute of match[3].matchAll(/([\w-]+)="([^"]*)"/g)) {
                    element.setAttribute(attribute[1], attribute[2]);
                    if (attribute[1] === 'class') element.className = attribute[2];
                    if (attribute[1] === 'id') element.id = attribute[2];
                }
                element.hidden = /\bhidden\b/.test(match[3]);
                stack.at(-1).appendChild(element);
                stack.push(element);
            }
        }
    }

    const context = vm.createContext({
        HTMLElement: Element,
        Event,
        Date,
        window: { innerHeight: 480 },
        customElements: { define() {} },
        createIcon: () => new Element('svg'),
        document: {
            createElement: tag => new Element(tag),
            addEventListener: (name, callback) => { documentListeners.add(callback); },
            removeEventListener: (name, callback) => { documentListeners.delete(callback); }
        },
        MutationObserver: class {
            constructor(callback) { this.callback = callback; }
            observe(element) { observed.add(element); }
            disconnect() { observed.clear(); }
        }
    });
    for (const component of ['ActionButton', 'ToggleSwitch', 'DropdownSelect']) {
        const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/components', `${component}.js`), 'utf8')
            .replace(/^import .*;\r?\n/gm, '')
            .replace(/^export default .*;\r?$/gm, '');
        vm.runInContext(source, context);
    }
    const create = component => vm.runInContext(`new ${component}()`, context);
    const option = (value, label, disabled = false) => {
        const result = new Element('option');
        result.value = value;
        result.textContent = label;
        result.disabled = disabled;
        return result;
    };
    const key = (component, value) => {
        const event = new Event('keydown', { cancelable: true });
        Object.defineProperty(event, 'key', { value });
        component._trigger.dispatchEvent(event);
        return event;
    };
    return { create, option, key, Element, observed, documentListeners, focused: () => focusedElement };
}

test('action buttons reflect disabled state and forward native focus and activation', () => {
    const harness = createComponentHarness();
    const button = harness.create('ActionButton');
    const nativeButton = button.shadowRoot.querySelector('.btn-wrapper');
    let nativeClicks = 0;
    let hostClicks = 0;
    nativeButton.addEventListener('click', () => { nativeClicks += 1; });
    button.addEventListener('click', () => { hostClicks += 1; });
    button.setAttribute('aria-label', 'Restore save');
    assert.equal(nativeButton.getAttribute('aria-label'), 'Restore save');
    button.focus();
    assert.equal(harness.focused(), nativeButton);
    button.disabled = true;
    assert.equal(button.hasAttribute('disabled'), true);
    assert.equal(nativeButton.disabled, true);
    button.click();
    button.dispatchEvent(new Event('click', { cancelable: true }));
    assert.equal(nativeClicks, 0);
    assert.equal(hostClicks, 0);
    button.disabled = false;
    button.click();
    assert.equal(nativeClicks, 1);
    button.removeAttribute('aria-label');
    assert.equal(nativeButton.hasAttribute('aria-label'), false);
});

test('switch reconnects do not duplicate activation and checked, disabled and labels stay synchronized', () => {
    const harness = createComponentHarness();
    const toggle = harness.create('ToggleSwitch');
    const nativeButton = toggle.shadowRoot.querySelector('.toggle-button');
    let changes = 0;
    toggle.addEventListener('change', () => { changes += 1; });
    toggle.connectedCallback();
    toggle.connectedCallback();
    toggle.connectedCallback();
    toggle.click();
    assert.equal(changes, 1);
    assert.equal(toggle.checked, true);
    assert.equal(nativeButton.getAttribute('aria-checked'), 'true');
    toggle.removeAttribute('checked');
    assert.equal(toggle.checked, false);
    assert.equal(changes, 1, 'programmatic changes do not emit user change events');
    toggle.setAttribute('checked', '');
    toggle.setAttribute('aria-label', 'Automatic backup');
    toggle.disabled = true;
    toggle.click();
    assert.equal(changes, 1);
    assert.equal(nativeButton.disabled, true);
    assert.equal(nativeButton.getAttribute('aria-label'), 'Automatic backup');
    toggle.disabled = false;
    toggle.focus();
    assert.equal(harness.focused(), nativeButton);
    toggle.click();
    assert.equal(toggle.checked, false);
    assert.equal(changes, 2);
});

test('dropdown keyboard navigation skips disabled options and Tab closes without trapping focus', () => {
    const harness = createComponentHarness();
    const select = harness.create('DropdownSelect');
    select.append(harness.option('a', 'Alpha'), harness.option('b', 'Beta', true), harness.option('c', 'Charlie'));
    select.connectedCallback();
    select.setAttribute('aria-label', 'Database edition');
    assert.equal(select._menu.getAttribute('aria-label'), 'Database edition');
    select.focus();
    harness.key(select, 'Enter');
    assert.equal(select._trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(harness.focused(), select._trigger);
    assert.ok(select._menu.children.every(option => option.tabIndex === -1));
    assert.equal(select._menu.children[1].disabled, true);
    harness.key(select, 'ArrowDown');
    assert.equal(select._activeIndex, 2);
    assert.equal(select._trigger.getAttribute('aria-activedescendant'), select._menu.children[2].id);
    assert.equal(select._menu.children[2].scrolledIntoView, true);
    const tab = harness.key(select, 'Tab');
    assert.equal(tab.defaultPrevented, false);
    assert.equal(select._menu.hidden, true);
    assert.equal(select._trigger.hasAttribute('aria-activedescendant'), false);
    assert.equal(select.value, 'a');
    harness.key(select, 'End');
    harness.key(select, 'Enter');
    assert.equal(select.value, 'c');
    assert.equal(select._menu.hidden, true);
});

test('dropdown type-ahead, disabled selection and reconnect cleanup preserve the interaction contract', () => {
    const harness = createComponentHarness();
    const select = harness.create('DropdownSelect');
    select.append(harness.option('a', 'Alpha'), harness.option('b', 'Beta', true), harness.option('c', 'Charlie'));
    select.connectedCallback();
    let changes = 0;
    select.addEventListener('change', () => { changes += 1; });
    harness.key(select, 'c');
    harness.key(select, 'Enter');
    assert.equal(select.value, 'c');
    assert.equal(changes, 1);
    select._selectIndex(1, true);
    assert.equal(select.value, 'c');
    select.disabled = true;
    select._selectIndex(0, true);
    harness.key(select, 'Home');
    assert.equal(select.value, 'c');
    assert.equal(select._menu.hidden, true);
    assert.equal(changes, 1);
    select.disabled = false;
    select._toggleMenu(true);
    const focusOut = new Event('focusout');
    Object.defineProperty(focusOut, 'relatedTarget', { value: new harness.Element('button') });
    select.dispatchEvent(focusOut);
    assert.equal(select._menu.hidden, true);
    select._toggleMenu(true);
    select.disconnectedCallback();
    assert.equal(select._menu.hidden, true);
    assert.equal(harness.documentListeners.size, 0);
    assert.equal(harness.observed.size, 0);
    select.connectedCallback();
    assert.equal(harness.documentListeners.size, 1);
    assert.equal(harness.observed.size, 1);
});
