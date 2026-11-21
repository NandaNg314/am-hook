import zlib from 'node:zlib';

const WIDGET_HTML_MAX_RAW = 32768;
const WIDGET_HTML_MAX_ZLIB = 4096;
const WIDGET_DATA_MAX_BYTES = 1024;

export const MEDIA_CARD_WIDGET_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
body{background:var(--tg-theme-bg-color,#fff);color:var(--tg-theme-text-color,#18181b);padding:12px;font-size:13px;line-height:1.4}
.hd{margin-bottom:10px}
.bdg{display:inline-block;font-size:10px;font-weight:600;padding:2px 6px;border-radius:5px;background:var(--tg-theme-secondary-bg-color,#f4f4f5);color:var(--tg-theme-hint-color,#71717a);margin-bottom:4px}
.tt{font-size:15px;font-weight:700;word-break:break-word}
.ar{font-size:12px;color:var(--tg-theme-hint-color,#71717a);margin-top:2px;word-break:break-word}
.sec{margin-top:9px}
.lbl{font-size:11px;font-weight:600;color:var(--tg-theme-hint-color,#71717a);margin-bottom:4px}
.row{display:flex;flex-wrap:wrap;gap:5px}
.btn{border:1px solid rgba(128,128,128,.22);background:var(--tg-theme-secondary-bg-color,#f4f4f5);color:var(--tg-theme-text-color,#18181b);border-radius:8px;padding:5px 9px;font-size:12px;font-weight:500;cursor:pointer;transition:opacity .15s}
.btn.on{background:var(--tg-theme-button-color,#0071e3);color:var(--tg-theme-button-text-color,#fff);border-color:transparent;font-weight:600}
.btn:disabled{opacity:.5;cursor:default}
.act{display:flex;gap:6px;margin-top:12px}
.go{flex:1;padding:8px 12px;border:none;border-radius:9px;background:var(--tg-theme-button-color,#0071e3);color:var(--tg-theme-button-text-color,#fff);font-size:13px;font-weight:600;cursor:pointer}
.sub-btn{padding:8px 10px;border:1px solid rgba(128,128,128,.22);border-radius:9px;background:transparent;color:var(--tg-theme-hint-color,#71717a);font-size:12px;cursor:pointer}
.prog{margin-top:10px;padding:9px;border-radius:9px;background:var(--tg-theme-secondary-bg-color,#f4f4f5)}
.bar{height:5px;border-radius:3px;background:rgba(128,128,128,.2);overflow:hidden;margin-top:6px}
.fill{height:100%;background:var(--tg-theme-button-color,#0071e3);transition:width .25s ease}
.msg{font-size:12px;word-break:break-word}
.ft{margin-top:8px;display:flex;justify-content:flex-end}
.lnk{background:none;border:none;color:var(--tg-theme-hint-color,#71717a);font-size:11px;cursor:pointer;text-decoration:underline;padding:0}
</style>
</head>
<body>
<div id="app"></div>
<script>
(function(){
var app=document.getElementById('app'),busy=false;
function parse(){try{return JSON.parse(TelegramWidget.chatData||'{}')}catch(e){return{}}}
function send(cmd){if(busy)return;busy=true;render();Promise.resolve(TelegramWidget.request(cmd)).finally(function(){busy=false;render()})}
function esc(s){return String(s||'').replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function render(){
var d=parse(),en=d.l==='en',isAlb=d.k==='a',st=d.st||'idle';
var qs=['Lossless','Hi-Res','Atmos','AAC'];
var qn={'Lossless':'Lossless','Hi-Res':'Hi-Res','Atmos':'Atmos','AAC':'AAC'};
var h='<div class="hd"><span class="bdg">'+(isAlb?(en?'ALBUM':'专辑'):(en?'TRACK':'单曲'))+(d.sub?' · '+esc(d.sub):'')+'</span>';
h+='<div class="tt">'+esc(d.t||'Apple Music')+'</div>';
if(d.a)h+='<div class="ar">'+esc(d.a)+'</div></div>';
if(st==='busy'||st==='done'||st==='err'){
  h+='<div class="prog"><div class="msg">'+esc(d.msg||(en?'Processing...':'处理中...'))+'</div>';
  if(st==='busy'||st==='done'){var pct=Math.max(0,Math.min(100,Number(d.p||0)));h+='<div class="bar"><div class="fill" style="width:'+pct+'%"></div></div>';}
  h+='</div>';
}
if(st!=='busy'){
  h+='<div class="sec"><div class="lbl">'+(en?'Quality':'音质')+'</div><div class="row">';
  for(var i=0;i<qs.length;i++){var q=qs[i];h+='<button class="btn'+(d.q===q?' on':'')+'" data-c="q:'+q+'"'+(busy?' disabled':'')+'>'+qn[q]+'</button>';}
  h+='</div></div>';
  h+='<div class="sec"><div class="lbl">'+(en?'Lyrics & Options':'歌词与选项')+'</div><div class="row">';
  var em=d.e||'lrc';
  var elbl=em==='lrc'?(en?'Embed: LRC':'内嵌: LRC'):(em==='ttml'?(en?'Embed: TTML':'内嵌: TTML'):(en?'Embed: Off':'内嵌: 关'));
  h+='<button class="btn'+(em!=='off'?' on':'')+'" data-c="e:next"'+(busy?' disabled':'')+'>'+elbl+'</button>';
  h+='<button class="btn'+(d.sl?' on':'')+'" data-c="sl"'+(busy?' disabled':'')+'>.lrc</button>';
  h+='<button class="btn'+(d.st_l?' on':'')+'" data-c="st_l"'+(busy?' disabled':'')+'>.ttml</button>';
  h+='<button class="btn'+(d.tr?' on':'')+'" data-c="tr"'+(busy?' disabled':'')+'>'+(en?'CN Trans':'中文翻译')+'</button>';
  if(d.hasR){var rbl=d.rb==='roman'?(en?'Ruby: Romaji':'注音: 罗马音'):(d.rb==='kana'?(en?'Ruby: Kana':'注音: 平假名'):(en?'Ruby: Off':'注音: 关'));h+='<button class="btn'+(d.rb&&d.rb!=='0'?' on':'')+'" data-c="rb"'+(busy?' disabled':'')+'>'+rbl+'</button>';}
  h+='</div></div>';
  if(isAlb){
    h+='<div class="sec"><div class="lbl">'+(en?'Delivery':'交付方式')+'</div><div class="row">';
    h+='<button class="btn'+(d.dm!=='individual'?' on':'')+'" data-c="dm:zip"'+(busy?' disabled':'')+'>'+(en?'ZIP Archive':'打包 ZIP')+'</button>';
    h+='<button class="btn'+(d.dm==='individual'?' on':'')+'" data-c="dm:individual"'+(busy?' disabled':'')+'>'+(en?'Single Tracks':'逐首发送')+'</button>';
    h+='</div></div>';
  }
  h+='<div class="act"><button class="go" data-c="go"'+(busy?' disabled':'')+'>'+(en?'Start Download':'立即下载 / 转存')+'</button>';
  if(isAlb)h+='<button class="sub-btn" data-c="tracks"'+(busy?' disabled':'')+'>'+(en?'Pick Tracks':'选歌')+'</button>';
  h+='</div>';
}
h+='<div class="ft"><button class="lnk" data-c="classic"'+(busy?' disabled':'')+'>'+(en?'Classic Buttons':'切换经典按钮')+'</button></div>';
app.innerHTML=h;
var bs=app.querySelectorAll('[data-c]');
for(var j=0;j<bs.length;j++){bs[j].onclick=function(){send(this.getAttribute('data-c'))};}
}
if(typeof TelegramWidget!=='undefined'&&TelegramWidget.onEvent){
  TelegramWidget.onEvent('chatDataChanged',render);
}
render();
})();
</script>
</body>
</html>`;

export function measureWidgetHtml(html = MEDIA_CARD_WIDGET_HTML) {
  const rawBytes = Buffer.byteLength(html, 'utf8');
  const gzBytes = zlib.deflateSync(html, { level: 9 }).length;
  return {
    rawBytes,
    gzBytes,
    ok: rawBytes <= WIDGET_HTML_MAX_RAW && gzBytes <= WIDGET_HTML_MAX_ZLIB
  };
}

function truncateUtf8(str, maxBytes) {
  if (!str) return '';
  let out = String(str);
  if (Buffer.byteLength(out, 'utf8') <= maxBytes) return out;
  while (out.length > 0 && Buffer.byteLength(`${out}…`, 'utf8') > maxBytes) {
    out = out.slice(0, -1);
  }
  return out ? `${out}…` : '';
}

/**
 * 将媒体卡片状态编码为 <= 1024 字节的 JSON 字符串（符合 Telegram chat_data 硬限制）。
 */
export function encodeWidgetState(state) {
  const payload = {
    k: state.k === 'a' ? 'a' : 's',
    t: truncateUtf8(state.t || '', 160),
    a: truncateUtf8(state.a || '', 100),
    sub: truncateUtf8(state.sub || '', 60),
    l: state.l === 'en' ? 'en' : 'zh',
    q: state.q || 'Lossless',
    e: state.e || 'lrc',
    sl: state.sl ? 1 : 0,
    st_l: state.st_l ? 1 : 0,
    tr: state.tr ? 1 : 0,
    rb: state.rb || '0',
    hasR: state.hasR ? 1 : 0,
    dm: (state.dm === 'individual' || state.dm === 'media') ? 'individual' : 'zip',
    st: state.st || 'idle',
    p: Math.max(0, Math.min(100, Math.round(Number(state.p || 0)))),
    msg: truncateUtf8(state.msg || '', 260)
  };

  let json = JSON.stringify(payload);
  if (Buffer.byteLength(json, 'utf8') <= WIDGET_DATA_MAX_BYTES) return json;

  // 若仍超限则逐步压缩 msg / t / a，确保绝对不超过 1024 bytes
  payload.msg = truncateUtf8(payload.msg, 120);
  payload.t = truncateUtf8(payload.t, 90);
  payload.a = truncateUtf8(payload.a, 60);
  payload.sub = truncateUtf8(payload.sub, 36);
  json = JSON.stringify(payload);
  if (Buffer.byteLength(json, 'utf8') <= WIDGET_DATA_MAX_BYTES) return json;

  payload.msg = truncateUtf8(payload.msg, 48);
  payload.t = truncateUtf8(payload.t, 48);
  return JSON.stringify(payload);
}
