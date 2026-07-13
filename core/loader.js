// Image loading via Sharp. The only place that touches Sharp for *decoding*.
import sharp from "sharp";

const MAX_PIXELS = 25_000_000; // ~25 MP guard against memory blowups

/**
 * Decode an image (path or Buffer) to a raw RGB(A) buffer the detector understands.
 * @returns {Promise<{data:Buffer,width:number,height:number,channels:number}>}
 */
export async function loadImage(input) {
  const pipeline = sharp(input, { limitInputPixels: MAX_PIXELS });
  const meta = await pipeline.metadata();
  if (!meta.width || !meta.height) throw new Error("Could not read image dimensions");
  if (meta.width * meta.height > MAX_PIXELS) {
    throw new Error(`Image too large: ${meta.width}x${meta.height} exceeds ${MAX_PIXELS}px`);
  }
  // Force 3-channel RGB so the detector's pixel offsets are predictable.
  const { data, info } = await pipeline
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}
