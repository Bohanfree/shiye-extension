export const ROOTS=['toolbar','other','mobile'];
export function httpURL(url){try{return ['http:','https:'].includes(new URL(url).protocol);}catch{return false;}}
export function stable(data){const d={...data};if(d.kind==='group')d.tabs=d.tabs.map(t=>({url:t.url,title:t.title||''}));return JSON.stringify(d);}
export function diff(current,baseline,versions,removedHistory=[]){
 const changes=[];
 for(const [id,data] of Object.entries(current))if(!ROOTS.includes(id)&&(!baseline[id]||stable(data)!==stable(baseline[id])))changes.push({id,op:'put',baseVersion:versions[id]??0,data});
 for(const [id,data] of Object.entries(baseline))if(!ROOTS.includes(id)&&data.kind!=='history'&&!current[id])changes.push({id,op:'delete',baseVersion:versions[id]??0});
 for(const id of new Set(removedHistory))if(versions[id]!==undefined&&!changes.some(c=>c.id===id&&c.op==='delete')){
  const index=changes.findIndex(c=>c.id===id);if(index>=0)changes.splice(index,1);
  changes.push({id,op:'delete',baseVersion:versions[id]});
 }
 // Folder creation precedes its descendants; removals follow puts.
 const depth=id=>{let n=0,p=current[id]?.parentId;const seen=new Set();while(p&&current[p]&&!seen.has(p)){seen.add(p);n++;p=current[p].parentId;}return n;};
 changes.sort((a,b)=>(a.op==='delete')-(b.op==='delete')||depth(a.id)-depth(b.id));return changes;
}
export function applyAliases(mapping,aliases){for(const [local,id] of Object.entries(mapping))mapping[local]=aliases[id]??id;}
