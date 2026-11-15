import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{ ignores: ['node_modules/', '.millennium/', '.millennium-build/', 'dist/', 'build/'] },
	js.configs.recommended,
	...tseslint.configs.strictTypeChecked,
	{
		languageOptions: {
			parserOptions: {
				project: ['./frontend/tsconfig.json', './webview/tsconfig.json', './tests/tsconfig.json', './scripts/tsconfig.json'],
				tsconfigRootDir: import.meta.dirname,
			},
		},
		plugins: { 'react-hooks': reactHooks },
		rules: {
			...reactHooks.configs.recommended.rules,
			// Steam values must be narrowed from `unknown`, never asserted with `!`.
			'@typescript-eslint/no-non-null-assertion': 'error',
			'@typescript-eslint/consistent-type-imports': 'error',
		},
	},
	{
		files: ['eslint.config.js'],
		...tseslint.configs.disableTypeChecked,
	},
);
