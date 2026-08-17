/**
 * <toggle-switch> Web Component
 *
 * Compact Codex/Fluent style toggle switch.
 *
 * Usage:
 *   <label>
 *       <toggle-switch id="my-switch"></toggle-switch>
 *       <span>Enable feature</span>
 *   </label>
 *
 *   // In JS:
 *   const toggle = document.getElementById('my-switch');
 *   toggle.checked = true;
 *   toggle.addEventListener('change', (e) => {
 *       console.log('Checked:', e.target.checked);
 *   });
 */
class ToggleSwitch extends HTMLElement {
    static get observedAttributes() {
        return ['disabled', 'aria-label'];
    }

    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._checked = false;
        this._render();
    }

    get checked() {
        return this._checked;
    }

    set checked(value) {
        this._checked = !!value;
        this._updateVisual();
    }

    get disabled() {
        return this.hasAttribute('disabled');
    }

    set disabled(value) {
        this.toggleAttribute('disabled', !!value);
    }

    connectedCallback() {
        this.shadowRoot.querySelector('.toggle-button').addEventListener('click', () => {
            if (this.disabled) return;
            this.checked = !this.checked;
            this.dispatchEvent(new Event('change', { bubbles: true }));
        });
        this._updateVisual();
    }

    attributeChangedCallback() {
        this._updateVisual();
    }

    _updateVisual() {
        const button = this.shadowRoot.querySelector('.toggle-button');
        if (!button) return;
        button.classList.toggle('checked', this._checked);
        button.setAttribute('aria-checked', String(this._checked));
        button.disabled = this.disabled;
        const label = this.getAttribute('aria-label');
        if (label) button.setAttribute('aria-label', label);
        else button.removeAttribute('aria-label');
    }

    _render() {
        this.shadowRoot.innerHTML = `
            <style>
                :host {
                    display: inline-flex;
                    flex: 0 0 auto;
                    vertical-align: middle;
                }

                :host([disabled]) {
                    opacity: 0.55;
                    cursor: not-allowed;
                }

                .toggle-button {
                    position: relative;
                    width: 34px;
                    height: 20px;
                    padding: 2px;
                    background: rgba(255, 255, 255, 0.17);
                    border: 0;
                    border-radius: 999px;
                    cursor: pointer;
                    transition: background-color 140ms ease, box-shadow 140ms ease;
                }

                .toggle-button:hover {
                    background: rgba(255, 255, 255, 0.23);
                }

                .toggle-button.checked {
                    background: var(--system-accent, #16c60c);
                }

                .toggle-button.checked:hover {
                    filter: brightness(1.08);
                }

                .toggle-button:focus-visible {
                    outline: 2px solid color-mix(in srgb, var(--system-accent, #16c60c) 62%, white);
                    outline-offset: 2px;
                }

                .toggle-thumb {
                    position: absolute;
                    top: 2px;
                    left: 2px;
                    width: 16px;
                    height: 16px;
                    background: #ffffff;
                    border-radius: 50%;
                    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.32);
                    transition: transform 140ms cubic-bezier(0.2, 0, 0, 1);
                }

                .toggle-button.checked .toggle-thumb {
                    transform: translateX(14px);
                }

                @media (prefers-reduced-motion: reduce) {
                    .toggle-button,
                    .toggle-thumb { transition: none; }
                }
            </style>
            <button type="button" class="toggle-button" role="switch" aria-checked="false">
                <span class="toggle-thumb"></span>
            </button>
        `;
    }
}

customElements.define('toggle-switch', ToggleSwitch);

export default ToggleSwitch;
