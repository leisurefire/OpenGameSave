/**
 * <action-button> Web Component
 *
 * Button with FA icons in light DOM, styled by Shadow DOM.
 * This design allows Font Awesome icons to work correctly
 * without needing to replicate FA styles inside Shadow DOM.
 *
 * Usage:
 *   const btn = new ActionButton();
 *   btn.setAttribute('variant', 'danger'); // or 'default'
 *   btn.innerHTML = '<i class="fa-solid fa-trash"></i> Delete';
 *   btn.addEventListener('click', () => {...});
 */
class ActionButton extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._render();
    }

    static get observedAttributes() {
        return ['variant'];
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (name === 'variant' && this.shadowRoot) {
            this._updateVariantClass();
        }
    }

    _updateVariantClass() {
        const wrapper = this.shadowRoot.querySelector('.btn-wrapper');
        if (!wrapper) return;
        const variant = this.getAttribute('variant') || 'default';
        wrapper.className = variant === 'danger' ? 'btn-wrapper btn-danger' : 'btn-wrapper btn-default';
    }

    _render() {
        const variant = this.getAttribute('variant') || 'default';
        const variantClass = variant === 'danger' ? 'btn-danger' : 'btn-default';

        this.shadowRoot.innerHTML = `
            <style>
                :host {
                    display: inline-block;
                }

                .btn-wrapper {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.375rem;
                    padding: 0.375rem 0.75rem;
                    font-size: 0.75rem;
                    font-weight: 600;
                    font-family: var(--font-sans, "Segoe UI", sans-serif);
                    border-radius: var(--radius-win-sm, 4px);
                    border: 1px solid var(--color-win-border, rgba(255,255,255,0.08));
                    cursor: pointer;
                    transition: background-color 0.1s ease, border-color 0.1s ease;
                    white-space: nowrap;
                    user-select: none;
                }

                .btn-default {
                    background: rgba(255, 255, 255, 0.05);
                    border-top: 1px solid rgba(255, 255, 255, 0.16);
                    color: rgba(255, 255, 255, 0.9);
                }

                .btn-default:hover {
                    background: rgba(255, 255, 255, 0.08);
                }

                .btn-default:active {
                    background: rgba(255, 255, 255, 0.03);
                    color: rgba(255, 255, 255, 0.7);
                    border-top: 1px solid var(--color-win-border, rgba(255, 255, 255, 0.08));
                }

                .btn-danger {
                    background: rgba(239, 68, 68, 0.1);
                    color: rgb(239, 68, 68);
                    border-color: rgba(239, 68, 68, 0.3);
                }

                .btn-danger:hover {
                    background: rgba(239, 68, 68, 0.2);
                    border-color: rgba(239, 68, 68, 0.5);
                }

                .btn-danger:active {
                    opacity: 0.8;
                }

                /* Slotted content (icons + text) from light DOM */
                ::slotted(*) {
                    pointer-events: none;
                }
            </style>
            <div class="btn-wrapper ${variantClass}">
                <slot></slot>
            </div>
        `;

        // Forward click events from Shadow DOM to host element.
        // stopPropagation() prevents the original event from bubbling out of
        // the shadow boundary on its own, so we only fire one synthetic click.
        const wrapper = this.shadowRoot.querySelector('.btn-wrapper');
        wrapper.addEventListener('click', (e) => {
            e.stopPropagation();
            this.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
    }
}

customElements.define('action-button', ActionButton);

export default ActionButton;