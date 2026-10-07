// Worker side of ArtworkBackdrop: owns the transferred OffscreenCanvas so the
// per-pixel scene work never competes with lyric scrolling on the main thread.
import { BackdropScene } from './backdrop-render.mjs';

let scene=null;
let generation=0;

self.onmessage=async({data})=>{
  switch(data.type){
    case 'init':
      scene=new BackdropScene(data.canvas,()=>new OffscreenCanvas(1,1));
      scene.reducedMotion=data.reducedMotion;
      scene.resize(data.width,data.height);
      break;
    case 'resize': scene.resize(data.width,data.height); break;
    case 'motion': scene.reducedMotion=data.reducedMotion; break;
    case 'running': scene.setRunning(data.running); break;
    case 'clear': ++generation; scene.clear(); break;
    case 'image': {
      const current=++generation;
      let shown=false;
      try {
        const bitmap=await createImageBitmap(data.file);
        if(current===generation){scene.setImage(bitmap);shown=true;}
        else bitmap.close();
      } catch(error) {
        self.postMessage({type:'image',id:data.id,shown:false,error:String(error)});
        return;
      }
      self.postMessage({type:'image',id:data.id,shown});
      break;
    }
  }
};
