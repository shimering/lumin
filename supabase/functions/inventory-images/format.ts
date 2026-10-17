import {DriveError} from "../google-drive/core.ts";

export const PHOTO_LIMIT = 300 * 1024;
export function photoFormat(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > PHOTO_LIMIT) throw new DriveError("Optimize the image below 300 KB.", 413, "image_size");
  const text = (start: number, end: number) => new TextDecoder().decode(bytes.slice(start, end));
  let width = 0, height = 0, mime = "", extension = "";
  if (bytes.length >= 30 && text(0, 4) === "RIFF" && text(8, 12) === "WEBP" && new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(4,true)+8===bytes.length) {
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let at=12,animated=false;
    for(;at+8<=bytes.length;){
      const kind=text(at,at+4),length=view.getUint32(at+4,true),data=at+8;
      if(data+length>bytes.length)break;
      if(kind==='ANIM'||kind==='ANMF'||kind==='VP8X'&&Boolean(bytes[data]&2))animated=true;
      if(kind==='VP8L'&&length>=5&&bytes[data]===0x2f){const bits=view.getUint32(data+1,true);width=1+(bits&0x3fff);height=1+((bits>>>14)&0x3fff);}
      else if(kind==='VP8 '&&length>=10&&bytes[data+3]===0x9d&&bytes[data+4]===1&&bytes[data+5]===0x2a){width=view.getUint16(data+6,true)&0x3fff;height=view.getUint16(data+8,true)&0x3fff;}
      at=data+length+(length&1);
    }
    if(at!==bytes.length||animated){width=0;height=0;}
    mime = "image/webp"; extension = "webp";
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2)===0xff && bytes.at(-1)===0xd9) {
    for (let at = 2; at + 8 < bytes.length;) {
      if (bytes[at++] !== 0xff) break;
      while (bytes[at] === 0xff) at++;
      const marker = bytes[at++];
      if (marker === 0xda || marker === 0xd9) break;
      const length = (bytes[at] << 8) | bytes[at + 1];
      if (length < 2 || at + length > bytes.length) break;
      if (marker === 0xc0 || marker === 0xc2) { height = (bytes[at + 3] << 8) | bytes[at + 4]; width = (bytes[at + 5] << 8) | bytes[at + 6]; break; }
      at += length;
    }
    mime = "image/jpeg"; extension = "jpg";
  }
  if (!width || !height || width > 1280 || height > 1280) throw new DriveError("Choose a valid optimized JPEG or WebP image.", 400, "image_format");
  return {width, height, mime, extension};
}
