// Artwork backdrop modeled from the live Apple Music Web scene. It draws four
// moving copies of the image, then applies a radial twist, blur, color grade,
// and dark overlay. The browser does all image processing locally.
//
// The scene only touches canvases handed to it, so it runs unchanged inside a
// worker (OffscreenCanvas) or on the main thread as a fallback.
const BLUR_RADIUS=90;
const FRAME_INTERVAL=1000/15;
// Portrait screens size the copies by the long side, so they are magnified by
// height/width against the screen width, only a narrow strip shows and the
// colors seem to drift slower. Rotation is sped up by that ratio raised to
// PORTRAIT_SPEEDUP there (about 1.47x on a 390x844 phone; the full ratio felt
// too fast); landscape keeps the original speed.
const PORTRAIT_SPEEDUP=.5;
const colorChannel=(value,luminance)=>{
  const saturated=luminance+(value-luminance)*2.75;
  const contrasted=.5+(saturated-.5)*1.9;
  return Math.round(Math.max(0,Math.min(1,contrasted*.7))*255);
};

export class BackdropScene {
  /** canvas: the visible output; makeCanvas(): creates an offscreen work surface. */
  constructor(canvas,makeCanvas) {
    this.canvas=canvas;
    this.output=canvas.getContext('2d',{alpha:false});
    this.layers=makeCanvas();
    this.layerContext=this.layers.getContext('2d',{willReadFrequently:true});
    this.twisted=makeCanvas();
    this.twistContext=this.twisted.getContext('2d');
    this.blurred=makeCanvas();
    this.blurContext=this.blurred.getContext('2d',{willReadFrequently:true});
    this.reducedMotion=false;
    this.angles=[0,0,0,0];
    this.running=false;
    this.timer=0;
    this.lastMotion=0;
    this.boxWidth=this.boxHeight=0;
    this.speed=1;
  }

  resize(boxWidth,boxHeight) {
    if(!boxWidth||!boxHeight) return;
    this.boxWidth=boxWidth;
    this.boxHeight=boxHeight;
    this.speed=boxHeight>boxWidth?(boxHeight/boxWidth)**PORTRAIT_SPEEDUP:1;
    // The scene is heavily blurred; a quarter-size buffer keeps its 15 fps
    // motion inexpensive without changing the visible color fields.
    this.scale=Math.max(1,Math.ceil(Math.max(boxWidth,boxHeight)/400));
    const width=Math.max(1,Math.ceil(boxWidth/this.scale));
    const height=Math.max(1,Math.ceil(boxHeight/this.scale));
    for(const surface of [this.canvas,this.blurred]){
      surface.width=width;
      surface.height=height;
    }
    this.sourcePad=Math.ceil(500/this.scale);
    this.blurPad=Math.ceil(BLUR_RADIUS*3/this.scale);
    this.layers.width=width+2*this.sourcePad;
    this.layers.height=height+2*this.sourcePad;
    this.twisted.width=width+2*this.blurPad;
    this.twisted.height=height+2*this.blurPad;
    this.pixels=this.twistContext.createImageData(this.twisted.width,this.twisted.height);
    this.buildTwistMap();
    if(this.current) this.draw(performance.now());
  }

  /** The twist only depends on the surface size, so every pixel's source index is computed once per resize. */
  buildTwistMap() {
    const width=this.twisted.width,height=this.twisted.height;
    const sourceWidth=this.layers.width,sourceHeight=this.layers.height;
    const centerX=this.canvas.width/2,centerY=this.canvas.height/2,radius=900/this.scale;
    const map=new Int32Array(width*height);
    for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
      const dx=x-this.blurPad-centerX,dy=y-this.blurPad-centerY,dist=Math.hypot(dx,dy);
      const angle=dist<radius?-3.25*((radius-dist)/radius)**2:0;
      const cos=Math.cos(angle),sin=Math.sin(angle);
      const sampleX=Math.round(this.sourcePad+centerX+dx*cos-dy*sin);
      const sampleY=Math.round(this.sourcePad+centerY+dx*sin+dy*cos);
      map[y*width+x]=sampleX<0||sampleX>=sourceWidth||sampleY<0||sampleY>=sourceHeight?-1:sampleY*sourceWidth+sampleX;
    }
    this.twistMap=map;
  }

  setImage(bitmap) {
    this.previous?.close();
    this.previous=this.current;
    this.current=bitmap;
    this.fadeStart=performance.now();
    this.lastMotion=this.fadeStart;
    this.draw(this.fadeStart);
    this.schedule();
  }

  clear() {
    this.current?.close();
    this.previous?.close();
    this.current=this.previous=undefined;
    clearTimeout(this.timer);
    this.timer=0;
  }

  /** Runs the motion loop while the lyric view is open and the page is visible; the last frame stays drawn. */
  setRunning(running) {
    if(running===this.running) return;
    this.running=running;
    if(running) this.lastMotion=performance.now();
    clearTimeout(this.timer);
    this.timer=0;
    this.schedule();
  }

  schedule() {
    if(this.running&&this.current&&!this.timer) this.timer=setTimeout(this.tick,FRAME_INTERVAL);
  }

  tick=()=>{
    this.timer=0;
    if(!this.running||!this.current) return;
    const now=performance.now();
    const delta=Math.min(100,now-this.lastMotion)/1000;
    this.lastMotion=now;
    // Reduced motion keeps its slow drift on every screen
    const rate=this.reducedMotion?[.03,.03,.03,.03]:[.09,-.24,-.18,.12].map(value=>value*this.speed);
    this.angles.forEach((angle,index)=>this.angles[index]=angle+rate[index]*delta);
    this.draw(now);
    this.schedule();
  };

  drawSprite(image,x,y,size,angle,alpha) {
    const context=this.layerContext;
    context.save();
    context.globalAlpha=alpha;
    context.translate(x,y);
    context.rotate(angle);
    context.drawImage(image,-size/2,-size/2,size,size);
    context.restore();
  }

  drawImageCopies(image,alpha) {
    if(!image||alpha<=0) return;
    const {width,height}=this.canvas,offset=this.sourcePad;
    const [a,b,c,d]=this.angles;
    const msize = Math.max(width,height);
    // The two small copies orbit by the long side too, matching their size, so
    // they still travel on portrait screens instead of wobbling in place
    const orbit=msize/4;
    this.drawSprite(image,offset+width/2,offset+height/2,msize*1.25,a,alpha);
    this.drawSprite(image,offset+width/2.5,offset+height/2.5,msize*.8,b,alpha);
    this.drawSprite(image,offset+width/2+orbit*Math.cos(c*.75),offset+height/2+orbit*Math.sin(c*.75),msize*.5,-c,alpha);
    this.drawSprite(image,offset+width/2+width*.1+orbit*Math.cos(d*.75),offset+height/2+width*.1+orbit*Math.sin(d*.75),msize*.25,-d,alpha);
  }

  twistPixels() {
    const source=new Uint32Array(this.layerContext.getImageData(0,0,this.layers.width,this.layers.height).data.buffer);
    const target=new Uint32Array(this.pixels.data.buffer),map=this.twistMap;
    for(let i=0;i<map.length;i++){
      const origin=map[i];
      target[i]=origin<0?0:source[origin];
    }
    this.twistContext.putImageData(this.pixels,0,0);
  }

  colorGrade() {
    const {width,height}=this.blurred;
    const context=this.blurContext;
    context.clearRect(0,0,width,height);
    context.filter=`blur(${BLUR_RADIUS/this.scale}px)`;
    context.drawImage(this.twisted,-this.blurPad,-this.blurPad);
    context.filter='none';
    const frame=context.getImageData(0,0,width,height),data=frame.data;
    // Apple's color matrix combines saturation, contrast and brightness before
    // clamping. Separate CSS filters clip after each step and lose vivid colors.
    for(let i=0;i<data.length;i+=4){
      const red=data[i]/255,green=data[i+1]/255,blue=data[i+2]/255;
      const luminance=.2125*red+.7154*green+.0721*blue;
      data[i]=colorChannel(red,luminance);
      data[i+1]=colorChannel(green,luminance);
      data[i+2]=colorChannel(blue,luminance);
    }
    context.putImageData(frame,0,0);
  }

  draw(now) {
    if(!this.current||!this.twistMap) return;
    const fade=Math.min(1,(now-this.fadeStart)/1667);
    this.layerContext.clearRect(0,0,this.layers.width,this.layers.height);
    this.drawImageCopies(this.previous,1-fade);
    this.drawImageCopies(this.current,fade);
    if(fade===1&&this.previous){this.previous.close();this.previous=undefined;}
    this.twistPixels();
    this.colorGrade();
    const context=this.output,{width,height}=this.canvas;
    context.filter='none';
    context.fillStyle='#fff';
    context.fillRect(0,0,width,height);
    context.drawImage(this.blurred,0,0);
    context.fillStyle='rgba(0,0,0,.5)';
    context.fillRect(0,0,width,height);
    context.fillStyle='rgba(255,255,255,.05)';
    context.fillRect(0,0,width,height);
  }
}
