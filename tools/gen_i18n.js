// Genererar ui/locales/<lang>.json från ui/locales/_sv-base.json via Google translate-endpoint.
// Återupptagbar: hoppar över redan översatta strängar per språk. Kör: node tools/gen_i18n.js
const fs = require('fs'), path = require('path'), https = require('https');
const BASE = JSON.parse(fs.readFileSync(path.join(__dirname,'..','ui','locales','_sv-base.json'),'utf8'));
const LANGS = process.argv[2] ? process.argv[2].split(',') : [
  'en','no','da','fi','de','es','fr','it','nl','pt','pl','cs','sk','sl','hr','sr','uk','ru','ro','bg',
  'hu','el','tr','ar','he','fa','ur','hi','bn','ta','id','ms','vi','th','zh-CN','zh-TW','ja','ko','sw',
  'af','sq','mk','lt','lv','et','is','ga','cy','ka','hy','az','kk','pt-PT','nb'
];
const LOCDIR = path.join(__dirname,'..','ui','locales');
const sleep = ms => new Promise(r=>setTimeout(r,ms));
function tr(text, tl){ return new Promise((res,rej)=>{
  const u='https://translate.googleapis.com/translate_a/single?client=gtx&sl=sv&tl='+encodeURIComponent(tl)+'&dt=t&q='+encodeURIComponent(text);
  https.get(u,{headers:{'User-Agent':'Mozilla/5.0'}},r=>{
    if(r.statusCode===429){ r.resume(); return rej('429'); }
    let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{ const j=JSON.parse(d); res(j[0].map(x=>x[0]).join('')); }catch(e){ rej('parse'); } });
  }).on('error',e=>rej(e.message||'neterr'));
});}
async function trRetry(text,tl){ let delay=400;
  for(let i=0;i<6;i++){ try{ return await tr(text,tl); }catch(e){ if(e==='429'){ await sleep(delay); delay=Math.min(delay*2,8000);} else { await sleep(300);} } }
  return null; // ger upp → lämna oöversatt (faller tillbaka på svenska i runtime)
}
async function pool(items, n, fn){ let i=0; const workers=Array.from({length:n},async()=>{ while(i<items.length){ const idx=i++; await fn(items[idx],idx);} }); await Promise.all(workers); }
(async()=>{
  for(const lang of LANGS){
    const file=path.join(LOCDIR,lang+'.json');
    let dict={}; try{ dict=JSON.parse(fs.readFileSync(file,'utf8')); }catch{}
    const todo=BASE.filter(s=>!(s in dict));
    if(!todo.length){ console.log(lang,'klar (cache)'); continue; }
    let done=0, save=0;
    await pool(todo, 6, async (s)=>{
      const t=await trRetry(s,lang);
      if(t!=null) dict[s]=t;
      done++; if(++save%25===0){ fs.writeFileSync(file,JSON.stringify(dict)); }
    });
    fs.writeFileSync(file,JSON.stringify(dict));
    console.log(lang,'->',Object.keys(dict).length+'/'+BASE.length);
  }
  console.log('ALLT KLART');
})();
