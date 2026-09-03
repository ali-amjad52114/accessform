# MapCard

Shows the nearby organizations the caller was offered: the numbered list the
voice agent read aloud, with an OpenStreetMap map beside it.

It renders one `organizations_found` event, exactly as
`lib/discovery/nearby.ts` wrote it. It is a display of what is nearby — it
never says a place is verified, approved, or that it publishes a program. Only
`discover_program` can speak to that.

## Mounting it

```tsx
<MapCard data={event.metadata_json} selectedName={bundle.organization?.name} />
```

- `data` — the `metadata_json` of the case's most recent `organizations_found`
  event, passed straight through (`Record<string, unknown> | null`). The
  component parses it defensively and renders `null` when there are no
  organizations in it, so an unrelated event can be handed to it safely.
- `selectedName` — optional. When it matches an organization's name
  (case-insensitively), that row and its pin are highlighted and labelled
  "Chosen for this case".

Pick the event out of the feed by type, newest first:

```tsx
const event = bundle.events.findLast((e) => e.event_type === 'organizations_found');
```

`organizations_not_found` events carry an empty list and a reason; MapCard
renders nothing for them. Say what happened in the surrounding copy instead.

## What it expects in `data`

```ts
{
  category: NeedCategory,
  location: string,
  organizations: Array<{
    index: number,            // 1-based; the number the caller heard
    name: string,
    address: string,
    latitude: number | null,
    longitude: number | null,
    distance_miles: number | null,
    place_id: string,
    website: string | null,
  }>
}
```

`distance_miles` is a straight-line distance from the FIRST place in the list,
not a travel distance and not measured from the caller — we only ever know
their town or ZIP. The card words it that way ("2.1 miles from number 1, in a
straight line"); do not relabel it as "distance from you".

## Accessibility

- The ordered list is the content; the map is `aria-hidden` decoration. A
  Leaflet canvas of unlabelled tiles tells a screen reader nothing the list
  does not already say.
- Every place's number appears in the visible text of its list item, so a
  caller who heard "number two" can find it by ear or by eye.
- Text is 18px or larger throughout; links get a visible focus ring.
- `prefers-reduced-motion` disables Leaflet's zoom, pan and fade animations,
  and the stylesheet drops transitions inside the card.
- When no place has coordinates, no map is rendered — the list stands alone
  rather than sitting beside an empty grey box.

## Implementation notes

- `leaflet` is imported dynamically inside the effect: its module body touches
  `document`, so a static import breaks server rendering. Only
  `leaflet/dist/leaflet.css` is imported statically.
- No `react-leaflet`. The map is created once per data change and removed in
  the effect's cleanup.
- Pins are `L.divIcon`s carrying the number, styled from the CSS module, so
  Leaflet's default marker images are never fetched.
- Tiles come from `tile.openstreetmap.org` with the required attribution. If
  the page is ever rendered where that host is unreachable, the list is still
  complete on its own.
