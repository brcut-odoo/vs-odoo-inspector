import tseslint from 'typescript-eslint';

export default tseslint.config(
	{ ignores: ['dist/**', 'out/**', 'node_modules/**'] },
	...tseslint.configs.recommended,
	{
		// Build glue (esbuild.js, scripts/*.js) is plain CommonJS run by Node.
		files: ['**/*.js'],
		languageOptions: {
			sourceType: 'commonjs',
			globals: { require: 'readonly', module: 'writable', process: 'readonly', console: 'readonly', __dirname: 'readonly' },
		},
		rules: { '@typescript-eslint/no-require-imports': 'off' },
	},
	{
		files: ['src/**/*.ts', 'scripts/**/*.ts'],
		languageOptions: {
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
		},
		rules: {
			// Tool handlers and the view are async-heavy: an unhandled promise is a lost error.
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
			curly: 'error',
			eqeqeq: ['error', 'always'],
			'no-throw-literal': 'error',
			'prefer-const': 'error',
		},
	},
);
