import { enabled, ensureImage, image } from './helpers.js';

/** One pull per isolation run, before any file creates a container. */
export default function setup(): void {
  if (enabled) ensureImage(image);
}
