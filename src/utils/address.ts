/** Expand common street-suffix/direction abbreviations (e.g. "St" → "Street") so an
 * address search can retry with the fuller form when the abbreviated one finds nothing. */
export function expandStreetAbbreviations(street: string): string {
  return street
    .replace(/\bN\b/g, "North").replace(/\bS\b/g, "South")
    .replace(/\bE\b/g, "East").replace(/\bW\b/g, "West")
    .replace(/\bSt\.?\b/g, "Street").replace(/\bAve\.?\b/g, "Avenue")
    .replace(/\bBlvd\.?\b/g, "Boulevard").replace(/\bDr\.?\b/g, "Drive")
    .replace(/\bRd\.?\b/g, "Road").replace(/\bLn\.?\b/g, "Lane")
    .replace(/\bCt\.?\b/g, "Court").replace(/\bPl\.?\b/g, "Place")
    .replace(/\bPkwy\.?\b/g, "Parkway").replace(/\bCir\.?\b/g, "Circle");
}
