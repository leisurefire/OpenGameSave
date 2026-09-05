/**
 * <action-button> Web Component
 *
 * Compact button with light-DOM content, styled by Shadow DOM.
 *
 * Usage:
 *   const btn = new ActionButton();
 *   btn.setAttribute('variant', 'danger'); // or 'default'
 *   btn.innerHTML = '<span data-lucide-icon="trash-2"></span> Delete';
 *   btn.addEventListener('click', () => {...});
 */
class ActionButton extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open', delegatesFocus: true });
        this._render();
        this.addEventListener('click', event => {
            if (!this.disabled) return;
            event.preventDefault();
            event.stopImmediatePropagation();
        }, true);
    }

    static get observedAttributes() {
        return ['variant', 'disabled', 'aria-label'];
    }

    attributeChangedCallback(name) {
        if (!this.shadowRoot) return;
        if (name === 'variant') this._updateVariantClass();
        if (name === 'disabled' || name === 'aria-label') this._updateState();
    }

    _updateVariantClass() {
        const wrapper = this.shadowRoot.querySelector('.btn-wrapper');
        if (!wrapper) return;
        const variant = this.getAttribute('variant') || 'default';
        wrapper.className = variant === 'danger' ? 'btn-wrapper btn-danger' : 'btn-wrapper btn-default';
    }

    get disabled() {
        return this.hasAttribute('disabled');
    }

    set disabled(value) {
        this.toggleAttribute('disabled', Boolean(value));
    }

    focus(options) {
        this.shadowRoot.querySelector('.btn-wrapper')?.focus(options);
    }

    click() {
        this.shadowRoot.querySelector('.btn-wrapper')?.click();
    }

    _updateState() {
        const button = this.shadowRoot.querySelector('.btn-wrapper');
        if (!button) return;
        button.disabled = this.disabled;
        const label = this.getAttribute('aria-label');
        if (label) button.setAttribute('aria-label', label);
        else button.removeAttribute('aria-label');
    }

    _render() {
        const variant = this.getAttribute('variant') || 'default';
        const variantClass = variant === 'danger' ? 'btn-danger' : 'btn-default';

        this.shadowRoot.innerHTML = `
            <style>
                :host {
                    display: inline-flex;
                    align-self: stretch;
                }

                :host([style*="align-self:stretch"]),
                :host([style*="align-self: stretch"]) {
                    width: auto;
                }

                .btn-wrapper {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 0.375rem;
                    min-height: var(--control-height-compact, 28px);
                    padding: 4px 9px;
                    width: 100%;
                    height: 100%;
                    box-sizing: border-box;
                    font-size: var(--text-xs, 12px);
                    font-weight: 600;
                    font-family: var(--font-sans, "Segoe UI", sans-serif);
                    border-radius: var(--radius-control, 8px);
                    border: 1px solid var(--color-control-border, rgba(255,255,255,0.045));
                    cursor: pointer;
                    transition: background-color 0.1s ease, border-color 0.1s ease;
                    white-space: nowrap;
                    user-select: none;
                }

                .btn-wrapper:disabled {
                    cursor: not-allowed;
                    opacity: 0.5;
                }

                .btn-wrapper:focus-visible {
                    outline: 2px solid var(--color-focus-ring, #7de875);
                    outline-offset: 2px;
                }

                .btn-default {
                    background: var(--color-control-surface, rgba(255, 255, 255, 0.05));
                    color: var(--color-text-primary, rgba(255, 255, 255, 0.9));
                }

                .btn-default:hover:not(:disabled) {
                    background: var(--color-control-surface-hover, rgba(255, 255, 255, 0.08));
                    border-color: var(--color-control-border-hover, rgba(255,255,255,0.085));
                }

                .btn-default:active:not(:disabled) {
                    background: var(--color-win-surface-active, rgba(255, 255, 255, 0.025));
                    color: var(--color-text-secondary, rgba(255, 255, 255, 0.68));
                }

                .btn-danger {
                    background: var(--color-danger-surface, #b3261e);
                    color: var(--color-danger-foreground, #fff);
                    border-color: transparent;
                }

                .btn-danger:hover:not(:disabled) {
                    background: var(--color-danger-surface-hover, #c42b1c);
                }

                .btn-danger:active:not(:disabled) {
                    background: var(--color-danger-surface-active, #9f211a);
                }

                /* Slotted content (icons + text) from light DOM */
                ::slotted(*) {
                    pointer-events: none;
                }

                @media (prefers-reduced-motion: reduce) {
                    .btn-wrapper { transition: none; }
                }

                @media (forced-colors: active) {
                    .btn-wrapper { border-color: ButtonText; }
                    .btn-wrapper:disabled { color: GrayText; border-color: GrayText; }
                    .btn-wrapper:focus-visible { outline-color: Highlight; }
                }
            </style>
            <button type="button" class="btn-wrapper ${variantClass}">
                <slot></slot>
            </button>
        `;
        this._updateState();
    }
}

customElements.define('action-button', ActionButton);

export default ActionButton;
