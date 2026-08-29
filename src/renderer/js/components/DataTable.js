import ActionButton from './ActionButton.js';
import { appendRows as appendVirtualRows, disableVirtualRows } from '../virtualTable.js';

/**
 * <data-table> Web Component
 *
 * Architecture:
 *  - Shadow DOM: container styling (border, bg, radius), sticky header
 *  - Light DOM: visible rows live here so shared icons and global CSS work
 *  - appendRows(): serializes large inputs and materializes only the viewport
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
        this._render();
    }

    connectedCallback() {
        this._renderHeader();
    }

    disconnectedCallback() {
        disableVirtualRows(this);
    }

    /** @param {{ label: string, align?: string, widget?: boolean }[]} columns */
    setColumns(columns) {
        this._columns = columns;
        const template = columns.map(column => column.width || 'minmax(0, 1fr)').join(' ');
        this.style.setProperty('--dt-columns', template || 'minmax(0, 1fr)');
        this._renderHeader();
    }

    /**
     * Parse trHtml, process each <tr> and append to this element (light DOM).
     * @param {string} trHtml
     */
    appendRows(trHtml) {
        const temp = document.createElement('tbody');
        temp.innerHTML = trHtml;
        const aligns = this._computeAligns();
        const rows = Array.from(temp.querySelectorAll('tr'));

        rows.forEach(tr => {
            this._processRow(tr, aligns);
        });

        appendVirtualRows(this, rows, {
            scrollContainer: this.closest('.modal-window-content') || this.shadowRoot.querySelector('.dt-body'),
            rowHeight: 54
        });
    }

    clearRows() {
        disableVirtualRows(this);
        this.replaceChildren();
    }

    // ── Private ──────────────────────────────────────────────────────────────

    _processRow(tr, aligns) {
        if (tr.dataset.virtualSpacer) {
            return;
        }

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
                    if (attr.name.startsWith('data-') || attr.name.startsWith('aria-') || attr.name === 'title' || attr.name === 'disabled') {
                        actionBtn.setAttribute(attr.name, attr.value);
                    }
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
                    --_surface:    rgba(255,255,255,0.04);
                    --_surface-hd: rgba(32,32,32,0.96);
                    --_border:     var(--color-win-border,         rgba(255,255,255,0.08));
                    --_radius:     14px;
                    --_font:       var(--font-sans,                "Segoe UI", sans-serif);
                }

                .dt-container {
                    background: var(--_surface);
                    border: 1px solid var(--_border);
                    border-radius: var(--_radius);
                    overflow: hidden;
                    font-family: var(--_font);
                    color: rgba(255,255,255,0.9);
                    font-size: 13px;
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
                    display: grid;
                    grid-template-columns: var(--dt-columns, repeat(3, minmax(0, 1fr)));
                }

                .dt-th {
                    min-width: 0;
                    padding: 8px 14px;
                    font-weight: 600;
                    font-size: 11px;
                    letter-spacing: 0.02em;
                    color: rgba(255,255,255,0.4);
                    white-space: nowrap;
                }

                /* Body area — light DOM rows appear here via default slot */
                .dt-body {
                    overflow-y: auto;
                }

                ::slotted(tr.dt-row) {
                    display: grid;
                    grid-template-columns: var(--dt-columns, repeat(3, minmax(0, 1fr)));
                    border-bottom: 1px solid rgba(255,255,255,0.05);
                    transition: background-color 0.1s ease;
                }

                ::slotted(tr.dt-row:hover) {
                    background-color: rgba(255,255,255,0.035);
                }

                ::slotted(tr.dt-row:last-child) {
                    border-bottom: 0;
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
