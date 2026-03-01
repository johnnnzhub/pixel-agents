import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
	test: {
		include: ['src/__tests__/**/*.test.ts'],
		alias: {
			vscode: path.resolve(__dirname, 'src/__tests__/__mocks__/vscode.ts'),
		},
	},
});
