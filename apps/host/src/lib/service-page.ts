export function isServicePage(): boolean {
  return Boolean((globalThis as { __STRATA_HOST__?: string }).__STRATA_HOST__);
}
