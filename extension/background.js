import {historyCutoff} from './policy.js';
import {ROOTS,httpURL,diff,applyAliases} from './model.js';
const DEFAULT='http://127.0.0.1:4317';
let running=null,applying=false,timer;
const uuid=()=>crypto.randomUUID();
const hash=async text=>'h_'+[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('');
const empty=()=>({bookmarkMap:{},groupMap:{},baseline:{},versions:{},cursor:0,removedHistory:[]});
async function api(config,path,body){
 const result=await fetch(config.server+path,{method:'POST',headers:{'Content-Type':'application/json',...(config.token?{'Authorization':'Bearer '+config.token}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 const data=await result.json();if(!result.ok)throw new Error(data.error||`站点返回 ${result.status}`);return data;
}
function rootsOf(tree){
 const roots=tree[0]?.children||[],map={};
 roots.forEach((r,i)=>{const key=({'bookmarks-bar':'toolbar',other:'other',mobile:'mobile'})[r.folderType]||ROOTS[i];if(key)map[key]=r.id;});
 return map;
}
async function collect(s,config){
 const current={},counts={bookmark:0,group:0,history:0,unsupported:0};
 const tree=await chrome.bookmarks.getTree(),roots=rootsOf(tree);
 for(const [logical,local] of Object.entries(roots))s.bookmarkMap[local]=logical;
 const walk=(nodes,parent)=>{for(let i=0;i<nodes.length;i++){
  const n=nodes[i];if(n.url&&!httpURL(n.url)){counts.unsupported++;continue;}
  const id=s.bookmarkMap[n.id]||(s.bookmarkMap[n.id]=uuid());
  if(ROOTS.includes(id)){walk(n.children||[],id);continue;}
  if(!parent)continue;
  const data={kind:n.url?'bookmark':'folder',title:n.title||'',parentId:parent,position:i};
  if(n.url){data.url=n.url;counts.bookmark++;}current[id]=data;
  if(n.children)walk(n.children,id);
 }};
 walk(tree[0]?.children||[],null);
 const capabilities={bookmarks:true,groups:Boolean(chrome.tabGroups?.query&&chrome.tabs?.group),history:Boolean(chrome.history?.search)};
 const liveGroups={};
 if(capabilities.groups){
  const groups=await chrome.tabGroups.query({});
  for(const g of groups){
   const tabs=(await chrome.tabs.query({groupId:g.id})).filter(t=>!t.incognito&&httpURL(t.url)).sort((a,b)=>a.index-b.index);
   if(!tabs.length)continue;
   const old=s.groupMap[g.id];
   // Reused numeric group IDs after a browser restart must not target an unrelated group.
   const shared=old?.tabIds?.some(id=>tabs.some(t=>t.id===id));
   const signature=JSON.stringify(tabs.map(t=>t.url));
   const id=old&&(shared||old.signature===signature)?old.id:uuid();
   liveGroups[g.id]={id,tabIds:tabs.map(t=>t.id),signature};
   current[id]={kind:'group',title:g.title||'未命名标签组',tabs:tabs.map(t=>({url:t.url,title:t.title||''})),color:g.color||'blue',collapsed:Boolean(g.collapsed)};counts.group++;
  }
  s.groupMap=liveGroups;
 }
 if(capabilities.history){
  const history=await chrome.history.search({text:'',startTime:historyCutoff(),maxResults:10000});
  for(const item of history){
   if(!httpURL(item.url)||item.url.startsWith(config.server)||(item.lastVisitTime||0)<historyCutoff())continue;
   const id=await hash(item.url);current[id]={kind:'history',title:item.title||item.url,url:item.url,lastVisitTime:item.lastVisitTime||Date.now(),visitCount:item.visitCount||1};counts.history++;
  }
 }
 // An unavailable category must not generate a deletion.
 for(const [id,item] of Object.entries(s.baseline))if((item.kind==='group'&&!capabilities.groups)||(item.kind==='history'&&!capabilities.history))current[id]=item;
 return {current,counts,capabilities,tree,roots};
}
async function safeGet(id){try{return (await chrome.bookmarks.get(id))[0];}catch{return null;}}
async function applyBookmarks(s,entities,roots){
 const live=entities.filter(e=>!e.deleted&&(e.kind==='bookmark'||e.kind==='folder'));
 const byId=Object.fromEntries(entities.map(e=>[e.id,e]));
 const reverse=Object.fromEntries(Object.entries(s.bookmarkMap).map(([local,id])=>[id,local]));
 Object.assign(reverse,roots);
 if(!reverse.mobile&&live.some(e=>e.parentId==='mobile')){
  const m=await chrome.bookmarks.create({parentId:roots.other||roots.toolbar,title:'移动设备书签 · 拾页'});reverse.mobile=m.id;s.bookmarkMap[m.id]='mobile';
 }
 const depth=e=>{let n=0,p=byId[e.parentId];const seen=new Set();while(p&&!seen.has(p.id)){seen.add(p.id);n++;p=byId[p.parentId];}return n;};
 live.sort((a,b)=>depth(a)-depth(b)||a.position-b.position);
 for(const e of live){
  if(ROOTS.includes(e.id))continue;
  const parentId=reverse[e.parentId];if(!parentId)throw new Error('缺少书签文件夹，请重新同步');
  let node=reverse[e.id]?await safeGet(reverse[e.id]):null;
  if(!node){node=await chrome.bookmarks.create({parentId,title:e.title,...(e.kind==='bookmark'?{url:e.url}:{})});reverse[e.id]=node.id;s.bookmarkMap[node.id]=e.id;}
  else{
   if(node.title!==e.title||(e.kind==='bookmark'&&node.url!==e.url))await chrome.bookmarks.update(node.id,{title:e.title,...(e.kind==='bookmark'?{url:e.url}:{})});
   if(node.parentId!==parentId)await chrome.bookmarks.move(node.id,{parentId});
  }
 }
 // Only adjust managed sibling order; keep unsupported local bookmarks in place.
 const parents=[...new Set(live.filter(e=>!ROOTS.includes(e.id)).map(e=>e.parentId))];
 for(const parent of parents){
  const desired=live.filter(e=>e.parentId===parent).sort((a,b)=>a.position-b.position||a.id.localeCompare(b.id));
  for(let index=0;index<desired.length;index++){
   const local=reverse[desired[index].id];const node=await safeGet(local);if(node&&node.index!==index)await chrome.bookmarks.move(local,{parentId:reverse[parent],index});
  }
 }
 const deleted=entities.filter(e=>e.deleted&&(e.kind==='bookmark'||e.kind==='folder')).sort((a,b)=>depth(b)-depth(a));
 for(const e of deleted){
  const local=reverse[e.id];if(!local||ROOTS.includes(e.id))continue;const node=await safeGet(local);if(!node)continue;
  if(node.url)await chrome.bookmarks.remove(local);
  else{
   const children=await chrome.bookmarks.getChildren(local);
   // Never remove a newly-added or unsupported bookmark inside a deleted folder.
   if(children.length)throw new Error(`文件夹“${node.title}”还有本机内容，已保留，请先移出后重试`);
   await chrome.bookmarks.remove(local);
  }
  delete s.bookmarkMap[local];
 }
}
async function applyGroups(s,entities){
 if(!chrome.tabGroups?.query)return;
 const groups=await chrome.tabGroups.query({}),existing=new Map(groups.map(g=>[String(g.id),g]));
 const reverse=Object.fromEntries(Object.entries(s.groupMap).map(([local,g])=>[g.id,local]));
 for(const e of entities.filter(e=>e.kind==='group')){
  let local=reverse[e.id];let group=local?existing.get(String(local)):null;
  if(e.deleted){if(group){const tabs=await chrome.tabs.query({groupId:group.id});if(tabs.length)await chrome.tabs.ungroup(tabs.map(t=>t.id));delete s.groupMap[local];}continue;}
  const already=s.versions[e.id]===e.version;
  if(already&&group)continue;
  let tabs=group?await chrome.tabs.query({groupId:group.id}):[];const unused=[...tabs],chosen=[];let windowId=group?.windowId;
  for(const desired of e.tabs){
   let index=unused.findIndex(t=>t.url===desired.url);let tab;
   if(index>=0)tab=unused.splice(index,1)[0];else tab=await chrome.tabs.create({url:desired.url,active:false,...(windowId?{windowId}:{})});windowId=tab.windowId;chosen.push(tab.id);
  }
  if(unused.length)await chrome.tabs.ungroup(unused.map(t=>t.id));
  if(chosen.length){
   // Chrome may dissolve a group when its last old tab is ungrouped.
   const first=Math.min(...(await Promise.all(chosen.map(id=>chrome.tabs.get(id)))).map(t=>t.index));
   await chrome.tabs.move(chosen,{index:first});
   const surviving=group&&(await chrome.tabGroups.query({})).find(g=>g.id===group.id);
   const groupId=await chrome.tabs.group({tabIds:chosen,...(surviving?{groupId:surviving.id}:{})});
   await chrome.tabGroups.update(groupId,{title:e.title,color:e.color,collapsed:e.collapsed});
   if(local&&String(groupId)!==String(local))delete s.groupMap[local];
   s.groupMap[groupId]={id:e.id,tabIds:chosen,signature:JSON.stringify(e.tabs.map(t=>t.url))};
   // Journal each completed write so a suspended worker does not duplicate it.
   await chrome.storage.local.set({syncState:s});
  }
 }
}
async function applyHistory(s,entities,current){
 if(!chrome.history?.addUrl)return;
 for(const e of entities.filter(e=>e.kind==='history'&&e.lastVisitTime>=historyCutoff())){
  if(e.deleted){if(s.versions[e.id]!==e.version||current[e.id])await chrome.history.deleteUrl({url:e.url});}
  else if(!current[e.id]&&s.versions[e.id]!==e.version){await chrome.history.addUrl({url:e.url});}
 }
}
async function doSync(){
 const {config,syncState}=await chrome.storage.local.get(['config','syncState']);if(!config?.token)return {ok:false,error:'请先配对本机站点'};
 const s=syncState||empty();
 try{
  const collected=await collect(s,config);
  let response=s.pending;
  if(!response){
   const changes=diff(collected.current,s.baseline,s.versions,s.removedHistory);
   // Persist ID assignments before the network call; retries reuse the same IDs.
   await chrome.storage.local.set({syncState:s});
   response=await api(config,'/api/sync',{cursor:s.cursor,changes,capabilities:collected.capabilities,counts:collected.counts});
   applyAliases(s.bookmarkMap,response.aliases);
   for(const g of Object.values(s.groupMap))g.id=response.aliases[g.id]??g.id;
   s.pending=response;
  }
  applying=true;
  // Save the pre-apply journal. A partially applied sync can resume safely.
  await chrome.storage.local.set({syncState:s});
  await applyBookmarks(s,response.entities,collected.roots);
  await chrome.storage.local.set({syncState:s});
  await applyGroups(s,response.entities);
  await applyHistory(s,response.entities,collected.current);
  const after=await collect(s,config);
  s.versions=Object.fromEntries(response.entities.map(e=>[e.id,e.version]));
  // Native data created during remote application still needs uploading.
  s.baseline=Object.fromEntries(Object.entries(after.current).filter(([id])=>Object.hasOwn(s.versions,id)));
  s.cursor=response.revision;s.removedHistory=[];delete s.pending;
  const status={ok:true,at:Date.now(),counts:after.counts,capabilities:after.capabilities,conflicts:response.conflicted};
  await chrome.storage.local.set({syncState:s,status});
  await api(config,'/api/sync/ack',{revision:s.cursor});
  await chrome.action.setBadgeText({text:response.conflicted?'!':''});await chrome.action.setBadgeBackgroundColor({color:'#B26B2B'});
  return status;
 }catch(e){
  // A caught failure will fetch a fresh server snapshot next time.
  // Mappings from completed writes remain journaled for safe retries.
  delete s.pending;await chrome.storage.local.set({syncState:s});
  const error=e.name==='TimeoutError'?'站点连接超时，请确认本机站点已启动':e.message==='Failed to fetch'?'连接不到站点，请启动拾页后重试':e.message;
  await chrome.storage.local.set({status:{ok:false,error,at:Date.now()}});await chrome.action.setBadgeText({text:'!'});
  try{await api(config,'/api/device/error',{error});}catch{}
  return {ok:false,error};
 }finally{applying=false;}
}
function run(){if(!running)running=doSync().finally(()=>{running=null;});return running;}
function schedule(delay=2500){if(applying)return;clearTimeout(timer);timer=setTimeout(()=>void run(),delay);}
chrome.runtime.onInstalled.addListener(async()=>{await chrome.alarms.create('sync',{periodInMinutes:1});await chrome.runtime.openOptionsPage();});
chrome.runtime.onStartup.addListener(async()=>{await chrome.alarms.create('sync',{periodInMinutes:1});void run();});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='sync')void run();});
chrome.action.onClicked.addListener(()=>chrome.runtime.openOptionsPage());
for(const key of ['onCreated','onRemoved','onChanged','onMoved','onChildrenReordered'])chrome.bookmarks[key]?.addListener(()=>schedule());
for(const key of ['onCreated','onUpdated','onRemoved','onMoved'])chrome.tabGroups?.[key]?.addListener(()=>schedule());
chrome.tabs.onUpdated.addListener((_id,info)=>{if(info.url||info.title)schedule(10000);});
chrome.tabs.onRemoved.addListener(()=>schedule());
chrome.tabs.onMoved.addListener(()=>schedule());
chrome.history.onVisited.addListener(()=>schedule(20000));
chrome.history.onVisitRemoved.addListener(async removed=>{
 if(applying)return;
 const {syncState}=await chrome.storage.local.get('syncState');const s=syncState||empty();
 const ids=removed.allHistory?Object.entries(s.baseline).filter(([,v])=>v.kind==='history').map(([id])=>id):await Promise.all((removed.urls||[]).map(hash));
 s.removedHistory=[...new Set([...(s.removedHistory||[]),...ids])];await chrome.storage.local.set({syncState:s});schedule();
});
chrome.runtime.onMessage.addListener((message,_sender,respond)=>{
 if(message.type==='sync'){run().then(respond);return true;}
 if(message.type==='pair'){
  (async()=>{
   if(running)await running;
   const server=new URL(message.server||DEFAULT);
   if(!((['127.0.0.1','localhost'].includes(server.hostname)&&server.protocol==='http:')||server.origin==='https://wo.bohanrich.com')||server.pathname!=='/'||server.username||server.password||server.search||server.hash)throw new Error('请填写 https://wo.bohanrich.com 或本机站点地址');
   const config={server:server.origin,name:String(message.name||'浏览器').slice(0,100)};
   const previous=await chrome.storage.local.get(['originalBackup','config']);
   if(previous.config?.server&&previous.config.server!==config.server)throw new Error('请先解除旧站点配对');
   const paired=await api(config,'/api/devices/register',{name:config.name,code:message.code,password:message.password});
   if(!previous.originalBackup)await chrome.storage.local.set({originalBackup:{at:new Date().toISOString(),bookmarks:await chrome.bookmarks.getTree(),groups:chrome.tabGroups?.query?await chrome.tabGroups.query({}):[]}});
   await chrome.storage.local.set({config:{...config,...paired}});
   await chrome.alarms.create('sync',{periodInMinutes:1});return await run();
  })().then(respond,e=>respond({ok:false,error:e.message}));return true;
 }
 if(message.type==='migrate-cloud'){
  (async()=>{if(running)await running;const {config}=await chrome.storage.local.get('config');if(!config?.token)throw new Error('请先配对浏览器');
   const server='https://wo.bohanrich.com';const response=await fetch(server+'/api/device/status',{headers:{Authorization:'Bearer '+config.token},signal:AbortSignal.timeout(15000)});const data=await response.json();if(!response.ok||data.deviceId!==config.deviceId)throw new Error('云端未找到此设备，请在云端生成配对码重新连接');
   await chrome.storage.local.set({config:{...config,server}});return await run();
  })().then(respond,e=>respond({ok:false,error:e.message}));return true;
 }
 if(message.type==='disconnect'){
  (async()=>{if(running)await running;await chrome.storage.local.remove('config');await chrome.action.setBadgeText({text:''});return {ok:true};})().then(respond);return true;
 }
});

export {collect,doSync,applyBookmarks,applyGroups,applyHistory};
