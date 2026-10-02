import { SVGPathData } from '../SVGPathData.js';
import { SVGPathDataTransformer } from '../SVGPathDataTransformer.js';
import { bezierAt, type Point } from '../mathUtils.js';
import { REVERSE_PATH } from './reverse_path.js';
import type { SVGCommand } from '../types.js';

const CURVE_STEPS = 8;
const CONTAINMENT_PROBES = 16;

interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * Reorients the subpaths of a path filled with the `evenodd` rule so that the
 * `nonzero` rule fills the same area: each subpath nested in another winds
 * against the subpath enclosing it, and each outermost subpath keeps its
 * direction. This holds when no subpath crosses itself or another; a subpath
 * crossing another counts as nested in it when most of its points lie inside.
 * @param commands SVG path commands of a path filled with the `evenodd` rule
 * @returns The given commands when no subpath needs reversing, otherwise new
 * absolute commands with the curves converted to cubic bezier curves
 */
export function EVENODD_TO_NONZERO(commands: SVGCommand[]): SVGCommand[] {
  const subpaths = splitSubpaths(
    new SVGPathData(commands.map(SVGPathDataTransformer.CLONE()))
      .toAbs()
      .normalizeST()
      .qtToC()
      .aToC().commands,
  );

  if (subpaths.length < 2) return commands;

  const outlines = subpaths.map(flattenSubpath);
  const signedAreas = outlines.map(signedArea);
  const areas = signedAreas.map(Math.abs);
  const ascendingByArea = areas
    .map((_area, index) => index)
    .sort((first, second) => areas[first] - areas[second]);
  const enclosures = findEnclosures(outlines, areas, ascendingByArea);
  const windings: number[] = [];

  for (const index of ascendingByArea.toReversed()) {
    windings[index] =
      -1 === enclosures[index]
        ? Math.sign(signedAreas[index])
        : -windings[enclosures[index]];
  }

  const reversed = signedAreas.map(
    (area, index) => 0 !== area && Math.sign(area) !== windings[index],
  );

  if (!reversed.includes(true)) return commands;

  return subpaths.flatMap((subpath, index) =>
    reversed[index] ? REVERSE_PATH(subpath) : subpath,
  );
}

function splitSubpaths(commands: readonly SVGCommand[]): SVGCommand[][] {
  const subpaths: SVGCommand[][] = [];
  let subpath: SVGCommand[] = [];
  let start: Point = [0, 0];
  let closed = false;

  for (const command of commands) {
    if (command.type === SVGPathData.MOVE_TO) {
      if (subpath.length) subpaths.push(subpath);
      subpath = [command];
      start = [command.x, command.y];
      closed = false;
      continue;
    }
    if (closed) {
      // A command after a closepath starts a subpath at the closed one's start
      subpaths.push(subpath);
      subpath = [
        {
          type: SVGPathData.MOVE_TO,
          relative: false,
          x: start[0],
          y: start[1],
        },
      ];
    }
    subpath.push(command);
    closed = command.type === SVGPathData.CLOSE_PATH;
  }
  if (subpath.length) subpaths.push(subpath);
  return subpaths;
}

function flattenSubpath(subpath: readonly SVGCommand[]): Point[] {
  const points: Point[] = [];
  let x = 0;
  let y = 0;

  for (const command of subpath) {
    if (
      command.type === SVGPathData.MOVE_TO ||
      command.type === SVGPathData.LINE_TO
    ) {
      x = command.x;
      y = command.y;
      points.push([x, y]);
    } else if (command.type === SVGPathData.HORIZ_LINE_TO) {
      x = command.x;
      points.push([x, y]);
    } else if (command.type === SVGPathData.VERT_LINE_TO) {
      y = command.y;
      points.push([x, y]);
    } else if (command.type === SVGPathData.CURVE_TO) {
      for (let step = 1; step <= CURVE_STEPS; step++) {
        const t = step / CURVE_STEPS;

        points.push([
          bezierAt(x, command.x1, command.x2, command.x, t),
          bezierAt(y, command.y1, command.y2, command.y, t),
        ]);
      }
      x = command.x;
      y = command.y;
    }
  }
  return points;
}

function signedArea(outline: readonly Point[]): number {
  let area = 0;

  for (let index = 0; index < outline.length; index++) {
    const [x, y] = outline[index];
    const [nextX, nextY] = outline[(index + 1) % outline.length];

    area += x * nextY - nextX * y;
  }
  return area / 2;
}

function boundsOf(points: readonly Point[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

function overlap(first: Bounds, second: Bounds): boolean {
  return (
    first.minX <= second.maxX &&
    second.minX <= first.maxX &&
    first.minY <= second.maxY &&
    second.minY <= first.maxY
  );
}

function containsPoint(outline: readonly Point[], [x, y]: Point): boolean {
  let inside = false;

  for (
    let index = 0, previous = outline.length - 1;
    index < outline.length;
    previous = index++
  ) {
    const [currentX, currentY] = outline[index];
    const [priorX, priorY] = outline[previous];

    if (
      currentY > y !== priorY > y &&
      x <
        ((priorX - currentX) * (y - currentY)) / (priorY - currentY) + currentX
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function holdsMostOf(
  outline: readonly Point[],
  probes: readonly Point[],
): boolean {
  const inside = probes.filter((probe) => containsPoint(outline, probe));

  return inside.length * 2 > probes.length;
}

function findEnclosures(
  outlines: readonly (readonly Point[])[],
  areas: readonly number[],
  ascendingByArea: readonly number[],
): number[] {
  const bounds = outlines.map(boundsOf);

  return outlines.map((outline, index) => {
    if (0 === areas[index]) return -1;

    const stride = Math.max(1, Math.floor(outline.length / CONTAINMENT_PROBES));
    const probes = outline.filter(
      (_point, pointIndex) => 0 === pointIndex % stride,
    );
    const probeBounds = boundsOf(probes);
    const tightestEnclosure = ascendingByArea.find(
      (candidate) =>
        areas[candidate] > areas[index] &&
        overlap(bounds[candidate], probeBounds) &&
        holdsMostOf(outlines[candidate], probes),
    );

    return tightestEnclosure ?? -1;
  });
}
