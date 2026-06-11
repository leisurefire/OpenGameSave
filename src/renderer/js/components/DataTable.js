import ActionButton from './ActionButton.js';

/**
 * <data-table> Web Component
 *
 * Architecture:
 *  - Shadow DOM: container styling (border, bg, radius), sticky header
 *  - Light DOM: all rows live here so FA icons & global CSS work
 *  - MutationObserver: watches light DOM for new <tr> nodes and
 *    automatically applies table-row display + alignment styles
 *
 * Column alignment (Windows 11 convention):
 *  - widget first col: col[0,1] left, col[2..n-2] center, col[n-1] right
 *  - otherwise:        col[0]   left, col[1..n-2]  center, col[n-1] right
 */
class DataTable extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._columns = [];
        this._observer = null;
        this._render();
    }

    connectedCallback() {
        this._renderHeader();
        this._startObserver();
    }

    disconnectedCallback() {
        this._observer?.disconnect();
    }

    /** @param {{ label: string, align?: string, widget?: boolean }[]} columns */
    setColumns(columns) {
        this._columns = columns;
        this._renderHeader();
    }

    /**
     * Parse trHtml, process each <tr> and append to this element (light DOM).
     * MutationObserver will pick up the additions automatically.
     * @param {string} trHtml
     */
    appendRows(trHtml) {
        const temp = document.createElement('tbody');
        temp.innerHTML = trHtml;
        const aligns = this._computeAligns();

        // Disconnect observer while appending to avoid double-processing
        this._observer?.disconnect();

        Array.from(temp.querySelectorAll('tr')).forEach(tr => {
            this._processRow(tr, aligns);
            this.appendChild(tr);
        });

        // Reconnect observer for future dynamic additions
        this._startObserver();
    }

    clearRows() {
        Array.from(this.querySelectorAll('tr.dt-row')).forEach(tr => tr.remove());
    }

    // ── Private ──────────────────────────────────────────────────────────────

    _startObserver() {
        this._observer = new MutationObserver(mutations => {
            const aligns = this._computeAligns();
            mutations.forEach(m => {
                m.addedNodes.forEach(node => {
                    if (node.nodeType === 1 && node.tagName === 'TR') {
                        this._processRow(node, aligns);
                    }
                });
            });
        });
        this._observer.observe(this, { childList: true });
    }

    _processRow(tr, aligns) {
        tr.classList.add('dt-row');
        tr.querySelectorAll('td').forEach((td, i) => {
            td.classList.add('dt-cell');
            const hasButton = td.querySelector('button.btn-action, button.btn-danger');
            if (hasButton) {
                td.classList.add('dt-cell-btn');
            } else {
                td.style.textAlign = aligns[i] || 'left';
            }
            // Replace btn-action / btn-danger with <action-button>
            td.querySelectorAll('button.btn-action, button.btn-danger').forEach(btn => {
                const actionBtn = new ActionButton();
                actionBtn.setAttribute('variant', btn.classList.contains('btn-danger') ? 'danger' : 'default');
                // Copy data attributes and semantic class names (but not btn-action/btn-danger)
                Array.from(btn.attributes).forEach(attr => {
                    if (attr.name.startsWith('data-')) actionBtn.setAttribute(attr.name, attr.value);
                });
                // Preserve semantic classes like 'delete-backup-btn', but strip 'btn-action'/'btn-danger'
                const semanticClasses = Array.from(btn.classList).filter(cls =>
                    cls !== 'btn-action' && cls !== 'btn-danger'
                );
                if (semanticClasses.length > 0) {
                    actionBtn.className = semanticClasses.join(' ');
                }
                actionBtn.innerHTML = btn.innerHTML;
                btn.replaceWith(actionBtn);
            });
        });
    }

    _computeAligns() {
        const cols = this._columns;
        const n = cols.length;
        const firstIsWidget = cols[0]?.widget === true;
        return cols.map((col, i) => {
            if (col.align) return col.align;
            if (n === 1) return 'left';
            if (i === n - 1) return 'right';
            if (firstIsWidget) return (i === 0 || i === 1) ? 'left' : 'center';
            return i === 0 ? 'left' : 'center';
        });
    }

    _renderHeader() {
        const headRow = this.shadowRoot.getElementById('head-row');
        if (!headRow) return;
        const aligns = this._computeAligns();
        headRow.innerHTML = this._columns.map((col, i) =>
            `<div class="dt-th" style="text-align:${aligns[i]}">${this._esc(col.label)}</div>`
        ).join('');
    }

    _esc(str) {
        return String(str ?? '').replace(/[&<>"']/g, m =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
    }

    _render() {
        this.shadowRoot.innerHTML = `
            <style>
                :host {
                    display: block;
                    --_surface:    var(--color-win-surface,        rgba(30,30,30,0.1));
                    --_surface-hd: var(--color-win-surface-bright, rgba(50,50,50,1));
                    --_border:     var(--color-win-border,         rgba(255,255,255,0.08));
                    --_radius:     var(--radius-win,               8px);
                    --_font:       var(--font-sans,                "Segoe UI", sans-serif);
                }

                .dt-container {
                    background: var(--_surface);
                    border: 1px solid var(--_border);
                    border-radius: var(--_radius);
                    overflow: hidden;
                    font-family: var(--_font);
                    color: rgba(255,255,255,0.9);
                    font-size: 0.875rem;
                }

                /* Sticky header inside Shadow DOM */
                .dt-head {
                    background: var(--_surface-hd);
                    border-bottom: 1px solid var(--_border);
                    position: sticky;
                    top: 0;
                    z-index: 10;
                }

                #head-row {
                    display: flex;
                }

                .dt-th {
                    flex: 1;
                    padding: 0.625rem 1rem;
                    font-weight: 600;
                    text-transform: uppercase;
                    font-size: 0.7rem;
                    letter-spacing: 0.06em;
                    color: rgba(255,255,255,0.45);
                    white-space: nowrap;
                }

                /* Body area — light DOM rows appear here via default slot */
                .dt-body {
                    overflow-y: auto;
                }

                ::slotted(tr.dt-row) {
                    display: flex;
                    border-bottom: 1px solid rgba(255,255,255,0.04);
                    transition: background-color 0.1s ease;
                }

                ::slotted(tr.dt-row:hover) {
                    background-color: rgba(255,255,255,0.04);
                }
            </style>
            <div class="dt-container">
                <div class="dt-head"><div id="head-row"></div></div>
                <div class="dt-body"><slot></slot></div>
            </div>
        `;
    }
}

customElements.define('data-table', DataTable);

export default DataTable;