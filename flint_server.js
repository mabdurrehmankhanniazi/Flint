'use strict';
// Flint multiplayer server. Run: npm i ws && node flint-server.js [port]   (Node 18+, default port 8080)
// It owns the seed, the saved block edits (flint-world.json) and the player list. It trusts clients: it validates and rate limits, and runs no world generation, physics or water. It also decides who is in view of whom, and whether a blow lands.
// View: a player is shown another only within its render distance (the radius in chunks it sends: a byte in the hello, again in message 8 when the slider moves). Coming into view sends a join, the skin and the state, going out of it a leave (the client removes the rig); while in view every state, event and skin follows. A player stays in view GRACE blocks past the radius it entered at, so one standing at the edge does not flicker. A player that has not sent a state yet is seen by nobody and sees nobody. Edits go to the sender and to everyone within EDR chunks: a client keeps the edits of the regions up to 96 chunks round it, and asks for a region again (its reply holds every edit) when it comes nearer.
// Blows: the server checks a blow (rate, both players alive and in view, REACH blocks between their feet, ICD ms since the victim was last hit) and tells the victim's client, which takes the damage and the knock back. Health itself lives in the clients, as before.
// Wire format, little endian, binary frames. Client to server:
//  1 hello    u16 WVER, u8 view radius in chunks, name utf8      2 skin   PNG bytes (64 x 64, at most 32 KB)
//  3 state    f64 x, y, z (feet) f32 yaw, pitch u8 flags (1 sneak, 2 swim, 4 air, 8 dead) u16 held block
//  4 edit     i32 cx, cz, packed (block<<17 | y<<8 | z<<4 | x)
//  5 regions  i32 a0, b0, a1, b1 (region coordinates, inclusive)      6 event u8 (1 swing, 2 hurt, 3 break on, 4 break off)
//  7 attack   u16 id of the player hit      8 view   u8 radius in chunks
//  10 face    u8 x 192: the 8 x 8 front of this player's head with its hat on, RGB, for the map icons (kept and sent on to everyone)
// Server to client:
//  1 welcome  i32 seed, u16 WVER, i32 spawn x, z, f32 day phase, u16 your id
//  2 join u16 id, u8 len, name    3 leave u16 id    4 state u16 id + the 35 state bytes    5 edit (as 4; to the sender too)
//  6 regions  i32 a0, b0, a1, b1, then per chunk with edits: i32 cx, cz, u32 n, n x i32     7 event u16 id, u8    8 skin u16 id, PNG
//  9 hit      u8 damage, i8 dx, i8 dz (the direction of the blow x 127): to the player who was hit
//  10 roster  u16 n, then per player that has sent a state: u16 id, f32 x, z, yaw, u8 flags (1 here, 2 dead). EVERY player, in view or not, 5 times a second while anyone moves (the map: nobody has to be within a render distance of another to be on it); the receiver skips its own id
//  11 who     u16 id, u8 len, name, then the 192 face bytes if the player sent them: to everyone, when a player joins (and to it for all the others) and when a face changes
//  12 gone    u16 id: a player left (the map forgets it; 3 leave only means out of view)
// Region requests and edits are handled in the order they arrive, and every reply goes out in that order, which the client relies on.
const {WebSocketServer}=require('ws'),fs=require('fs');
const PORT=+process.argv[2]||8080,FILE='flint-world.json',WVER=1,MAXP=16,MAXSKIN=32768,DAY=1200,DNT=.35; // DAY and DNT: seconds a day and the start phase, the client's defaults
const REACH=6.5,DMG=2,ICD=400,EDR=100,GRACE=16,BIG=2**30; // REACH: blocks between the feet of attacker and victim (the client reaches 4 from the eye, and it sees the other 100 ms late), DMG: points a blow takes (2 = one heart), ICD: ms a player is safe after a blow, EDR: chunks an edit reaches, GRACE: blocks a player stays in view past the view radius, BIG: the farthest a position may be

let seed=Math.random()*4294967296|0;const RG=new Map(); // 'a,b' region -> Map('cx,cz' -> {cx, cz, m: Map(cell -> block)})
const chunk=(cx,cz)=>{const r=(cx>>3)+','+(cz>>3);let R=RG.get(r);if(!R)RG.set(r,R=new Map());const k=cx+','+cz;let c=R.get(k);if(!c)R.set(k,c={cx,cz,m:new Map()});return c};
try{const j=JSON.parse(fs.readFileSync(FILE,'utf8'));seed=j.seed|0;for(const[cx,cz,a]of j.e){const m=chunk(cx,cz).m;for(const p of a)m.set(p&131071,p>>17)}}catch(e){}
const snap=()=>{const e=[];for(const R of RG.values())for(const c of R.values())e.push([c.cx,c.cz,[...c.m].map(([i,v])=>v<<17|i)]);return JSON.stringify({seed,e})};
let timer=0;const touch=()=>{if(!timer)timer=setTimeout(()=>{timer=0;fs.writeFile(FILE+'.tmp',snap(),er=>{if(!er)fs.rename(FILE+'.tmp',FILE,()=>{})})},5e3)};
for(const s of['SIGINT','SIGTERM'])process.on(s,()=>{fs.writeFileSync(FILE,snap());process.exit()});

const wss=new WebSocketServer({port:PORT,maxPayload:MAXSKIN+16}),P=new Map(),I=new Map();let nid=0; // P: socket to player, I: id to player. A player: {w socket, id, name, rad view radius in chunks, x y z and st (the 35 state bytes) from its last state, skin, see ids it shows, hit time of the last blow it took, t rate limits}
const send=(w,b)=>{if(w.readyState==1)w.send(b)};
const rate=(p,k,per,burst)=>{const n=Date.now(),t=p.t[k]||(p.t[k]={v:burst,n});t.v=Math.min(burst,t.v+(n-t.n)*per/1e3);t.n=n;return t.v>=1&&(t.v--,true)}; // token bucket: per second, burst
const ent=q=>{const b=Buffer.from(q.name),e=Buffer.alloc(3+b.length);e.writeUInt16LE(q.id,0);e[2]=b.length;b.copy(e,3);return e};
const tag=(t,id,x)=>Buffer.concat([Buffer.from([t,id&255,id>>8]),x||Buffer.alloc(0)]);
const who=q=>Buffer.concat([Buffer.from([11]),ent(q),q.face||Buffer.alloc(0)]); // the name and face of q, for the map
let rdirty=0; // a state, join or leave since the last roster
// does the client of p show o? It enters view at p's radius and leaves g blocks beyond it (g 0: a hard cut, after the radius changed). Returns 0 not shown, 1 shown, 2 shown just now (the join, the skin and the state went out)
function look(p,o,g=GRACE){if(!p.st||!o.st)return 0;
 const s=p.see.has(o.id),R=p.rad*16+(s?g:0),dx=p.x-o.x,dz=p.z-o.z,v=dx*dx+dz*dz<=R*R;
 if(v==s)return+v;
 if(v){p.see.add(o.id);send(p.w,Buffer.concat([Buffer.from([2]),ent(o)]));if(o.skin)send(p.w,tag(8,o.id,o.skin));send(p.w,tag(4,o.id,o.st));return 2}
 p.see.delete(o.id);send(p.w,tag(3,o.id));return 0}

wss.on('connection',w=>{let p=null;w.on('error',()=>{});w.on('pong',()=>{w.late=0});setTimeout(()=>{if(!p)w.terminate()},1e4); // a socket that never says hello is dropped
 w.on('message',(m,bin)=>{if(!bin||!m.length)return;const k=m[0];
  if(!p){ // the first message must be the hello
   if(k!=1||m.length<4||P.size>=MAXP)return w.close();
   p={w,id:nid=nid%65535+1,name:m.toString('utf8',4,100).slice(0,24)||'Player',rad:Math.max(2,Math.min(60,m[3])),x:0,y:0,z:0,st:0,skin:0,face:0,see:new Set(),hit:0,t:{}};
   const h=Buffer.alloc(21);h[0]=1;h.writeInt32LE(seed,1);h.writeUInt16LE(WVER,5);h.writeInt32LE(8,7);h.writeInt32LE(8,11);h.writeFloatLE((Date.now()/1e3/DAY+DNT)%1,15);h.writeUInt16LE(p.id,19);
   send(w,h);P.set(w,p);I.set(p.id,p); // nobody is told of the new player until its first state says where it is (the map's name and face go out at once, its place with its first state)
   for(const q of P.values())if(q!==p){send(w,who(q));send(q.w,who(p))}rdirty=1;
   return}
  if(k==3&&m.length==36){const x=m.readDoubleLE(1),y=m.readDoubleLE(9),z=m.readDoubleLE(17);
   if(Math.abs(x)<=BIG&&Math.abs(y)<=BIG&&Math.abs(z)<=BIG&&Number.isFinite(m.readFloatLE(25)+m.readFloatLE(29))&&rate(p,'s',25,40)){
    p.x=x;p.y=y;p.z=z;p.st=Buffer.from(m.subarray(1));rdirty=1;const b=tag(4,p.id,p.st); // one buffer for every viewer
    for(const q of P.values())if(q!==p){look(p,q);if(look(q,p)==1)send(q.w,b)}}} // who p now shows, who now shows p, and the state to those that already did (a new viewer got it with the join)
  else if(k==4&&m.length==13&&rate(p,'e',40,80)){const cx=m.readInt32LE(1),cz=m.readInt32LE(5),v=m.readInt32LE(9);
   if(Math.abs(cx)<=2**25&&Math.abs(cz)<=2**25&&v>=0&&v>>17<4096&&(v&131071)<65536){chunk(cx,cz).m.set(v&131071,v>>17);const o=Buffer.from(m);o[0]=5;touch(); // last write wins
    for(const q of P.values())if(q===p||!q.st||Math.abs(q.x/16-cx)<=EDR&&Math.abs(q.z/16-cz)<=EDR)send(q.w,o)}} // the sender always gets its edit back (that orders it against the others'), the rest only when they are near
  else if(k==5&&m.length==17&&rate(p,'r',6,12)){const[a0,b0,a1,b1]=[1,5,9,13].map(i=>m.readInt32LE(i));
   if(a1>=a0&&b1>=b0&&(a1-a0+1)*(b1-b0+1)<=2500){const h=Buffer.from(m);h[0]=6;const o=[h];
    for(let a=a0;a<=a1;a++)for(let b=b0;b<=b1;b++){const R=RG.get(a+','+b);if(R)for(const c of R.values()){const e=Buffer.alloc(12+4*c.m.size);e.writeInt32LE(c.cx,0);e.writeInt32LE(c.cz,4);e.writeUInt32LE(c.m.size,8);let i=12;for(const[cell,v]of c.m){e.writeInt32LE(v<<17|cell,i);i+=4}o.push(e)}}
    send(w,Buffer.concat(o))}}
  else if(k==6&&m.length==2&&m[1]>=1&&m[1]<=4&&rate(p,'v',20,20)){const b=Buffer.from([7,p.id&255,p.id>>8,m[1]]);for(const q of P.values())if(q.see.has(p.id))send(q.w,b)}
  else if(k==7&&m.length==3&&rate(p,'a',2.5,2)){const q=I.get(m.readUInt16LE(1)),n=Date.now(); // a blow: p shows q (so both sent a state), both alive, within reach, q not hit a moment ago
   if(q&&q!==p&&p.see.has(q.id)&&!(p.st[32]&8)&&!(q.st[32]&8)&&n-q.hit>=ICD&&(p.x-q.x)**2+(p.y-q.y)**2+(p.z-q.z)**2<=REACH*REACH){
    q.hit=n;const a=p.st.readFloatLE(24),b=Buffer.alloc(4);b[0]=9;b[1]=DMG;b.writeInt8(Math.round(Math.sin(a)*127),2);b.writeInt8(Math.round(-Math.cos(a)*127),3);send(q.w,b)}} // knocked back along the way the attacker faces (the client's yaw 0 looks toward -z)
  else if(k==8&&m.length==2&&rate(p,'w',5,5)){p.rad=Math.max(2,Math.min(60,m[1]));for(const q of P.values())if(q!==p)look(p,q,0)} // the render distance moved: the new radius cuts at once
  else if(k==10&&m.length==193&&rate(p,'f',.5,3)){p.face=Buffer.from(m.subarray(1));const b=who(p);for(const q of P.values())if(q!==p)send(q.w,b)} // the map icon: kept for those who join later, sent on now
  else if(k==2&&m.length>=70&&m.length<=MAXSKIN+1&&rate(p,'k',.2,2)){const s=m.subarray(1); // a PNG of exactly 64 x 64
   if(s.readUInt32BE(0)==0x89504e47&&s.readUInt32BE(16)==64&&s.readUInt32BE(20)==64){p.skin=Buffer.from(s);const b=tag(8,p.id,p.skin);for(const q of P.values())if(q.see.has(p.id))send(q.w,b)}}});
 w.on('close',()=>{if(p&&P.delete(w)){I.delete(p.id);const b=tag(3,p.id),g=tag(12,p.id);rdirty=1;for(const q of P.values()){if(q.see.delete(p.id))send(q.w,b);send(q.w,g)}}})});
setInterval(()=>{if(!rdirty||P.size<2)return;rdirty=0;const L=[];for(const q of P.values())if(q.st)L.push(q);if(!L.length)return; // the roster: where every player is, one buffer for all (a receiver skips itself)
 const b=Buffer.alloc(3+15*L.length);b[0]=10;b.writeUInt16LE(L.length,1);let i=3;for(const q of L){b.writeUInt16LE(q.id,i);b.writeFloatLE(q.x,i+2);b.writeFloatLE(q.z,i+6);b.writeFloatLE(q.st.readFloatLE(24),i+10);b[i+14]=q.st[32]&8?2:1;i+=15}for(const q of P.values())send(q.w,b)},200);
setInterval(()=>{for(const w of P.keys()){if(w.late)w.terminate();else{w.late=1;w.ping()}}},3e4); // a connection that stops answering is cut (its close event then removes the player from every view)
console.log('Flint server on ws://localhost:'+PORT+' (seed '+seed+', world file '+FILE+')');
