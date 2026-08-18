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

    _updateState() {
        const button = this.shadowRoot.querySelector('.btn-wrapper');
        if (!button) return;
        button.disabled = this.hasAttribute('disabled');
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
                    min-height: 28px;
                    padding: 4px 9px;
                    width: 100%;
                    height: 100%;
                    box-sizing: border-box;
                    font-size: 11.5px;
                    font-weight: 600;
                    font-family: var(--font-sans, "Segoe UI", sans-serif);
                    border-radius: var(--radius-win-sm, 4px);
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
                    outline: 2px solid color-mix(in srgb, var(--system-accent, #16c60c) 62%, white);
                    outline-offset: 2px;
                }

                .btn-default {
                    background: rgba(255, 255, 255, 0.05);
                    color: rgba(255, 255, 255, 0.9);
                }

                .btn-default:hover {
                    background: rgba(255, 255, 255, 0.08);
                    border-color: var(--color-control-border-hover, rgba(255,255,255,0.085));
                }

                .btn-default:active {
                    background: rgba(255, 255, 255, 0.03);
                    color: rgba(255, 255, 255, 0.7);
                }

                .btn-danger {
                    background: var(--color-danger-surface, #b3261e);
                    color: var(--color-danger-foreground, #fff);
                    border-color: transparent;
                }

                .btn-danger:hover {
                    background: var(--color-danger-surface-hover, #c42b1c);
                }

                .btn-danger:active {
                    background: var(--color-danger-surface-active, #9f211a);
                }

                /* Slotted content (icons + text) from light DOM */
                ::slotted(*) {
                    pointer-events: none;
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
