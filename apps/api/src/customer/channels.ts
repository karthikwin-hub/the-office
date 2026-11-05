import { CS_AGENT, type Inbound, type IncomingMessage } from "@office/engine";

export { CS_AGENT };

/** Customers write here; the address alone says which office. */
export const supportAddress = (slug: string, domain: string | undefined) => (slug && domain ? `${slug}.help@${domain}`.toLowerCase() : null);

export type SupportMail = { from: string; name: string | null; subject: string; text: string; messageId: string | null; inReplyTo: string | null };
export type ChatPostBody = { visitor: string; text: string; name: string | null };

/**
 * A WhatsApp message to the office's own number from someone outside the office is a customer while the
 * Customer Service agent is on the team; it goes to the agent and not to the social inbox.
 */
export function splitCustomerDms(raws: IncomingMessage[], hired: boolean): { customers: Inbound[]; rest: IncomingMessage[] } {
  if (!hired) return { customers: [], rest: raws };
  const customers: Inbound[] = [];
  const rest: IncomingMessage[] = [];
  for (const m of raws) {
    if (m.platform === "WhatsApp" && m.kind === "dm" && m.threadId) customers.push({ channel: "whatsapp", key: m.threadId, name: m.author, text: m.text, externalId: m.externalId ?? undefined, at: m.at });
    else rest.push(m);
  }
  return { customers, rest };
}

/** The new part of an email reply: everything above the quoted message and the signature. */
export function freshText(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) break;
    if (/^On .{4,120} wrote:\s*$/i.test(l.trim()) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l.trim()) || /^From:\s.+/i.test(l.trim()) || /^--\s*$/.test(l) || /^Sent from my /i.test(l.trim())) break;
    out.push(l);
  }
  return out.join("\n").trim().slice(0, 4000);
}

export const toSupportInbound = (m: SupportMail): Inbound => ({
  channel: "email",
  key: m.from.trim().toLowerCase(),
  name: m.name || m.from,
  text: freshText(m.text) || m.subject,
  subject: m.subject || undefined,
  externalId: m.messageId ?? undefined,
  inReplyTo: m.inReplyTo ?? undefined,
});

/** Cloudflare Turnstile, only when a secret is set. Without it the rate limit is the only guard. */
export async function turnstileOk(secret: string | undefined, token: string | null | undefined, ip: string | null, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!secret) return true;
  if (!token) return false;
  const form = new FormData();
  form.set("secret", secret);
  form.set("response", token);
  if (ip) form.set("remoteip", ip);
  const r = await fetcher("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form }).catch(() => null);
  if (!r?.ok) return false;
  return Boolean(((await r.json()) as { success?: boolean }).success);
}

/**
 * The chat bubble a business pastes on its website. Plain JavaScript with no dependencies; it keeps a
 * random visitor id in the browser and asks for new replies every few seconds while it is open.
 */
export function widgetScript(key: string, origin: string, siteKey: string | null): string {
  const cfg = JSON.stringify({ key, origin, siteKey });
  return `(function(){
var C=${cfg};if(window.__officeChat)return;window.__officeChat=1;
var V=localStorage.getItem("office-chat-visitor");if(!V){V=Array.from(crypto.getRandomValues(new Uint8Array(16)),function(b){return b.toString(16).padStart(2,"0")}).join("");localStorage.setItem("office-chat-visitor",V)}
var api=C.origin+"/api/chat/"+C.key,open=false,timer=null,token=null,seen=0;
var css="#oc-b{position:fixed;right:20px;bottom:20px;z-index:2147483000;border:0;border-radius:28px;padding:14px 18px;background:#1f3a5f;color:#fff;font:600 15px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.2);cursor:pointer}#oc-p{position:fixed;right:20px;bottom:80px;z-index:2147483000;width:min(360px,calc(100vw - 40px));height:min(520px,calc(100vh - 120px));display:none;flex-direction:column;background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.25);font:14px/1.45 system-ui,sans-serif;color:#1a1a1a;overflow:hidden}#oc-p header{padding:12px 14px;background:#1f3a5f;color:#fff}#oc-p header small{display:block;opacity:.85;font-size:12px}#oc-l{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:8px}.oc-m{max-width:85%;padding:8px 11px;border-radius:10px;white-space:pre-wrap;word-wrap:break-word}.oc-you{align-self:flex-end;background:#e8eef6}.oc-us{align-self:flex-start;background:#f2f2f2}#oc-f{display:flex;gap:6px;padding:10px;border-top:1px solid #eee}#oc-t{flex:1;resize:none;border:1px solid #ccc;border-radius:8px;padding:8px;font:inherit}#oc-s{border:0;border-radius:8px;background:#1f3a5f;color:#fff;padding:0 14px;font:600 14px system-ui,sans-serif;cursor:pointer}";
var st=document.createElement("style");st.textContent=css;document.head.appendChild(st);
var b=document.createElement("button");b.id="oc-b";b.type="button";b.textContent="Chat with us";
var p=document.createElement("div");p.id="oc-p";p.setAttribute("role","dialog");p.setAttribute("aria-label","Chat");
p.innerHTML='<header><strong id="oc-n">Chat with us</strong><small>Answers come from an AI assistant. Ask for a person at any time.</small></header><div id="oc-l" aria-live="polite"></div><div id="oc-w"></div><form id="oc-f"><textarea id="oc-t" rows="2" maxlength="2000" placeholder="Type your message" aria-label="Your message"></textarea><button id="oc-s" type="submit">Send</button></form>';
document.body.appendChild(b);document.body.appendChild(p);
var L=p.querySelector("#oc-l"),T=p.querySelector("#oc-t");
function draw(r){if(r.business)p.querySelector("#oc-n").textContent=r.business;var ms=r.messages||[];if(ms.length===seen)return;seen=ms.length;L.innerHTML="";ms.forEach(function(m){var d=document.createElement("div");d.className="oc-m oc-"+m.from;d.textContent=m.text;L.appendChild(d)});L.scrollTop=L.scrollHeight}
function poll(){fetch(api+"?visitor="+V).then(function(r){return r.ok?r.json():null}).then(function(r){if(r)draw(r)}).catch(function(){})}
function turnstile(){if(!C.siteKey||window.turnstile)return render();var s=document.createElement("script");s.src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";s.onload=render;document.head.appendChild(s)}
function render(){if(!C.siteKey||!window.turnstile)return;window.turnstile.render(p.querySelector("#oc-w"),{sitekey:C.siteKey,size:"flexible",callback:function(t){token=t}})}
b.onclick=function(){open=!open;p.style.display=open?"flex":"none";if(open){poll();turnstile();timer=setInterval(poll,5000);T.focus()}else clearInterval(timer)};
p.querySelector("#oc-f").onsubmit=function(e){e.preventDefault();var t=T.value.trim();if(!t)return;T.value="";var d=document.createElement("div");d.className="oc-m oc-you";d.textContent=t;L.appendChild(d);L.scrollTop=L.scrollHeight;
fetch(api,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({visitor:V,text:t,turnstile:token})}).then(function(r){return r.json().then(function(j){if(!r.ok){var d=document.createElement("div");d.className="oc-m oc-us";d.textContent=j.error||"That did not go through. Try again in a minute.";L.appendChild(d);return}seen=0;draw(j)})}).catch(function(){});
if(window.turnstile&&C.siteKey){token=null;window.turnstile.reset()}};
T.onkeydown=function(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();p.querySelector("#oc-f").requestSubmit()}};
})();`;
}
