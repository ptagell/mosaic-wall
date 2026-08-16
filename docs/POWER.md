# iPad power notes

The iPad 5 units can drain faster than they charge — gradual loss through the
day, then shutdown. The levers that actually work are below. Software
"brightness" is **not** one of them: these iPads have LCD panels, where the
backlight burns the same power no matter how dark the pixels are painted, so a
CSS `brightness()` filter (what a web page can do) changes the look, not the
draw. iOS Safari also exposes no Battery API, so the wall cannot monitor or
react to charge levels — schedules are the only automation available.

## 1. Fix the charge rate (biggest win)

An iPad 5 charges over Lightning at **12W maximum (5V × 2.4A)**, and that
current has to be negotiated end-to-end. The wattage of the wall brick beyond
12W is irrelevant. The flat low-profile Lightning adapters currently in use
have been observed passing **~8W** — the adapter, not the brick or cable, is
the throttle, and 8W is close to what the screen-on iPad burns.

**Verify:** same iPad, genuine (or known-good 2.4A) cable plugged straight in,
no adapter. Compare charge wattage via an inline USB meter, or watch
Settings → Battery for the charging-rate difference over an hour.

**Fix:** source flat adapters explicitly rated for 2.4A passthrough, or
re-route so a full cable reaches the port directly.

![A slimline right-angle Lightning adapter on a soldering mat, its red and black
leads spliced to a USB-C tail](images/power-connectors.jpg)

The slimline adapter above is the part under suspicion — soldering a USB-C tail
onto one keeps the cable flush against the frame, but it is also where the
current gets throttled.

## 2. Drop the backlight on a schedule

The backlight is the single largest consumer. On each iPad, create two
Shortcuts **personal automations** (Shortcuts app → Automation → Time of Day,
"Run Immediately"):

- At the wall's sleep time: **Set Brightness → 0%.**
- At wake time: **Set Brightness →** whatever the room needs (50–70%).

This is real backlight control, works under Guided Access, and pairs with the
wall's scheduled sleep scene (which blacks the pixels but cannot touch the
backlight). With the backlight at 0% overnight, even an 8W feed catches up by
morning.

Also worth setting once per iPad: Settings → Display & Brightness →
auto-brightness off (so ambient light doesn't push it back up), and the lowest
daytime brightness the room tolerates.

## 3. If it's still not enough

The tile page itself does continuous GPU/CPU work (Ken Burns, effects layers,
generative art, crossfades). An "eco mode" that disables those during set
hours was considered and deliberately deferred — see the out-of-scope list in
`docs/superpowers/specs/2026-08-09-tap-favourite-design.md`. Revisit if the
adapter fix plus the brightness schedule doesn't hold charge.
