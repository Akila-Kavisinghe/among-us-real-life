import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [react()],
	server: {
		proxy: {
			// Proxy Socket.IO websocket and polling to the Node server
			'/socket.io': {
				target: 'http://localhost:4046',
				changeOrigin: true,
				ws: true
			},
			// Proxy static assets served by Express during dev
			'/sounds': {
				target: 'http://localhost:4046',
				changeOrigin: true
			},
			'/images': {
				target: 'http://localhost:4046',
				changeOrigin: true
			}
		}
	}
});
