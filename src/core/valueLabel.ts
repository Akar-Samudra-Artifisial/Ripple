/**
 * Display form of a value with its unit ("45 days", "$60"). The unit is left out when the value already says it
 * (case-insensitive), so "30 days after the trip ends" with unit "days" is not shown as "… ends days". Pure and
 * dependency-free: shared by the resolvers and the Custom UI bundles.
 */
export function valueLabel(value: string, unit: string | null | undefined): string {
  const u = unit?.trim();
  return u && !value.toLowerCase().includes(u.toLowerCase()) ? `${value} ${u}` : value;
}
