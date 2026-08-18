const globals = require('globals');

const correctnessRules = {
    'constructor-super': 'error',
    'for-direction': 'error',
    'getter-return': 'error',
    'no-async-promise-executor': 'error',
    'no-class-assign': 'error',
    'no-compare-neg-zero': 'error',
    'no-cond-assign': 'error',
    'no-const-assign': 'error',
    'no-constant-binary-expression': 'error',
    'no-control-regex': 'error',
    'no-debugger': 'error',
    'no-dupe-args': 'error',
    'no-dupe-class-members': 'error',
    'no-dupe-else-if': 'error',
    'no-dupe-keys': 'error',
    'no-duplicate-case': 'error',
    'no-empty-character-class': 'error',
    'no-empty-pattern': 'error',
    'no-ex-assign': 'error',
    'no-fallthrough': 'error',
    'no-func-assign': 'error',
    'no-import-assign': 'error',
    'no-invalid-regexp': 'error',
    'no-irregular-whitespace': 'error',
    'no-loss-of-precision': 'error',
    'no-new-native-nonconstructor': 'error',
    'no-obj-calls': 'error',
    'no-promise-executor-return': 'error',
    'no-prototype-builtins': 'error',
    'no-redeclare': 'error',
    'no-self-assign': 'error',
    'no-setter-return': 'error',
    'no-shadow-restricted-names': 'error',
    'no-sparse-arrays': 'error',
    'no-this-before-super': 'error',
    'no-undef': 'error',
    'no-unexpected-multiline': 'error',
    'no-unreachable': 'error',
    'no-unreachable-loop': 'error',
    'no-unsafe-finally': 'error',
    'no-unsafe-negation': 'error',
    'no-unused-labels': 'error',
    'no-unused-private-class-members': 'error',
    'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none', ignoreRestSiblings: true }],
    'no-useless-backreference': 'error',
    'no-useless-catch': 'error',
    'no-useless-escape': 'error',
    'no-with': 'error',
    'require-yield': 'error',
    'use-isnan': 'error',
    'valid-typeof': 'error'
};

const styleRules = {
    'array-bracket-spacing': ['error', 'never'],
    'block-spacing': ['error', 'always'],
    'brace-style': ['error', '1tbs', { allowSingleLine: true }],
    'comma-dangle': ['error', 'never'],
    'comma-spacing': ['error', { before: false, after: true }],
    'computed-property-spacing': ['error', 'never'],
    'eol-last': ['error', 'always'],
    'func-call-spacing': ['error', 'never'],
    'indent': ['error', 4, { SwitchCase: 1, ignoredNodes: ['ConditionalExpression *'] }],
    'keyword-spacing': ['error', { before: true, after: true }],
    'no-multi-spaces': 'error',
    'no-trailing-spaces': 'error',
    'object-curly-spacing': ['error', 'always'],
    'quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
    'semi': ['error', 'always'],
    'semi-spacing': ['error', { before: false, after: true }],
    'space-before-blocks': 'error',
    'space-infix-ops': 'error'
};

module.exports = [
    {
        ignores: ['dist/**', 'node_modules/**', 'src/renderer/tailwind-output.css']
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            globals: { ...globals.node, ...globals.es2022 },
            sourceType: 'commonjs'
        },
        rules: {
            ...correctnessRules,
            ...styleRules,
            complexity: ['error', 50],
            'max-depth': ['error', 7],
            'max-lines': ['error', { max: 900, skipBlankLines: true, skipComments: true }],
            'max-lines-per-function': ['error', { max: 240, skipBlankLines: true, skipComments: true }],
            'max-params': ['error', 8]
        }
    },
    {
        files: ['src/renderer/**/*.js'],
        languageOptions: {
            globals: { ...globals.browser },
            sourceType: 'module'
        }
    },
    {
        files: ['src/preload/**/*.js'],
        languageOptions: { globals: { ...globals.browser } }
    },
    {
        files: ['src/main/main.js'],
        rules: { 'max-lines': ['error', { max: 350, skipBlankLines: true, skipComments: true }] }
    },
    {
        files: ['src/main/global.js', 'src/main/backupWorker.js'],
        rules: { 'max-lines': ['error', { max: 100, skipBlankLines: true, skipComments: true }] }
    }
];
