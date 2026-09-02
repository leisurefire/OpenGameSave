import { createIcon } from '../icons.js';

let nextDropdownId = 0;

class DropdownSelect extends HTMLElement {
    static get observedAttributes() {
        return ['disabled', 'aria-label'];
    }

    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._value = '';
        this._options = [];
        this._activeIndex = -1;
        this._listboxId = `dropdown-listbox-${++nextDropdownId}`;
        this._handleDocumentPointerDown = this._handleDocumentPointerDown.bind(this);
        this._optionObserver = new MutationObserver(() => this._readOptions());
        this._render();
    }

    connectedCallback() {
        this._readOptions();
        this._optionObserver.observe(this, {
            attributes: true,
            attributeFilter: ['selected', 'value'],
            characterData: true,
            childList: true,
            subtree: true
        });
        document.addEventListener('pointerdown', this._handleDocumentPointerDown, true);
    }

    disconnectedCallback() {
        this._optionObserver.disconnect();
        document.removeEventListener('pointerdown', this._handleDocumentPointerDown, true);
    }

    attributeChangedCallback() {
        this._updateDisabled();
        this._updateAccessibleName();
    }

    get value() {
        return this._value;
    }

    set value(nextValue) {
        const stringValue = String(nextValue ?? '');
        if (this._options.length > 0 && !this._options.some(option => option.value === stringValue)) {
            return;
        }
        this._value = stringValue;
        this._updateSelection();
    }

    get disabled() {
        return this.hasAttribute('disabled');
    }

    set disabled(value) {
        this.toggleAttribute('disabled', Boolean(value));
    }

    focus(options) {
        this.shadowRoot.querySelector('.select-trigger')?.focus(options);
    }

    _readOptions() {
        this._options = Array.from(this.querySelectorAll('option')).map(option => ({
            value: option.value,
            label: option.textContent.trim(),
            selected: option.selected || option.hasAttribute('selected')
        }));

        const currentOption = this._options.find(option => option.value === this._value);
        const selectedOption = currentOption || this._options.find(option => option.selected) || this._options[0];
        this._value = selectedOption?.value || '';
        this._renderOptions();
        this._updateSelection();
    }

    _render() {
        this.shadowRoot.innerHTML = `
            <style>
                :host {
                    position: relative;
                    display: inline-block;
                    width: 156px;
                    color: var(--color-text-primary, rgba(255, 255, 255, 0.9));
                    font-family: var(--font-sans, "Segoe UI", sans-serif);
                    font-size: 13px;
                    line-height: 1.35;
                    user-select: none;
                }

                :host([disabled]) {
                    opacity: 0.5;
                    pointer-events: none;
                }

                :host([open]) {
                    z-index: 1000;
                }

                .select-trigger {
                    width: 100%;
                    min-height: var(--control-height, 34px);
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 10px;
                    padding: 0 10px 0 12px;
                    color: inherit;
                    font: inherit;
                    text-align: left;
                    background: rgba(255, 255, 255, 0.055);
                    border: 1px solid var(--color-control-border, rgba(255, 255, 255, 0.045));
                    border-radius: var(--radius-control-lg, 10px);
                    cursor: pointer;
                    transition: background-color 120ms ease, border-color 120ms ease;
                }

                .select-trigger:hover,
                .select-trigger[aria-expanded="true"] {
                    background: rgba(255, 255, 255, 0.075);
                    border-color: var(--color-control-border-hover, rgba(255, 255, 255, 0.085));
                }

                .select-trigger:focus-visible {
                    outline: 2px solid var(--color-focus-ring, #7de875);
                    outline-offset: 2px;
                }

                .selected-label {
                    min-width: 0;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }

                .chevron {
                    display: inline-flex;
                    flex: 0 0 auto;
                    color: rgba(255, 255, 255, 0.52);
                    transition: transform 120ms ease;
                }

                .select-trigger[aria-expanded="true"] .chevron {
                    transform: rotate(180deg);
                }

                .select-menu {
                    position: absolute;
                    top: calc(100% + 6px);
                    right: 0;
                    z-index: 100;
                    width: max(100%, 210px);
                    padding: 4px;
                    background: rgba(43, 43, 43, 0.99);
                    border: 1px solid rgba(255, 255, 255, 0.12);
                    border-radius: var(--radius-win, 12px);
                    box-shadow: 0 14px 36px rgba(0, 0, 0, 0.4);
                    transform-origin: top right;
                    animation: menu-in 120ms cubic-bezier(0.16, 1, 0.3, 1);
                }

                .select-menu.open-up {
                    top: auto;
                    bottom: calc(100% + 6px);
                    transform-origin: bottom right;
                }

                .select-menu[hidden] {
                    display: none;
                }

                .select-option {
                    width: 100%;
                    min-height: var(--control-height, 34px);
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 12px;
                    padding: 6px 9px;
                    color: rgba(255, 255, 255, 0.88);
                    font: inherit;
                    text-align: left;
                    background: transparent;
                    border: 0;
                    border-radius: var(--radius-control, 8px);
                    cursor: pointer;
                }

                .select-option:hover,
                .select-option.is-active {
                    background: rgba(255, 255, 255, 0.07);
                }

                .select-option[aria-selected="true"] {
                    color: rgba(255, 255, 255, 0.98);
                }

                .check,
                .chevron {
                    line-height: 0;
                }

                svg {
                    width: 15px;
                    height: 15px;
                    display: block;
                }

                @keyframes menu-in {
                    from { opacity: 0; transform: scale(0.98) translateY(-2px); }
                    to { opacity: 1; transform: scale(1) translateY(0); }
                }

                @media (prefers-reduced-motion: reduce) {
                    .select-menu { animation: none; }
                    .chevron { transition: none; }
                }
            </style>
            <button class="select-trigger" type="button" role="combobox" aria-haspopup="listbox"
                aria-expanded="false" aria-controls="${this._listboxId}">
                <span class="selected-label"></span>
                <span class="chevron"></span>
            </button>
            <div id="${this._listboxId}" class="select-menu" role="listbox" hidden></div>
        `;

        this._trigger = this.shadowRoot.querySelector('.select-trigger');
        this._menu = this.shadowRoot.querySelector('.select-menu');
        this._label = this.shadowRoot.querySelector('.selected-label');
        this.shadowRoot.querySelector('.chevron').appendChild(createIcon('chevron-down'));

        this._trigger.addEventListener('click', () => this._toggleMenu());
        this._trigger.addEventListener('keydown', event => this._handleKeyDown(event));
        this._updateDisabled();
        this._updateAccessibleName();
    }

    _renderOptions() {
        this._menu.replaceChildren();
        this._options.forEach((option, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'select-option';
            button.setAttribute('role', 'option');
            button.id = `${this._listboxId}-option-${index}`;
            button.dataset.index = String(index);

            const label = document.createElement('span');
            label.textContent = option.label;
            const check = document.createElement('span');
            check.className = 'check';
            button.append(label, check);

            button.addEventListener('pointerenter', () => {
                this._activeIndex = index;
                this._updateActiveOption();
            });
            button.addEventListener('click', () => this._selectIndex(index, true));
            this._menu.appendChild(button);
        });
    }

    _toggleMenu(forceOpen) {
        if (this.disabled) return;
        const shouldOpen = forceOpen ?? this._menu.hidden;
        if (!shouldOpen) {
            this._closeMenu();
            return;
        }

        this._menu.hidden = false;
        this.setAttribute('open', '');
        this._trigger.setAttribute('aria-expanded', 'true');
        this._activeIndex = Math.max(0, this._options.findIndex(option => option.value === this._value));

        const hostRect = this.getBoundingClientRect();
        const estimatedHeight = Math.min(this._options.length * 34 + 10, 280);
        const shouldOpenUp = hostRect.bottom + estimatedHeight + 12 > window.innerHeight && hostRect.top > estimatedHeight + 12;
        this._menu.classList.toggle('open-up', shouldOpenUp);
        this._updateActiveOption();
    }

    _closeMenu() {
        this._menu.hidden = true;
        this.removeAttribute('open');
        this._trigger.setAttribute('aria-expanded', 'false');
        this._trigger.removeAttribute('aria-activedescendant');
        this._activeIndex = -1;
        this._updateActiveOption();
    }

    _selectIndex(index, emitChange) {
        const option = this._options[index];
        if (!option) return;
        const changed = this._value !== option.value;
        this._value = option.value;
        this._updateSelection();
        this._closeMenu();
        this._trigger.focus();
        if (emitChange && changed) {
            this.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    _updateSelection() {
        if (!this._label || !this._menu) return;
        const selectedIndex = this._options.findIndex(option => option.value === this._value);
        const selectedOption = this._options[selectedIndex];
        this._label.textContent = selectedOption?.label || '';
        this._trigger.title = selectedOption?.label || '';

        this._menu.querySelectorAll('.select-option').forEach((button, index) => {
            const isSelected = index === selectedIndex;
            button.setAttribute('aria-selected', String(isSelected));
            const check = button.querySelector('.check');
            check.replaceChildren();
            if (isSelected) check.appendChild(createIcon('check'));
        });
    }

    _updateActiveOption() {
        this._menu?.querySelectorAll('.select-option').forEach((button, index) => {
            button.classList.toggle('is-active', index === this._activeIndex);
        });
        const activeOption = this._menu?.querySelector(`.select-option[data-index="${this._activeIndex}"]`);
        if (!this._menu?.hidden && activeOption) {
            this._trigger?.setAttribute('aria-activedescendant', activeOption.id);
        } else {
            this._trigger?.removeAttribute('aria-activedescendant');
        }
    }

    _updateDisabled() {
        if (this._trigger) this._trigger.disabled = this.disabled;
        if (this.disabled && this._menu) this._closeMenu();
    }

    _updateAccessibleName() {
        if (!this._trigger) return;
        const label = this.getAttribute('aria-label');
        if (label) this._trigger.setAttribute('aria-label', label);
        else this._trigger.removeAttribute('aria-label');
    }

    _handleKeyDown(event) {
        if (!['ArrowDown', 'ArrowUp', 'Enter', ' ', 'Escape', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();

        if (event.key === 'Escape') {
            this._closeMenu();
            return;
        }

        if (this._menu.hidden) {
            this._toggleMenu(true);
            if (event.key === 'Enter' || event.key === ' ') return;
        }

        if (event.key === 'ArrowDown') {
            this._activeIndex = Math.min(this._options.length - 1, this._activeIndex + 1);
        } else if (event.key === 'ArrowUp') {
            this._activeIndex = Math.max(0, this._activeIndex - 1);
        } else if (event.key === 'Home') {
            this._activeIndex = 0;
        } else if (event.key === 'End') {
            this._activeIndex = this._options.length - 1;
        } else if (event.key === 'Enter' || event.key === ' ') {
            this._selectIndex(this._activeIndex, true);
            return;
        }
        this._updateActiveOption();
    }

    _handleDocumentPointerDown(event) {
        if (!this.contains(event.target) && !event.composedPath().includes(this)) {
            this._closeMenu();
        }
    }
}

customElements.define('dropdown-select', DropdownSelect);

export default DropdownSelect;
