import {type Vehicle} from './core';
import {markerHtml} from './map';

// Google view with our trucks on top. Google's keyless embed cannot carry markers, so the frame is
// locked (no dragging) at a known centre and zoom; with Google's standard Web Mercator projection we
// then know exactly where every point is on screen and draw the trucks and trail over it. The frame
// moves only when the followed truck nears the edge or the zoom changes, and the new frame loads
// behind the old one so the view never goes blank.
type P={latitude:number;longitude:number};
export const googleLiveUrl=(p:P,zoom:number)=>`https://maps.google.com/maps?${new URLSearchParams({ll:`${p.latitude.toFixed(6)},${p.longitude.toFixed(6)}`,z:String(zoom),hl:'en',output:'embed'})}`;
function world(p:P,z:number){
  const size=256*2**z,sin=Math.min(Math.max(Math.sin(p.latitude*Math.PI/180),-0.9999),0.9999);
  return {x:(p.longitude+180)/360*size,y:(0.5-Math.log((1+sin)/(1-sin))/(4*Math.PI))*size};
}

function unworld(x:number,y:number,z:number):P{
  const size=256*2**z,n=Math.PI-2*Math.PI*y/size;
  return {latitude:180/Math.PI*Math.atan(Math.sinh(n)),longitude:x/size*360-180};
}

export type GoogleLive={update(vehicles:Vehicle[],selected:string,trail?:P[]):void;destroy():void};
// covered(): pixels hidden at the bottom (the vehicle card on phones); the truck is kept above them.
export function googleLive(host:HTMLElement,{onSelect,zoom=17,covered=()=>0}:{onSelect?:(id:string)=>void;zoom?:number;covered?:()=>number}={}):GoogleLive{
  host.classList.add('gl');
  host.insertAdjacentHTML('beforeend',`<div class="gl-frames"><iframe title="Google map" class="on" referrerpolicy="no-referrer-when-downgrade"></iframe><iframe title="Google map" referrerpolicy="no-referrer-when-downgrade"></iframe></div>
    <svg class="gl-trail" aria-hidden="true"><polyline/></svg><div class="gl-marks"></div>
    <div class="gl-zoom"><button type="button" data-gz="1" aria-label="Zoom in">+</button><button type="button" data-gz="-1" aria-label="Zoom out">−</button></div>`);
  const frames=[...host.querySelectorAll<HTMLIFrameElement>('.gl-frames iframe')],marks=host.querySelector<HTMLElement>('.gl-marks')!,line=host.querySelector('polyline')!;
  // z is the zoom asked for; shown is the zoom of the frame on screen, which the overlay must use.
  let front=0,center:P|null=null,z=zoom,shown=zoom,lastLoad=0,loading=false,followed='';
  let state:{vehicles:Vehicle[];selected:string;trail:P[]}={vehicles:[],selected:'',trail:[]};
  const pins=new Map<string,HTMLElement>();

  const load=(c:P)=>{
    const back=frames[1-front],ask=c,zoomAsked=z;lastLoad=Date.now();loading=true;
    back.onload=()=>setTimeout(()=>{
      if(back.src!==googleLiveUrl(ask,zoomAsked))return;   // a newer request replaced this one
      host.classList.add('gl-snap');back.classList.add('on');frames[front].classList.remove('on');front=1-front;center=ask;shown=zoomAsked;loading=false;draw();requestAnimationFrame(()=>requestAnimationFrame(()=>host.classList.remove('gl-snap')));
    },600);
    back.src=googleLiveUrl(ask,zoomAsked);
    if(!center){frames[front].src=back.src;center=ask;shown=zoomAsked}
  };
  // Frame centre that puts point p in the middle of the part of the view that is not covered.
  const centreFor=(p:P)=>{const q=world(p,z),lift=Math.min(covered(),host.clientHeight*0.7)/2;return unworld(q.x,q.y+lift,z)};
  const target=()=>state.vehicles.find(v=>v.id===state.selected&&v.position)||state.vehicles.find(v=>v.position);
  function draw(){
    if(!center)return;
    const w=host.clientWidth,h=host.clientHeight,c=world(center,shown),seen=new Set<string>();
    const at=(p:P)=>{const q=world(p,shown);return {x:w/2+q.x-c.x,y:h/2+q.y-c.y}};
    for(const v of state.vehicles){
      if(!v.position)continue;
      const {x,y}=at(v.position);
      if(x<-60||y<-60||x>w+60||y>h+60)continue;
      seen.add(v.id);const on=v.id===state.selected;
      let pin=pins.get(v.id);
      if(!pin){pin=document.createElement('div');pin.className='gl-mark';pin.addEventListener('click',()=>onSelect?.(v.id));marks.append(pin);pins.set(v.id,pin)}
      pin.innerHTML=markerHtml(v,on,on||state.vehicles.length<=3);
      pin.style.transform=`translate(${x-20}px,${y-20}px)`;pin.style.zIndex=on?'2':'1';
    }
    for(const [id,pin] of pins)if(!seen.has(id)){pin.remove();pins.delete(id)}
    line.setAttribute('points',state.trail.map(p=>{const {x,y}=at(p);return `${x.toFixed(1)},${y.toFixed(1)}`}).join(' '));
  }
  function follow(){
    const t=target();if(!t?.position)return;
    if(!center||t.id!==followed){followed=t.id;load(centreFor(t.position));draw();return}
    if(loading)return;
    const w=host.clientWidth,h=host.clientHeight-Math.min(covered(),host.clientHeight*0.7),c=world(centreFor(t.position),shown),now=world(center,shown);
    // Re-centre once the truck has drifted into the outer part of the open view (at most every 3 s).
    if((Math.abs(c.x-now.x)>w*0.3||Math.abs(c.y-now.y)>h*0.3)&&Date.now()-lastLoad>3000)load(centreFor(t.position));
  }
  host.querySelectorAll<HTMLButtonElement>('[data-gz]').forEach(b=>b.addEventListener('click',()=>{
    const next=Math.min(20,Math.max(5,z+Number(b.dataset.gz)));if(next===z)return;
    z=next;const t=target();if(t?.position||center)load(t?.position?centreFor(t.position):center!);
  }));
  const resize=new ResizeObserver(()=>draw());resize.observe(host);
  return {
    update(vehicles,selected,trail=[]){state={vehicles,selected,trail};follow();draw()},
    destroy(){resize.disconnect();host.classList.remove('gl');host.querySelectorAll('.gl-frames,.gl-trail,.gl-marks,.gl-zoom').forEach(e=>e.remove())},
  };
}
