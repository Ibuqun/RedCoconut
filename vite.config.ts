import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

export default defineConfig({
  base: '/RedCoconut/',
  plugins: [react()],
  server: {
    port: 8080,
  },
})
