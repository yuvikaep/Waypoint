import {defineConfig} from 'vite';
export default defineConfig({server:{proxy:{'/api':{target:'http://127.0.0.1:5174',changeOrigin:true}}}});
