const $=id=>document.getElementById(id);
let config;
async function load(){
 const data=await chrome.storage.local.get(['config','status']);config=data.config;
 $('pair').hidden=Boolean(config?.token);$('connected').hidden=!config?.token;$('heading').textContent=config?.token?'这个浏览器已连接':'连接拾页站点';
 $('migrateCloud').hidden=!config?.token||config.server==='https://wo.bohanrich.com';
 if(config){$('server').value=config.server;$('name').value=config.name;$('device').textContent=config.name+' · '+config.server;}
 else if(!$('name').value)$('name').value='我的浏览器';
 if(data.status){const s=data.status;$('status').textContent=s.ok?`最近同步：${new Date(s.at).toLocaleString('zh-CN')} · ${s.counts?.bookmark||0} 个书签 / ${s.counts?.group||0} 个标签组 / ${s.counts?.history||0} 条历史${s.conflicts?' · 有冲突待处理':''}`:s.error;}
}
$('pair').addEventListener('submit',async event=>{
 event.preventDefault();$('error').textContent='';$('pairBtn').disabled=true;$('pairBtn').textContent='正在配对和同步…';
 try{const result=await chrome.runtime.sendMessage({type:'pair',server:$('server').value.trim(),name:$('name').value.trim(),code:$('code').value.trim(),password:$('password').value});if(!result?.ok)throw new Error(result?.error||'配对失败');$('code').value='';await load();}catch(e){$('error').textContent=e.message;await load();}finally{$('password').value='';$('pairBtn').disabled=false;$('pairBtn').textContent='配对并同步';}
});
$('sync').addEventListener('click',async()=>{$('sync').disabled=true;$('error').textContent='';try{const result=await chrome.runtime.sendMessage({type:'sync'});if(!result?.ok)throw new Error(result?.error||'同步失败');await load();}catch(e){$('error').textContent=e.message;}finally{$('sync').disabled=false;}});
$('open').addEventListener('click',()=>chrome.tabs.create({url:config?.server||'http://127.0.0.1:4317'}));
$('disconnect').addEventListener('click',async()=>{await chrome.runtime.sendMessage({type:'disconnect'});await load();});
$('backup').addEventListener('click',async()=>{
 const {originalBackup}=await chrome.storage.local.get('originalBackup');if(!originalBackup){$('error').textContent='首次配对后会自动保存书签备份。';return;}
 const esc=value=>String(value||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const render=nodes=>nodes.map((n,i)=>n.url?`<DT><A HREF="${esc(n.url)}">${esc(n.title)}</A>`:`<DT><H3${n.folderType==='bookmarks-bar'?' PERSONAL_TOOLBAR_FOLDER="true"':''}>${esc(n.title)}</H3><DL><p>${render(n.children||[])}</DL><p>`).join('\n');
 const html='<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>拾页原始书签备份</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>'+render(originalBackup.bookmarks[0]?.children||[])+'</DL><p>';
 const blob=new Blob([html],{type:'text/html;charset=utf-8'}),url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='shiye-original-bookmarks.html';a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);
});
chrome.storage.onChanged.addListener((_changes,area)=>{if(area==='local')void load();});
load().catch(e=>{$('error').textContent=e.message;});

$('homepage').addEventListener('click',()=>chrome.tabs.create({url:'https://wo.bohanrich.com/'}));

$('migrateCloud').addEventListener('click',async()=>{$('migrateCloud').disabled=true;try{const result=await chrome.runtime.sendMessage({type:'migrate-cloud'});if(!result?.ok)throw new Error(result?.error||'迁移失败');await load();}catch(e){$('error').textContent=e.message;}finally{$('migrateCloud').disabled=false;}});

function passwordRequirement(){try{$('password').required=new URL($('server').value).protocol==='https:';}catch{$('password').required=true;}}
$('server').addEventListener('input',passwordRequirement);passwordRequirement();
