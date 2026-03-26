/*
 * Verifies segment-overlap logic across all stop combinations.
 * Overlap rule: (new_from < existing_to) AND (new_to > existing_from)
 */

const stops = ['Kigali', 'Muhanga', 'Huye', 'Rusizi'];

const overlaps = (newFrom, newTo, existingFrom, existingTo) => {
  return newFrom < existingTo && newTo > existingFrom;
};

const segments = [];
for (let from = 0; from < stops.length - 1; from += 1) {
  for (let to = from + 1; to < stops.length; to += 1) {
    segments.push({ from, to, label: `${stops[from]} -> ${stops[to]}` });
  }
}

let totalChecks = 0;
let failures = 0;

for (const a of segments) {
  for (const b of segments) {
    totalChecks += 1;
    const actual = overlaps(a.from, a.to, b.from, b.to);

    // Canonical half-open interval intersection check.
    const expected = Math.max(a.from, b.from) < Math.min(a.to, b.to);

    if (actual !== expected) {
      failures += 1;
      console.error('Mismatch:', {
        a: a.label,
        b: b.label,
        actual,
        expected,
      });
    }
  }
}

console.log(`Checked ${totalChecks} combinations.`);
if (failures > 0) {
  console.error(`Found ${failures} overlap mismatches.`);
  process.exit(1);
}

console.log('All segment overlap combinations are valid.');
