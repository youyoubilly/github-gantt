import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
    base: './',
    resolve: {
        alias: {
            'frappe-gantt': resolve(__dirname, '../gantt/src/index.js'),
        },
    },
});
