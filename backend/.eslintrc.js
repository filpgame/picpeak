module.exports = {
  env: {
    browser: false,
    es2021: true,
    node: true,
    jest: true
  },
  extends: [
    'eslint:recommended'
  ],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module'
  },
  rules: {
    'indent': ['error', 2],
    'linebreak-style': ['error', 'unix'],
    'quotes': ['error', 'single'],
    'semi': ['error', 'always'],
    'no-unused-vars': ['warn', { 'argsIgnorePattern': '^_' }],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'no-empty': 'warn',
    'no-undef': 'warn',
    'no-useless-escape': 'warn',
    'no-case-declarations': 'warn',
    'no-inner-declarations': 'warn',
    'no-control-regex': 'warn',
    'no-useless-catch': 'warn'
  }
};
