import type {CapacitorConfig} from '@capacitor/cli';

// The UI is bundled in the APK (dist-app, built with `vite build --mode app`); only API calls leave the
// phone. CapacitorHttp routes fetch() through Android's native HTTP stack and CapacitorCookies keeps the
// session cookie in the system cookie store, so the server needs no CORS or SameSite changes.
const config:CapacitorConfig={
  appId:'com.waypoint.fleet',
  appName:'Waypoint',
  webDir:'dist-app',
  android:{allowMixedContent:false},
  plugins:{
    CapacitorHttp:{enabled:true},
    CapacitorCookies:{enabled:true},
  },
};
export default config;
