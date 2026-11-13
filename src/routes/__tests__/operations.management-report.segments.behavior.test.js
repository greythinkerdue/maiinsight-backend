import test from "node:test";
import assert from "node:assert/strict";

// Mirrors the Management Report's Customer Value Segments derivation: the chart is
// built from the shared segmentation snapshot (the same source as the Segments page),
// not from reporting-period transactions.
const CANONICAL_SEGMENT_NAMES = [
  "High-Value Players",
  "Regular Players",
  "Occasional Players",
  "Lapsed Players",
];
const CANONICAL_SEGMENT_ORDER = new Map(
  CANONICAL_SEGMENT_NAMES.map((name, index) => [name, index])
);

const buildSegmentContributionRows = (clusters = []) => {
  const clusterBySegmentName = new Map(
    clusters.map((cluster) => [cluster.segmentName, cluster])
  );
  return [
    ...CANONICAL_SEGMENT_NAMES.map((segmentName) => ({
      segmentName,
      customerCount: clusterBySegmentName.get(segmentName)?.customerCount ?? 0,
    })),
    ...clusters
      .filter((cluster) => !CANONICAL_SEGMENT_ORDER.has(cluster.segmentName))
      .sort((left, right) => left.segmentName.localeCompare(right.segmentName))
      .map((cluster) => ({
        segmentName: cluster.segmentName,
        customerCount: cluster.customerCount,
      })),
  ];
};

test("segment rows mirror the shared segmentation snapshot counts", () => {
  const clusters = [
    { segmentName: "High-Value Players", customerCount: 24 },
    { segmentName: "Regular Players", customerCount: 4 },
    { segmentName: "Occasional Players", customerCount: 957 },
    { segmentName: "Lapsed Players", customerCount: 1347 },
  ];
  const rows = buildSegmentContributionRows(clusters);
  assert.deepEqual(rows, clusters);
});

test("all 4 canonical segments appear even when the snapshot only has some", () => {
  const rows = buildSegmentContributionRows([
    { segmentName: "High-Value Players", customerCount: 24 },
    { segmentName: "Occasional Players", customerCount: 957 },
  ]);
  assert.deepEqual(rows.map((row) => row.segmentName), CANONICAL_SEGMENT_NAMES);
  const routine = rows.find((row) => row.segmentName === "Regular Players");
  const reengagement = rows.find((row) => row.segmentName === "Lapsed Players");
  assert.equal(routine.customerCount, 0);
  assert.equal(reengagement.customerCount, 0);
});

test("all 4 canonical segments appear with 0 customers when no run exists", () => {
  const rows = buildSegmentContributionRows([]);
  assert.equal(rows.length, 4);
  for (const row of rows) assert.equal(row.customerCount, 0);
});

test("non-canonical clusters appear after the canonical segments, alphabetically", () => {
  const rows = buildSegmentContributionRows([
    { segmentName: "High-Value Players", customerCount: 24 },
    { segmentName: "Unsegmented", customerCount: 3 },
    { segmentName: "Occasional Players", customerCount: 957 },
  ]);
  assert.deepEqual(rows.map((row) => row.segmentName), [
    "High-Value Players",
    "Regular Players",
    "Occasional Players",
    "Lapsed Players",
    "Unsegmented",
  ]);
  assert.equal(rows[rows.length - 1].customerCount, 3);
});

test("segment counts sum to the snapshot total customers (source-of-truth check)", () => {
  const clusters = [
    { segmentName: "High-Value Players", customerCount: 24 },
    { segmentName: "Regular Players", customerCount: 4 },
    { segmentName: "Occasional Players", customerCount: 957 },
    { segmentName: "Lapsed Players", customerCount: 1347 },
  ];
  const rows = buildSegmentContributionRows(clusters);
  const sum = rows.reduce((acc, row) => acc + row.customerCount, 0);
  assert.equal(sum, 2332);
});
