import {App} from '@capacitor/app';
import {StatusBar,Style} from '@capacitor/status-bar';

// Android app only: the hardware back button closes an open dialog first, then walks the app's own
// history (customer and admin screens use pushState), and leaves the app from the first screen.
export async function startNative(){
  await App.addListener('backButton',({canGoBack})=>{
    const dialog=document.querySelector<HTMLDialogElement>('dialog[open]');
    if(dialog){dialog.close();return}
    if(canGoBack)history.back();else void App.exitApp();
  });
  // Style.Dark means light status-bar icons, for the blue bar.
  await StatusBar.setStyle({style:Style.Dark}).catch(()=>{});
  await StatusBar.setBackgroundColor({color:'#1463ff'}).catch(()=>{});
}
