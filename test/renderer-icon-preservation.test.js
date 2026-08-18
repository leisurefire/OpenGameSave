const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

test('translation refresh preserves icon children in action buttons', () => {
    const utilitySource = fs.readFileSync(
        path.join(PROJECT_ROOT, 'src', 'renderer', 'js', 'utility.js'),
        'utf8'
    );
    const tableUiSource = fs.readFileSync(
        path.join(PROJECT_ROOT, 'src', 'renderer', 'js', 'tableUi.js'),
        'utf8'
    );

    assert.doesNotMatch(
        utilitySource,
        /el\.tagName\s*===\s*['"]BUTTON['"][\s\S]{0,120}el\.innerText\s*=/,
        'translation must not replace all button children'
    );
    assert.match(
        tableUiSource,
        /text\.setAttribute\(['"]data-i18n['"],\s*i18nKey\)/,
        'dynamic action labels should attach translation metadata to their text node'
    );
    assert.doesNotMatch(
        tableUiSource,
        /button\.setAttribute\(['"]data-i18n['"],\s*i18nKey\)/,
        'dynamic action buttons must not attach translation metadata to the icon-bearing button'
    );
});
