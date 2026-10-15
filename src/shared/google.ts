import {modal} from './core';

// Google's own map with all of its places (dhabas, temples, petrol pumps...), shown through the plain
// keyless Google Maps embed. No API key, account or quota is involved. Our truck and route cannot
// be drawn inside Google's frame; Google's red pin marks the point.
export const googleEmbedUrl=(lat:number,lon:number,zoom=17)=>`https://maps.google.com/maps?${new URLSearchParams({q:`${lat.toFixed(6)},${lon.toFixed(6)}`,z:String(zoom),hl:'en',output:'embed'})}`;

const metres=(a:{lat:number;lon:number},b:{lat:number;lon:number})=>{const r=Math.PI/180,x=(b.lon-a.lon)*r*Math.cos((a.lat+b.lat)/2*r),y=(b.lat-a.lat)*r;return Math.hypot(x,y)*6371000};

// A frame that follows a vehicle without reloading on every refresh: it moves only after the vehicle
// has gone 150 m, and at most once every 15 seconds, because each move reloads Google's page.
export function googleFrame(host:HTMLElement){
  const frame=document.createElement('iframe');
  frame.className='gframe';frame.title='Google map';frame.referrerPolicy='no-referrer-when-downgrade';frame.allowFullscreen=true;
  host.append(frame);
  let last:{lat:number;lon:number}|null=null,at=0;
  return {
    frame,
    show(lat:number,lon:number,force=false){
      const here={lat,lon};
      if(!force&&last&&(metres(last,here)<150||Date.now()-at<15000))return;
      frame.src=googleEmbedUrl(lat,lon);last=here;at=Date.now();
    },
  };
}

export function googleModal(title:string,lat:number,lon:number){
  modal(title,`<div class="gmodal" id="gmodal"></div><p class="hint">Google map with nearby places. The red pin is the vehicle's point.</p>`,{wide:true});
  googleFrame(document.querySelector<HTMLElement>('#gmodal')!).show(lat,lon,true);
}
