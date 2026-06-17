// Pure and dependency-free (no `three` import) so it can be unit-tested
// directly in Node without mocking imports the rest of the viewer needs.
export function isClick(downX, downY, upX, upY, threshold = 6) {
  const dx = upX - downX;
  const dy = upY - downY;
  return Math.sqrt(dx * dx + dy * dy) <= threshold;
}
