import { readFile, writeFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Delaunay } from 'd3-delaunay';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '../data/processed');

// Shanghai bounding box for Voronoi diagram
const BOUNDS = { xmin: 120.8, ymin: 30.7, xmax: 122.2, ymax: 31.9 };

// Clip radius in meters
const CLIP_RADIUS_M = 300;
// Number of sides for circle approximation
const CIRCLE_SIDES = 24;

/**
 * Build a 24-sided polygon approximating a circle of radius_m around (lat, lng).
 * Returns array of [lng, lat] vertices.
 */
function circlePolygon(lat, lng, radius_m = CLIP_RADIUS_M, sides = CIRCLE_SIDES) {
  const vertices = [];
  for (let i = 0; i < sides; i++) {
    const angle = (i * 2 * Math.PI) / sides;
    const dlat = (radius_m / 111320) * Math.cos(angle);
    const dlng = (radius_m / (111320 * Math.cos((lat * Math.PI) / 180))) * Math.sin(angle);
    vertices.push([lng + dlng, lat + dlat]);
  }
  return vertices;
}

/**
 * Sutherland-Hodgman polygon clipping.
 * Clips polygon (array of [x,y]) against convex clipPolygon (array of [x,y]).
 * Returns clipped polygon vertices.
 */
function sutherlandHodgman(polygon, clipPolygon) {
  if (polygon.length === 0) return [];

  let output = polygon.slice();

  const clipLen = clipPolygon.length;
  for (let i = 0; i < clipLen; i++) {
    if (output.length === 0) return [];

    const input = output.slice();
    output = [];

    const edgeStart = clipPolygon[i];
    const edgeEnd = clipPolygon[(i + 1) % clipLen];

    for (let j = 0; j < input.length; j++) {
      const current = input[j];
      const previous = input[(j + input.length - 1) % input.length];

      const currentInside = isInsideEdge(current, edgeStart, edgeEnd);
      const previousInside = isInsideEdge(previous, edgeStart, edgeEnd);

      if (currentInside) {
        if (!previousInside) {
          const inter = lineIntersect(previous, current, edgeStart, edgeEnd);
          if (inter) output.push(inter);
        }
        output.push(current);
      } else if (previousInside) {
        const inter = lineIntersect(previous, current, edgeStart, edgeEnd);
        if (inter) output.push(inter);
      }
    }
  }

  return output;
}

/**
 * Returns true if point p is on the inside (left) of the directed edge from a to b.
 */
function isInsideEdge(p, a, b) {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
}

/**
 * Compute intersection of line segment p1->p2 with line segment p3->p4.
 */
function lineIntersect(p1, p2, p3, p4) {
  const x1 = p1[0], y1 = p1[1];
  const x2 = p2[0], y2 = p2[1];
  const x3 = p3[0], y3 = p3[1];
  const x4 = p4[0], y4 = p4[1];

  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 1e-12) return null;

  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;

  return [
    x1 + t * (x2 - x1),
    y1 + t * (y2 - y1),
  ];
}

/**
 * Round coordinate to 6 decimal places.
 */
function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}

async function main() {
  // Load communities
  const communitiesRaw = JSON.parse(
    await readFile(resolve(DATA_DIR, 'communities.json'), 'utf-8')
  );
  const communities = communitiesRaw.communities;
  const totalCommunities = communities.length;

  // Load existing boundaries
  let boundariesData = { _meta: {}, boundaries: {} };
  try {
    boundariesData = JSON.parse(
      await readFile(resolve(DATA_DIR, 'boundaries.json'), 'utf-8')
    );
  } catch {
    // boundaries.json does not exist yet — start fresh
  }
  const existingBoundaries = boundariesData.boundaries ?? {};

  const alreadyHave = Object.keys(existingBoundaries).length;
  console.log(`Loaded ${totalCommunities} communities, ${alreadyHave} already have boundaries`);

  // Identify unmatched communities
  const unmatched = communities.filter((c) => !existingBoundaries[c.id]);
  console.log(`Computing Voronoi for ${unmatched.length} unmatched communities...`);

  if (unmatched.length === 0) {
    console.log('Nothing to do — all communities already have boundaries.');
    return;
  }

  // De-duplicate coordinates by jittering identical points
  const seen = new Map(); // key -> count
  const allCommunities = communities.map((c) => {
    const key = `${c.lng},${c.lat}`;
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    if (count > 0) {
      // Jitter by 0.0001 degrees per duplicate
      return {
        ...c,
        lng: c.lng + count * 0.0001,
        lat: c.lat + count * 0.0001,
      };
    }
    return c;
  });

  // Build flat [x, y, x, y, ...] array for Delaunay (x=lng, y=lat)
  const points = new Float64Array(allCommunities.length * 2);
  for (let i = 0; i < allCommunities.length; i++) {
    points[i * 2] = allCommunities[i].lng;
    points[i * 2 + 1] = allCommunities[i].lat;
  }

  // Build Voronoi diagram over Shanghai bounding box
  const delaunay = new Delaunay(points);
  const voronoi = delaunay.voronoi([
    BOUNDS.xmin,
    BOUNDS.ymin,
    BOUNDS.xmax,
    BOUNDS.ymax,
  ]);

  // Build index from id -> position in allCommunities
  const idToIndex = new Map();
  for (let i = 0; i < allCommunities.length; i++) {
    idToIndex.set(allCommunities[i].id, i);
  }

  console.log('Clipping cells to 300m radius...');

  const newBoundaries = {};

  for (const community of unmatched) {
    const idx = idToIndex.get(community.id);
    if (idx === undefined) continue;

    const { lat, lng } = allCommunities[idx]; // use (possibly jittered) coords

    // Get Voronoi cell polygon; returns array of [x, y] or null
    let cellPoly = voronoi.cellPolygon(idx);

    // Build 300m circle polygon around community center
    const circle = circlePolygon(lat, lng, CLIP_RADIUS_M, CIRCLE_SIDES);

    let clipped;
    if (cellPoly && cellPoly.length >= 3) {
      // d3-delaunay returns closed polygon (first == last), remove last duplicate
      const poly = cellPoly.slice(0, -1);
      clipped = sutherlandHodgman(poly, circle);
    } else {
      // Degenerate / unbounded cell — use full circle as fallback
      clipped = null;
    }

    // Fallback to circle if clipping yields < 3 points
    if (!clipped || clipped.length < 3) {
      clipped = circle;
    }

    // Round coordinates and close the ring
    const ring = clipped.map(([x, y]) => [round6(x), round6(y)]);
    // Close ring if not already closed
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push([first[0], first[1]]);
    }

    newBoundaries[community.id] = {
      rings: [ring],
      source: 'voronoi',
    };
  }

  // Merge into existing boundaries
  const mergedBoundaries = { ...existingBoundaries, ...newBoundaries };

  const addedCount = Object.keys(newBoundaries).length;
  const totalNow = Object.keys(mergedBoundaries).length;
  const coveragePct = Math.round((totalNow / totalCommunities) * 100);

  console.log(
    `Added ${addedCount} Voronoi boundaries (total coverage: ${coveragePct}%)`
  );

  // Update _meta
  const meta = {
    ...(boundariesData._meta ?? {}),
    total_communities: totalCommunities,
    osm_count: alreadyHave,
    voronoi_count: addedCount,
    total_boundaries: totalNow,
    coverage_pct: coveragePct,
    voronoi_updated_at: new Date().toISOString(),
  };

  const output = {
    _meta: meta,
    boundaries: mergedBoundaries,
  };

  console.log('Writing boundaries.json...');
  await writeFile(
    resolve(DATA_DIR, 'boundaries.json'),
    JSON.stringify(output, null, 2),
    'utf-8'
  );

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
