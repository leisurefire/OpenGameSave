/**
 * <toggle-switch> Web Component
 *
 * Windows 11 style toggle switch.
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
        const track = this.shadowRoot.querySelector('.toggle-track');
        track.addEventListener('click', () => {
            if (this.disabled) return;
            this.checked = !this.checked;
            this.dispatchEvent(new Event('change', { bubbles: true }));
        });
    }

    _updateVisual() {
        const track = this.shadowRoot.querySelector('.toggle-track');
        const thumb = this.shadowRoot.querySelector('.toggle-thumb');
        if (this._checked) {
            track.classList.add('checked');
            thumb.classList.add('checked');
        } else {
            track.classList.remove('checked');
            thumb.classList.remove('checked');
        }
    }

    _render() {
        this.shadowRoot.innerHTML = `
            <style>
                :host {
                    display: inline-block;
                }

                :host([disabled]) {
                    opacity: 0.55;
                    pointer-events: none;
                }

                .toggle-track {
                    position: relative;
                    width: 40px;
                    height: 20px;
                    background: rgba(255, 255, 255, 0.1);
                    border: 1px solid rgba(255, 255, 255, 0.15);
                    border-radius: 10px;
                    cursor: pointer;
                    transition: background-color 0.15s ease, border-color 0.15s ease;
                }

                .toggle-track:hover {
                    background: rgba(255, 255, 255, 0.15);
                }

                .toggle-track.checked {
                    background: var(--system-accent, #16c60c);
                    border-color: var(--system-accent, #16c60c);
                }

                .toggle-thumb {
                    position: absolute;
                    top: 50%;
                    left: 3px;
                    transform: translateY(-50%);
                    width: 14px;
                    height: 14px;
                    background: #ffffff;
                    border-radius: 50%;
                    transition: transform 0.15s ease;
                }

                .toggle-thumb.checked {
                    transform: translateX(20px) translateY(-50%);
                }
            </style>
            <div class="toggle-track">
                <div class="toggle-thumb"></div>
            </div>
        `;
    }
}

customElements.define('toggle-switch', ToggleSwitch);

export default ToggleSwitch;
