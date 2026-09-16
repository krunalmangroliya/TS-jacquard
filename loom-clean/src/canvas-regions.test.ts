import { describe, expect, it } from 'vitest';
import { clipCanvasRegion, regionFocusCamera } from './CanvasEditor';

describe('canvas region navigation', () => {
  it('clips partial bounds to the output grid and rejects empty or invalid regions', () => {
    const image = { width: 100, height: 80 };
    expect(clipCanvasRegion({ x: -5, y: 60, width: 20, height: 40 }, image)).toEqual({ x: 0, y: 60, width: 15, height: 20 });
    expect(clipCanvasRegion({ x: 100, y: 0, width: 10, height: 10 }, image)).toBeNull();
    expect(clipCanvasRegion({ x: 0, y: 0, width: 0, height: 10 }, image)).toBeNull();
    expect(clipCanvasRegion({ x: NaN, y: 0, width: 10, height: 10 }, image)).toBeNull();
  });

  it('centers a region and zooms beyond 2× when its full bounds fit', () => {
    const region = { x: 90, y: 130, width: 60, height: 40 };
    const view = { width: 800, height: 600 };
    const camera = regionFocusCamera(region, view, { width: 768, height: 988 })!;
    expect(camera.scale).toBeGreaterThanOrEqual(2);
    expect(camera.x + (region.x + region.width / 2) * camera.scale).toBeCloseTo(view.width / 2);
    expect(camera.y + (region.y + region.height / 2) * camera.scale).toBeCloseTo(view.height / 2);
    expect(region.width * camera.scale).toBeLessThanOrEqual(view.width - 140);
    expect(region.height * camera.scale).toBeLessThanOrEqual(view.height - 120);
  });

  it('honors cloth proportions and fits a large region instead of cropping it to force 2×', () => {
    const region = { x: 200, y: 180, width: 300, height: 400 };
    const view = { width: 800, height: 600 }, ratio = 96 / 52;
    const camera = regionFocusCamera(region, view, { width: 768, height: 988 }, ratio)!;
    expect(camera.scale).toBeLessThan(2);
    expect(region.height * camera.scale * ratio).toBeCloseTo(view.height - 120);
    expect(camera.y + (region.y + region.height / 2) * camera.scale * ratio).toBeCloseTo(view.height / 2);
    expect(regionFocusCamera(region, { width: 0, height: 0 }, { width: 768, height: 988 }, ratio)).toBeNull();
  });

  it('focuses only valid edge pixels and caps the zoom for a tiny region', () => {
    const camera = regionFocusCamera({ x: 99, y: 79, width: 50, height: 50 }, { width: 800, height: 600 }, { width: 100, height: 80 })!;
    expect(camera.scale).toBe(16);
    expect(camera.x + 99.5 * camera.scale).toBe(400);
    expect(camera.y + 79.5 * camera.scale).toBe(300);
    expect(regionFocusCamera({ x: 100, y: 80, width: 10, height: 10 }, { width: 800, height: 600 }, { width: 100, height: 80 })).toBeNull();
  });
});
