import {$,api,brand,esc,i,icons} from './shared/core';

type Mode='customer'|'signup'|'admin';
export function showLogin(error=''){
  const requested=new URLSearchParams(location.search).get('auth');
  const mode:Mode=requested==='signup'||requested==='admin'?requested:'customer';
  const admin=mode==='admin';
  const hero=admin
    ?`<div><h1>Waypoint admin console</h1><p>Customers, GPS devices and server health in one place.</p></div>`
    :`<div><h1>Your trucks, live on the map.</h1><p>See where every vehicle is, how long it has been parked, and how far it went today.</p><div class="points"><span>${i('map-pin')}Live location with road and area name</span><span>${i('route')}Route history with playback</span><span>${i('chart-column')}Daily km, running and idle reports</span></div></div>`;
  const fields=`${mode==='signup'?'<label class="field">Business or your name<input class="input" name="name" maxlength="100" required autocomplete="organization"></label>':''}
    <label class="field">Email<input class="input" name="email" type="email" required autocomplete="username"></label>
    <label class="field">Password<input class="input" name="password" type="password" ${mode==='signup'?'minlength="12" maxlength="128" autocomplete="new-password"':'autocomplete="current-password"'} required></label>
    ${mode==='signup'?'<label class="field">Confirm password<input class="input" name="confirm" type="password" required autocomplete="new-password"></label><p class="hint">At least 12 characters.</p>':''}`;
  $('#app').innerHTML=`<div class="auth">
    <section class="auth-hero"><div class="road"></div>${brand()}${hero}<small style="opacity:.7">© Waypoint</small></section>
    <section class="auth-panel"><form class="auth-card form" id="login">
      ${admin?'<span class="chip neutral plain">Admin</span>':`<div class="switch"><a href="/?live=1&auth=customer" class="${mode==='customer'?'on':''}">Sign in</a><a href="/?live=1&auth=signup" class="${mode==='signup'?'on':''}">Create account</a></div>`}
      <div><h1>${admin?'Admin sign in':mode==='signup'?'Create your account':'Welcome back'}</h1><p class="muted">${admin?'Restricted to Waypoint administrators.':mode==='signup'?'Start tracking your fleet in minutes.':'Sign in to see your vehicles.'}</p></div>
      ${fields}
      <p class="error" role="alert">${esc(error)}</p>
      <button class="btn btn-primary btn-block" type="submit" id="login-submit">${mode==='signup'?'Create account':'Sign in'}${i('chevron-right')}</button>
      <p class="small muted" style="text-align:center">${admin?'<a href="/?live=1&auth=customer">Customer sign in</a>':'<a href="/?live=1&auth=admin">Admin sign in</a>'}</p>
    </form></section></div>`;
  $('#login').addEventListener('submit',async event=>{
    event.preventDefault();const button=$<HTMLButtonElement>('#login-submit');button.disabled=true;
    try{
      const data=new FormData(event.target as HTMLFormElement);
      if(mode==='signup'&&data.get('password')!==data.get('confirm'))throw Error('Passwords do not match.');
      await api(mode==='signup'?'/customers/register':mode==='customer'?'/customers/session':'/admin/session',{method:'POST',body:JSON.stringify({name:data.get('name'),email:data.get('email'),password:data.get('password')})});
      location.href='/?live=1';
    }catch(e){$('.auth-card .error').textContent=(e as Error).message;button.disabled=false}
  });
  icons();
}
